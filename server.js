// ---------------------------------------------------------------
// server.js — the web server. Start it with:  npm start
// Then open http://localhost:3000
//
// It serves the web page (public/) and a small JSON API under /api.
// Security features live in lib/security.js (see SECURITY.md).
// ---------------------------------------------------------------

const fs = require('fs');
const path = require('path');

// Read settings from the .env file next to this file (works from any folder).
const ENV_FILE = process.env.ENV_FILE || path.join(__dirname, '.env');
require('dotenv').config({ path: ENV_FILE, quiet: true });

const express = require('express');
const store = require('./lib/store');
const mailer = require('./lib/mailer');
const security = require('./lib/security');
const { audit } = require('./lib/audit');
const { parseParticipantsCsv, participantsToCsv, attendanceToCsv, EMAIL_RE } = require('./lib/csv');
const { setEnvValues } = require('./lib/envfile');

const PORT = Number(process.env.PORT || 3000);
// Only this computer can open the app by default. Set HOST=0.0.0.0 to allow other devices.
const HOST = process.env.HOST || '127.0.0.1';
const ALLOWED_HOSTS = String(process.env.ALLOWED_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean);

// Limits on input sizes, so nobody can overload the server with huge values.
const LIMITS = { name: 200, email: 254, subject: 300, body: 20000, code: 100, rows: 20000 };

try {
  store.load();
} catch (err) {
  console.error(`\n  Cannot start: ${err.message}\n`);
  process.exit(1);
}

const app = express();
app.disable('x-powered-by'); // don't advertise which server software we use

// ---- Protections that apply to every request ----
app.use(security.securityHeaders);
app.use(security.hostCheck(ALLOWED_HOSTS));

app.use(express.static(path.join(__dirname, 'public')));
// The QR scanner library, served from node_modules so it works without internet.
app.get('/vendor/html5-qrcode.min.js', (req, res) =>
  res.sendFile(require.resolve('html5-qrcode/html5-qrcode.min.js'))
);

// ---- Protections for the API ----
app.use('/api', security.apiRateLimit, security.csrfCheck);
// Only the CSV import may send a big body (up to 10 MB); everything else is limited to 100 KB.
const bigJson = express.json({ limit: '10mb' });
const smallJson = express.json({ limit: '100kb' });
app.use('/api', (req, res, next) => (req.path === '/participants/import' ? bigJson : smallJson)(req, res, next));

// Small helper: send a JSON error with an HTTP status.
const fail = (res, status, message) => res.status(status).json({ error: message });
// Express 4 doesn't catch errors in async routes by itself; this passes them to the error handler.
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
// Read a text field from the request body, trimmed and limited in length.
const field = (body, key) => String((body && body[key]) ?? '').trim();

// ---------------- Settings & stats ----------------

app.get('/api/config', (req, res) => {
  res.json({
    eventName: process.env.EVENT_NAME || 'Event Check-in',
    emailConfigured: mailer.isConfigured(),
    missingEmailSettings: mailer.missingSettings(),
    gmailUser: process.env.GMAIL_USER || null,
    fromName: process.env.FROM_NAME || '',
    canEditEmailSettings: isLocal(req),
  });
});

/** Is this request coming from this same computer? */
function isLocal(req) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
}

app.get('/api/stats', (req, res) => res.json(store.stats()));

// ---------------- Function 1: Participants & CSV import ----------------

app.get('/api/participants', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 200);
  let list = store.all();
  if (q) {
    list = list.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.email.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q)
    );
  }
  res.json(list.map(store.view));
});

app.post('/api/participants/import', (req, res) => {
  const csvText = req.body && req.body.csv;
  if (!csvText || typeof csvText !== 'string') return fail(res, 400, 'No CSV content received.');

  let parsed;
  try {
    parsed = parseParticipantsCsv(csvText, { maxRows: LIMITS.rows, maxName: LIMITS.name, maxEmail: LIMITS.email });
  } catch (err) {
    return fail(res, 400, err.message);
  }

  let added = 0;
  const skipped = [...parsed.errors];
  parsed.rows.forEach((row) => {
    // Same email already in the list (from a previous import or earlier in this file)? Skip it.
    if (store.findByEmail(row.email)) {
      skipped.push({ row: null, reason: `Duplicate email ${row.email}` });
      return;
    }
    store.add(row);
    added++;
  });
  store.save();
  audit(req, 'import_csv', { added, skipped: skipped.length });

  res.json({ added, skipped, total: store.all().length });
});

// Add one person by hand (e.g. a walk-in at the door).
app.post('/api/participants', (req, res) => {
  const name = field(req.body, 'name');
  const email = field(req.body, 'email');
  if (!name) return fail(res, 400, 'Name is required.');
  if (name.length > LIMITS.name) return fail(res, 400, `Name is too long (max ${LIMITS.name} characters).`);
  if (email.length > LIMITS.email || !EMAIL_RE.test(email)) return fail(res, 400, 'Please enter a valid email address.');
  if (store.findByEmail(email)) return fail(res, 409, `${email} is already in the list.`);
  const p = store.add({ name, email });
  store.save();
  audit(req, 'add_participant', { id: p.id });
  res.status(201).json(store.view(p));
});

// Deleting everything needs "DELETE" typed in the confirm box, not just a click.
app.delete('/api/participants', (req, res) => {
  if (field(req.body, 'confirm') !== 'DELETE') return fail(res, 400, 'Type DELETE to confirm.');
  if (mailer.job.running) return fail(res, 409, 'Emails are being sent right now. Wait or stop the send first.');
  const count = store.all().length;
  store.removeAll();
  audit(req, 'delete_all', { count });
  res.json({ ok: true });
});

// Delete one participant (their QR code stops working).
app.delete('/api/participants/:id', (req, res) => {
  if (mailer.job.running) return fail(res, 409, 'Emails are being sent right now. Wait or stop the send first.');
  const p = store.remove(req.params.id);
  if (!p) return fail(res, 404, 'Participant not found.');
  audit(req, 'delete_participant', { id: p.id });
  res.json({ ok: true, id: p.id, name: p.name });
});

// A participant's QR code as a PNG image (open it, print it, or show it on a phone).
app.get('/api/participants/:id/qr.png', wrap(async (req, res) => {
  const p = store.findById(req.params.id);
  if (!p) return fail(res, 404, 'Participant not found.');
  res.type('png').send(await mailer.qrPng(p));
}));

// ---------------- Function 2: Check-in ----------------

// Scanning the same person again within this time counts as the same check-in
// (cameras often read a code twice). After that, every scan is a new check-in.
const COOLDOWN_MS = Number(process.env.CHECKIN_COOLDOWN_SECONDS ?? 60) * 1000;

// Body: { code: "<text read from the QR code>" }
// Result status is one of: "checked_in", "already_checked_in" (scanned moments ago), "not_found".
app.post('/api/checkin', (req, res) => {
  const code = field(req.body, 'code');
  if (!code) return fail(res, 400, 'No code received.');
  if (code.length > LIMITS.code) return res.status(404).json({ status: 'not_found', code: code.slice(0, 40) + '…' });

  const p = store.findById(code);
  if (!p) return res.status(404).json({ status: 'not_found', code });

  const last = p.checkins[p.checkins.length - 1];
  const ago = last ? Date.now() - new Date(last).getTime() : Infinity;
  if (ago < COOLDOWN_MS) {
    return res.json({ status: 'already_checked_in', participant: store.view(p), secondsAgo: Math.round(ago / 1000), cooldownSeconds: COOLDOWN_MS / 1000 });
  }
  p.checkins.push(new Date().toISOString());
  store.save();
  const v = store.view(p);
  res.json({ status: 'checked_in', participant: v, numberToday: v.checkins_today });
});

// Remove one check-in (scanned by mistake). Body: { at: "<time of that check-in>" }. Without `at`, removes the latest.
function removeCheckin(req, res) {
  const p = store.findById(req.params.id);
  if (!p) return fail(res, 404, 'Participant not found.');
  const at = field(req.body, 'at');
  const i = at ? p.checkins.indexOf(at) : p.checkins.length - 1;
  if (i < 0) return fail(res, 404, 'That check-in was not found.');
  p.checkins.splice(i, 1);
  store.save();
  audit(req, 'undo_checkin', { id: p.id });
  res.json(store.view(p));
}
app.post('/api/participants/:id/undo-checkin', removeCheckin);
app.delete('/api/participants/:id/checkins', removeCheckin);

// ---------------- Function 3: Exports ----------------

function sendCsv(res, filename, text) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(text);
}

const today = () => new Date().toISOString().slice(0, 10);

app.get('/api/export/all.csv', (req, res) => {
  audit(req, 'export_all', { count: store.all().length });
  sendCsv(res, `participants-all-${today()}.csv`, participantsToCsv(store.all().map(store.view), store.dayKey));
});

// Every check-in (one row per scan), in time order.
function sendAttendance(req, res) {
  audit(req, 'export_attendance');
  sendCsv(res, `attendance-log-${today()}.csv`, attendanceToCsv(store.all(), store.dayKey));
}
app.get('/api/export/attendance.csv', sendAttendance);

// Only people who have checked in at least once (same columns as "all participants").
function sendPresent(req, res) {
  const list = store.all().filter((p) => p.checkins.length).map(store.view);
  audit(req, 'export_present', { count: list.length });
  sendCsv(res, `participants-present-${today()}.csv`, participantsToCsv(list, store.dayKey));
}
app.get('/api/export/present.csv', sendPresent);
app.get('/api/export/checked-in.csv', sendPresent); // old address

// ---------------- Function 4: Email QR codes ----------------

// Connect Gmail from the web page: check the login with Google, then save it to .env.
// Only allowed from this computer, so nobody else on the network can change it.
app.post('/api/email/settings', wrap(async (req, res) => {
  if (!isLocal(req)) return fail(res, 403, 'Gmail can only be connected from the laptop running the app.');
  if (mailer.job.running) return fail(res, 409, 'Wait for the current send to finish first.');
  const user = field(req.body, 'gmailUser');
  const pass = field(req.body, 'appPassword').replace(/\s+/g, '');
  const fromName = field(req.body, 'fromName').slice(0, 100);
  if (!EMAIL_RE.test(user) || user.length > LIMITS.email) return fail(res, 400, 'Please enter your Gmail address.');
  if (!/^[a-zA-Z]{16}$/.test(pass)) {
    return fail(res, 400, 'An App Password is 16 letters (like "abcd efgh ijkl mnop"). Your normal Gmail password will not work.');
  }
  try {
    await mailer.verifyCredentials(user, pass); // logs in to Gmail once; sends nothing
  } catch (e) {
    audit(req, 'gmail_connect_failed');
    return fail(res, 400, e.message);
  }
  setEnvValues(ENV_FILE, { GMAIL_USER: user, GMAIL_APP_PASSWORD: pass, FROM_NAME: fromName });
  Object.assign(process.env, { GMAIL_USER: user, GMAIL_APP_PASSWORD: pass, FROM_NAME: fromName });
  mailer.resetTransporter();
  audit(req, 'gmail_connected', { user });
  res.json({ ok: true, gmailUser: user, fromName });
}));

/**
 * Read a Cc or Bcc list (array or "a@x.com, b@y.com"). Returns { list } or { error }.
 */
function addressList(value, label) {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[,;\s]+/);
  const list = [...new Set(raw.map((a) => String(a).trim().toLowerCase()).filter(Boolean))];
  if (list.length > 10) return { error: `${label}: at most 10 addresses.` };
  const bad = list.find((a) => a.length > LIMITS.email || !EMAIL_RE.test(a));
  if (bad) return { error: `${label}: "${bad.slice(0, 80)}" is not a valid email address.` };
  return { list };
}

/**
 * People taken out of this send, and people whose email was edited just for them.
 * exclude: ["ID", ...]   overrides: { "ID": { subject, body } }
 */
function readPersonal(body) {
  const exclude = Array.isArray(body.exclude) ? body.exclude.map((x) => String(x).toUpperCase()).slice(0, LIMITS.rows) : [];
  const overrides = {};
  const raw = body.overrides && typeof body.overrides === 'object' && !Array.isArray(body.overrides) ? body.overrides : {};
  for (const [id, o] of Object.entries(raw).slice(0, 500)) {
    const p = store.findById(id);
    if (!p || !o || typeof o !== 'object') continue;
    const err = checkDraft(o);
    if (err) return { error: `Edited email for ${p.name}: ${err}` };
    overrides[p.id] = { subject: field(o, 'subject'), body: field(o, 'body') };
  }
  return { exclude: new Set(exclude), overrides };
}

/** Check subject, body, Cc and Bcc. Returns { error } or { subject, body, cc, bcc, exclude, overrides }. */
function readDraft(body) {
  const err = checkDraft(body);
  if (err) return { error: err };
  const cc = addressList(body.cc, 'Cc');
  if (cc.error) return cc;
  const bcc = addressList(body.bcc, 'Bcc');
  if (bcc.error) return bcc;
  const personal = readPersonal(body);
  if (personal.error) return personal;
  return { subject: field(body, 'subject'), body: field(body, 'body'), cc: cc.list, bcc: bcc.list, ...personal };
}

/** Who would receive the email: optionally only those not sent yet, minus anyone removed from this send. */
function recipients(onlyUnsent, exclude = new Set()) {
  return store.all().filter((p) => !(onlyUnsent === true && p.qr_sent) && !exclude.has(p.id));
}

/** The subject and text for one person (their own edited version, or the main one). */
const textFor = (draft, p) => draft.overrides[p.id] || draft;

/** Check subject/body are filled in and not too long. Returns an error message or null. */
function checkDraft(body) {
  const subject = field(body, 'subject');
  const text = field(body, 'body');
  if (!subject) return 'Please write an email subject.';
  if (!text) return 'Please write the email text.';
  if (subject.length > LIMITS.subject) return `Subject is too long (max ${LIMITS.subject} characters).`;
  if (text.length > LIMITS.body) return `Message is too long (max ${LIMITS.body} characters).`;
  return null;
}

// Body: { subject, body, onlyUnsent, index } → the exact email for participant #index.
app.post('/api/email/preview', wrap(async (req, res) => {
  const draft = readDraft(req.body);
  if (draft.error) return fail(res, 400, draft.error);
  const list = recipients(req.body.onlyUnsent, draft.exclude);
  if (list.length === 0) {
    return fail(res, 400, draft.exclude.size ? 'Everyone was removed from this send.' : req.body.onlyUnsent ? 'Everyone has already received their QR code.' : 'No participants yet. Import a CSV first.');
  }
  const index = Math.min(Math.max(Number(req.body.index) || 0, 0), list.length - 1);
  const p = list[index];
  const t = textFor(draft, p);
  const email = await mailer.buildEmail(p, t.subject, t.body, draft);
  res.json({
    index,
    total: list.length,
    participant: { id: p.id, name: p.name, email: p.email, qr_sent: p.qr_sent },
    to: `${email.to.name} <${email.to.address}>`,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: email.subject,
    edited: Boolean(draft.overrides[p.id]),
    html: email.previewHtml,
  });
}));

// Send the email for participant #index to my own Gmail address.
app.post('/api/email/test', wrap(async (req, res) => {
  if (!mailer.isConfigured()) return fail(res, 400, 'Connect Gmail first.');
  const draft = readDraft(req.body);
  if (draft.error) return fail(res, 400, draft.error);
  const list = recipients(req.body.onlyUnsent, draft.exclude);
  const p = list[Math.min(Math.max(Number(req.body.index) || 0, 0), list.length - 1)];
  if (!p) return fail(res, 400, 'No participants to use for the test. Import a CSV first.');
  try {
    const t = textFor(draft, p);
    const email = await mailer.buildEmail(p, t.subject, t.body);
    email.subject = `[TEST] ${email.subject}`;
    await mailer.send(email, process.env.GMAIL_USER);
    audit(req, 'email_test');
    res.json({ ok: true, sentTo: process.env.GMAIL_USER, usingParticipant: p.name });
  } catch (e) {
    fail(res, 502, e.message);
  }
}));

// Start sending to everyone (or only those not sent yet) in the background.
app.post('/api/email/send', (req, res) => {
  if (!mailer.isConfigured()) return fail(res, 400, 'Connect Gmail first.');
  const draft = readDraft(req.body);
  if (draft.error) return fail(res, 400, draft.error);
  if (mailer.job.running) return fail(res, 409, 'A send is already in progress.');
  const list = recipients(req.body.onlyUnsent, draft.exclude);
  if (list.length === 0) return fail(res, 400, 'Nobody to send to.');
  const onlyUnsent = req.body.onlyUnsent === true;
  mailer.startJob(list, draft.subject, draft.body, store, { cc: draft.cc, bcc: draft.bcc, onlyUnsent, overrides: draft.overrides });
  audit(req, 'email_send_all', { total: list.length, onlyUnsent, cc: draft.cc.length, bcc: draft.bcc.length });
  res.json({ started: true, total: list.length });
});

app.get('/api/email/status', (req, res) => res.json(mailer.job));

app.post('/api/email/stop', (req, res) => {
  if (mailer.job.running) mailer.job.stopRequested = true;
  audit(req, 'email_stop');
  res.json(mailer.job);
});

// Unknown API address → JSON 404.
app.use('/api', (req, res) => fail(res, 404, 'Not found.'));

// Any unexpected error → a short message. Details go to the terminal only, never to the browser.
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return fail(res, 413, 'That file is too large (max 10 MB).');
  if (err.type === 'entity.parse.failed') return fail(res, 400, 'The request was not valid JSON.');
  console.error(err);
  fail(res, 500, 'Something went wrong on the server. Check the terminal for details.');
});

// ---------------- Start the server ----------------

function start() {
  const tlsCert = process.env.TLS_CERT_FILE;
  const tlsKey = process.env.TLS_KEY_FILE;
  let server;
  let proto = 'http';
  if (tlsCert && tlsKey) {
    // HTTPS: needed if phones/other laptops connect over Wi-Fi (see SECURITY.md).
    server = require('https').createServer({ cert: fs.readFileSync(tlsCert), key: fs.readFileSync(tlsKey) }, app);
    proto = 'https';
  } else {
    server = require('http').createServer(app);
  }

  server.listen(PORT, HOST, () => {
    const shown = HOST === '127.0.0.1' || HOST === '0.0.0.0' ? 'localhost' : HOST;
    console.log(`\n  Event check-in is running →  ${proto}://${shown}:${PORT}\n`);
    console.log(`  Data file: ${store.DATA_FILE}`);
    if (!mailer.isConfigured()) {
      console.log(`  Email: not set up (missing ${mailer.missingSettings().join(', ')} in .env). Everything else works.`);
    } else {
      console.log(`  Email: sending as ${process.env.GMAIL_USER}`);
    }
    if (HOST === '127.0.0.1' || HOST === 'localhost') {
      console.log('  Access: this computer only (set HOST=0.0.0.0 in .env to allow other devices).\n');
    } else {
      console.log(`  Access: other devices on the network can connect (HOST=${HOST}).`);
      console.log('  ⚠  There is no login, so ANYONE on this network can open the app and see all participants.');
      if (proto === 'http') console.log('  ⚠  Not using HTTPS: data travels unencrypted over Wi-Fi. See SECURITY.md.');
      console.log('');
    }
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  Port ${PORT} is already in use. Close the other program or set PORT=3001 in .env.\n`);
    } else {
      console.error(err);
    }
    process.exit(1);
  });
}

// Only start listening when run directly (tests import `app` without starting it).
if (require.main === module) start();

module.exports = app;
