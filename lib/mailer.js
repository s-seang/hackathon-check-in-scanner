// ---------------------------------------------------------------
// mailer.js — builds the QR email for each participant and sends
// them through Gmail, one by one, in the background.
// ---------------------------------------------------------------

const nodemailer = require('nodemailer');
const QRCode = require('qrcode');

// Pause between emails so Gmail doesn't think we're spamming.
const SEND_DELAY_MS = Number(process.env.SEND_DELAY_MS ?? 1500);

/** Which .env settings are missing for Gmail (empty array = ready to send). */
function missingSettings() {
  const missing = [];
  if (!process.env.GMAIL_USER) missing.push('GMAIL_USER');
  if (!process.env.GMAIL_APP_PASSWORD) missing.push('GMAIL_APP_PASSWORD');
  return missing;
}

function isConfigured() {
  return missingSettings().length === 0;
}

function makeTransport(user, pass) {
  return nodemailer.createTransport({
    service: 'gmail', // smtp.gmail.com, port 465, encrypted
    // Google shows app passwords with spaces ("abcd efgh ..."); remove them.
    auth: { user, pass: String(pass).replace(/\s+/g, '') },
  });
}

let transporter = null;
function getTransporter() {
  if (!transporter) transporter = makeTransport(process.env.GMAIL_USER, process.env.GMAIL_APP_PASSWORD);
  return transporter;
}

/** Forget the current Gmail connection (after the settings change). */
function resetTransporter() {
  transporter = null;
}

/**
 * Log in to Gmail once to check the address + app password work. Sends nothing.
 * Throws a friendly Error if Gmail says no.
 */
async function verifyCredentials(user, pass) {
  const t = makeTransport(user, pass);
  try {
    await t.verify();
  } catch (err) {
    throw new Error(friendlyError(err));
  } finally {
    t.close();
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Replace {{name}}, {{email}}, {{id}} and any extra CSV column like {{organization}}. */
function fillPlaceholders(text, p) {
  return String(text || '').replace(/\{\{\s*([\w ]+?)\s*\}\}/g, (match, key) => {
    const k = key.toLowerCase();
    if (k === 'name') return p.name;
    if (k === 'email') return p.email;
    if (k === 'id') return p.id;
    const extraKey = Object.keys(p.extra || {}).find((x) => x.toLowerCase() === k);
    return extraKey ? p.extra[extraKey] : match; // unknown placeholder: leave it as-is
  });
}

/** The QR code image (PNG) for a participant. It contains just their ID. */
function qrPng(p) {
  return QRCode.toBuffer(p.id, { width: 480, margin: 2, errorCorrectionLevel: 'M' });
}

/**
 * Build the full email for one participant.
 * `imgSrc` is "cid:..." for real emails, or a data: URL for the on-screen preview.
 */
function buildHtml(p, body, imgSrc) {
  const bodyHtml = escapeHtml(fillPlaceholders(body, p)).replace(/\r?\n/g, '<br>');
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1d1d1f">
  <div>${bodyHtml}</div>
  <div style="margin-top:24px;text-align:center">
    <img src="${imgSrc}" alt="Your QR code" width="240" height="240" style="display:inline-block;border:1px solid #e5e5ea;border-radius:12px">
    <div style="margin-top:8px;font-size:12px;color:#86868b">Show this QR code at check-in · ID ${escapeHtml(p.id)}</div>
  </div>
</div>`;
}

// Email headers (To, From, Subject) must be one line. Removing line breaks stops
// "header injection", where a crafted name could add hidden recipients.
const oneLine = (s) => String(s).replace(/[\r\n\t]+/g, ' ').trim();

/**
 * Everything needed to send (or preview) one participant's email.
 * `cc` / `bcc` are lists of addresses copied on every email (optional).
 */
async function buildEmail(p, subject, body, { cc = [], bcc = [] } = {}) {
  const png = await qrPng(p);
  const cid = `qr-${p.id}@event`;
  return {
    // An object (not a hand-built string) lets nodemailer encode the name safely.
    to: { name: oneLine(p.name), address: p.email },
    cc,
    bcc,
    subject: oneLine(fillPlaceholders(subject, p)),
    text: `${fillPlaceholders(body, p)}\n\nYour check-in ID: ${p.id} (QR code attached)`,
    html: buildHtml(p, body, `cid:${cid}`),
    previewHtml: buildHtml(p, body, `data:image/png;base64,${png.toString('base64')}`),
    attachments: [
      // 1) inline image shown inside the email body
      { filename: 'qr-code.png', content: png, contentType: 'image/png', cid },
      // 2) the same image as a normal attachment the person can download
      { filename: `qr-code-${p.id}.png`, content: png, contentType: 'image/png' },
    ],
  };
}

/**
 * Send one email. Throws a friendly Error on failure.
 * `toOverride` is used by "Send test to myself": it then goes ONLY to that address (no Cc/Bcc).
 */
async function send(email, toOverride) {
  const from = { name: oneLine(process.env.FROM_NAME || ''), address: process.env.GMAIL_USER };
  let info;
  try {
    info = await getTransporter().sendMail({
      from,
      to: toOverride || email.to,
      cc: toOverride || !email.cc.length ? undefined : email.cc,
      bcc: toOverride || !email.bcc.length ? undefined : email.bcc,
      subject: email.subject,
      text: email.text,
      html: email.html,
      attachments: email.attachments,
    });
  } catch (err) {
    const e = new Error(friendlyError(err));
    e.code = err.code;
    throw e;
  }
  // With Cc/Bcc, the mail server can accept the email for the copies but refuse the
  // participant's own address. That must count as a failure for this participant.
  const mainAddress = String(toOverride || email.to.address).toLowerCase();
  const rejected = ((info && info.rejected) || []).map((a) => String(a.address || a).toLowerCase());
  if (rejected.includes(mainAddress)) {
    const why = (info.rejectedErrors || []).map((x) => x.response).find(Boolean);
    throw new Error(`The address ${mainAddress} was refused${why ? `: ${why}` : '.'}`);
  }
}

function friendlyError(err) {
  if (err.code === 'EAUTH') {
    return 'Gmail rejected the login. Check the Gmail address and make sure you used an App Password (16 letters), not your normal Gmail password.';
  }
  if (['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS'].includes(err.code)) {
    return `Could not reach Gmail (${err.code}). Check the internet connection.`;
  }
  return err.response || err.message || String(err);
}

// ---------------------------------------------------------------
// Background sending job. Only one job runs at a time.
// The browser asks for `job` every second to update the progress bar.
// ---------------------------------------------------------------
const job = {
  running: false,
  stopRequested: false,
  total: 0,
  sent: 0,
  failed: 0,
  failures: [], // [{ id, name, email, error }]
  current: null, // email address being sent right now
  startedAt: null,
  finishedAt: null,
  abortReason: null, // set if the whole job had to stop (e.g. bad Gmail password)
  subject: '',
  cc: [],
  bcc: [],
  onlyUnsent: false,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Start sending to `list` in the background. Returns immediately.
 * `store` is passed in so we can save qr_sent after each email.
 */
function startJob(list, subject, body, store, { cc = [], bcc = [], onlyUnsent = false } = {}) {
  if (job.running) throw new Error('A send is already in progress.');
  Object.assign(job, {
    running: true,
    stopRequested: false,
    total: list.length,
    sent: 0,
    failed: 0,
    failures: [],
    current: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    abortReason: null,
    subject,
    cc,
    bcc,
    onlyUnsent,
  });

  (async () => {
    for (let i = 0; i < list.length; i++) {
      if (job.stopRequested) {
        job.abortReason = 'Stopped by you. Participants not reached yet are still marked as not sent.';
        break;
      }
      const p = list[i];
      job.current = p.email;
      try {
        const email = await buildEmail(p, subject, body, { cc, bcc });
        await send(email);
        p.qr_sent = true;
        p.qr_sent_at = new Date().toISOString();
        p.qr_error = null;
        job.sent++;
      } catch (err) {
        p.qr_error = err.message;
        job.failed++;
        job.failures.push({ id: p.id, name: p.name, email: p.email, error: err.message });
        // A login error will fail for everyone — stop instead of failing 150 times.
        if (err.code === 'EAUTH') {
          job.abortReason = err.message;
          store.save();
          break;
        }
      }
      store.save(); // save qr_sent after every email so a crash doesn't lose progress
      if (i < list.length - 1) await sleep(SEND_DELAY_MS);
    }
    job.running = false;
    job.current = null;
    job.finishedAt = new Date().toISOString();
  })().catch((err) => {
    // Should never happen, but don't leave the job stuck as "running".
    console.error('Send job crashed:', err);
    job.running = false;
    job.abortReason = `Unexpected error: ${err.message}`;
    job.finishedAt = new Date().toISOString();
  });
}

module.exports = {
  missingSettings,
  isConfigured,
  buildEmail,
  send,
  startJob,
  job,
  verifyCredentials,
  resetTransporter,
  qrPng,
  fillPlaceholders,
  // Only used by the automated tests, to swap Gmail for a fake mail sender.
  _setTransporter: (t) => (transporter = t),
};
