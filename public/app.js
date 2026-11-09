// ===============================================================
// app.js — everything that runs in the browser.
// Sections: helpers · navigation · live stats · scanner ·
//           participants · CSV import · email · start-up
// ===============================================================

// ---------------- Helpers ----------------

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Call our server's API. Throws an Error with the server's message if something went wrong. */
async function api(path, options = {}) {
  const opts = { ...options, headers: { 'Content-Type': 'application/json' } };
  if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new Error('Cannot reach the server. Is it still running (npm start)?');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data.status) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  const t = $('#toast');
  t.textContent = message;
  t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), isError ? 5000 : 2800);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const fmtHour = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) : '');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/**
 * Show the confirm dialog. Resolves true if the user confirms.
 * `html` is trusted markup we build ourselves (values inside are escaped).
 * If `requireText` is given, the user must type it exactly to enable the button.
 */
function confirmDialog({ title, html = '', okText = 'Confirm', danger = false, requireText = null }) {
  const dlg = $('#confirm');
  const input = $('#confirm-input');
  const ok = $('#confirm-ok');
  $('#confirm-title').textContent = title;
  $('#confirm-text').innerHTML = html;
  ok.textContent = okText;
  ok.className = 'btn' + (danger ? ' btn-danger' : '');
  input.value = '';
  input.classList.toggle('hidden', !requireText);
  input.placeholder = requireText ? `Type ${requireText}` : '';
  ok.disabled = Boolean(requireText);
  input.oninput = () => (ok.disabled = input.value !== requireText);
  // Enter in the box = Confirm (otherwise the browser would press the first button, Cancel).
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (!ok.disabled) dlg.close('ok'); }
  };
  dlg.returnValue = '';
  dlg.showModal();
  if (requireText) input.focus();
  return new Promise((resolve) => {
    dlg.onclose = () => resolve(dlg.returnValue === 'ok');
  });
}

// Dropdown menus (Export, ⋯): click the button to open, click anywhere else to close.
function setupMenu(buttonSel, menuSel) {
  const btn = $(buttonSel);
  const menu = $(menuSel);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = !menu.classList.contains('open');
    $$('.menu.open').forEach((m) => m.classList.remove('open'));
    menu.classList.toggle('open', open);
  });
  menu.addEventListener('click', () => menu.classList.remove('open'));
}
document.addEventListener('click', () => $$('.menu.open').forEach((m) => m.classList.remove('open')));
setupMenu('#btn-export', '#menu-export');
setupMenu('#btn-more', '#menu-more');

// ---------------- Navigation (one page at a time, based on the #hash in the URL) ----------------

let lastPage = 'home'; // where the scanner's back arrow goes

function showPage() {
  let name = location.hash.slice(1) || 'home';
  if (name === 'exports') name = 'participants'; // old link: exports now live on Participants

  if (name === 'scan') {
    openScanner();
    return;
  }
  closeScanner();

  const page = $(`#page-${name}`) ? name : 'home';
  lastPage = page;
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${page}`));
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === page));

  if (page === 'home') refreshStats();
  if (page === 'participants') loadParticipants();
  if (page === 'email') openEmailPage();
}
window.addEventListener('hashchange', showPage);

// Top search box → Participants page, filtered.
$('#top-search').addEventListener('submit', (e) => {
  e.preventDefault();
  $('#p-search').value = $('#top-search-input').value;
  location.hash = 'participants';
  renderParticipants();
});
// Press "/" anywhere to jump to the search box.
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !isTyping() && $('#scanner').classList.contains('hidden')) {
    e.preventDefault();
    $('#top-search-input').focus();
  }
});
const isTyping = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);

// ---------------- Live stats (refreshed every few seconds) ----------------

const fmtLongDay = (d) => d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
/** "2026-11-25" → a Date at local midnight that day. */
const fromDayKey = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d); };
const localDayKey = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

async function refreshStats() {
  let s;
  try {
    s = await api('/api/stats');
  } catch {
    return; // server briefly unreachable — try again next tick
  }
  const set = (id, v) => ($(id).textContent = v);
  const pct = s.total ? Math.round((s.checkedIn / s.total) * 100) : 0;
  set('#side-checked', s.checkedIn); set('#side-sent', s.qrSent); set('#side-total', s.total);
  set('#top-checked', s.checkedIn); set('#top-total', s.total);
  set('#scan-present', s.checkedIn); set('#scan-total', s.total);

  // Home
  set('#home-date', fmtLongDay(fromDayKey(s.today)));
  set('#home-checked', s.checkedIn); set('#home-total', s.total); set('#home-total2', s.total);
  set('#home-pct', `${pct}%`);
  set('#home-remaining', s.total ? `${s.total - s.checkedIn} still to arrive` : 'Import participants to start');
  set('#home-scans', s.checkinsToday);
  set('#home-sent', s.qrSent);
  set('#home-failed', s.qrFailed ? `${s.qrFailed} failed` : `${s.total - s.qrSent} not sent yet`);
  const ring = $('#home-ring');
  const len = 2 * Math.PI * 52;
  ring.style.strokeDasharray = `${len}`;
  ring.style.strokeDashoffset = `${len * (1 - pct / 100)}`;

  $('#home-days').innerHTML = s.days.length
    ? s.days
        .map((d) => {
          const w = s.total ? Math.min(100, (d.people / s.total) * 100) : 0;
          const date = fromDayKey(d.day);
          return `<div class="day-row${d.day === s.today ? ' is-today' : ''}">
            <div class="day-date"><b>${date.toLocaleDateString([], { weekday: 'short' })}</b><span>${date.toLocaleDateString([], { day: 'numeric', month: 'short' })}</span></div>
            <div class="day-bar"><i style="width:${w}%"></i></div>
            <div class="day-num"><b>${d.people}</b> ${d.people === 1 ? 'person' : 'people'}<span>${plural(d.checkins, 'check-in')}</span></div>
          </div>`;
        })
        .join('')
    : '<div class="panel-empty">No check-ins yet. Open the scanner to start.</div>';

  $('#home-recent').innerHTML = s.recent.length
    ? s.recent
        .map((r) => `<li><span class="avatar">${escapeHtml(r.name.trim().charAt(0).toUpperCase())}</span>
          <b>${escapeHtml(r.name)}</b><span class="when">${fmtHour(r.at)}${localDayKey(r.at) === s.today ? '' : ` · ${fmtDay(r.at)}`}</span></li>`)
        .join('')
    : '<li class="panel-empty">Nobody has checked in yet.</li>';
}

// ---------------- Function 2: Full-screen scanner ----------------

let qr = null; // the Html5Qrcode camera reader
let cameraOn = false;
let cameraStarting = false;
let cameras = [];
let camIndex = 0;
let lastCode = '';
let lastCodeAt = 0;
let busy = false;

// Clicking any "Scan" link also asks the browser for real full-screen (needs a click to be allowed).
document.addEventListener('click', (e) => {
  if (e.target.closest('a[href="#scan"]') && document.documentElement.requestFullscreen && !document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => { /* the overlay still fills the window */ });
  }
});

function openScanner() {
  const el = $('#scanner');
  if (!el.classList.contains('hidden')) return;
  el.classList.remove('hidden');
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === 'scan'));
  refreshStats();
  startCamera();
  // Focus the code box so USB barcode scanners (which "type" the code) work straight away.
  setTimeout(() => $('#manual-code').focus(), 100);
}

async function closeScanner() {
  const el = $('#scanner');
  if (el.classList.contains('hidden')) return;
  el.classList.add('hidden');
  hideResult();
  await stopCamera();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

$('#scan-back').addEventListener('click', () => (location.hash = lastPage));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#scanner').classList.contains('hidden') && !document.fullscreenElement) {
    location.hash = lastPage;
  }
});

function showScanMessage(html) {
  const m = $('#scan-message');
  m.innerHTML = html;
  m.classList.remove('hidden');
  const retry = m.querySelector('[data-retry]');
  if (retry) retry.onclick = () => startCamera();
}
const hideScanMessage = () => $('#scan-message').classList.add('hidden');

async function startCamera() {
  if (cameraOn || cameraStarting) return;
  if (typeof Html5Qrcode === 'undefined') {
    return showScanMessage('The camera scanner could not load.<br>You can still type the ID below.');
  }
  cameraStarting = true;
  try {
    // Asking for the camera list also triggers the browser's permission prompt.
    if (!cameras.length) cameras = await Html5Qrcode.getCameras();
    if (!cameras.length) {
      return showScanMessage('No camera found.<br>Connect a camera, or type the ID below.');
    }
    let saved = null;
    try { saved = localStorage.getItem('cameraId'); } catch { /* ignore */ }
    const savedIndex = cameras.findIndex((c) => c.id === saved);
    if (savedIndex >= 0) camIndex = savedIndex;
    $('#scan-switch').classList.toggle('hidden', cameras.length < 2);

    const cam = cameras[camIndex];
    // Laptop (front) cameras feel natural mirrored, like a mirror. Back cameras are not mirrored.
    $('#reader').classList.toggle('mirror', !/back|rear|environment/i.test(cam.label));
    qr = qr || new Html5Qrcode('reader', { verbose: false, formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE] });
    await qr.start(cam.id, { fps: 12 }, onScan, () => {}); // no qrbox = scan the whole picture
    cameraOn = true;
    hideScanMessage();
    // The user may have pressed Back while the camera was starting.
    if ($('#scanner').classList.contains('hidden')) stopCamera();
  } catch (err) {
    showScanMessage(`Camera couldn't start.<br><span class="small">${escapeHtml(err.message || err)}</span><br>
      Allow camera access in the browser (camera icon in the address bar).<br>
      <button class="btn" data-retry>Try again</button>`);
  } finally {
    cameraStarting = false;
  }
}

async function stopCamera() {
  if (!cameraOn || !qr) return;
  cameraOn = false;
  try { await qr.stop(); } catch { /* already stopped */ }
}

$('#scan-switch').addEventListener('click', async () => {
  await stopCamera();
  camIndex = (camIndex + 1) % cameras.length;
  try { localStorage.setItem('cameraId', cameras[camIndex].id); } catch { /* ignore */ }
  startCamera();
});

function onScan(text) {
  // The camera sees the same code many times per second — ignore repeats for 4 seconds.
  const now = Date.now();
  if (busy || (text === lastCode && now - lastCodeAt < 4000)) return;
  lastCode = text;
  lastCodeAt = now;
  checkIn(text);
}

// Typed IDs, and USB barcode scanners (which "type" the code and press Enter).
$('#manual-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('#manual-code').value.trim();
  $('#manual-code').value = '';
  if (code) checkIn(code);
});

async function checkIn(code) {
  busy = true;
  try {
    const r = await api('/api/checkin', { method: 'POST', body: { code } });
    const p = r.participant;
    if (r.status === 'checked_in') {
      const n = r.numberToday;
      showResult('ok', '✓', n === 1 ? 'Welcome' : 'Welcome back', p.name,
        `Check-in #${n} today · ${fmtHour(p.checked_in_at)}${p.days_attended > 1 ? ` · day ${p.days_attended}` : ''}`);
      beep('ok');
    } else if (r.status === 'already_checked_in') {
      showResult('warn', '!', 'Already scanned', p.name,
        `${r.secondsAgo} sec ago · scan again after ${Math.round(r.cooldownSeconds / 60) || 1} min for a new check-in`);
      beep('warn');
    } else {
      showResult('bad', '✕', 'Not found', 'Unknown QR code', 'This code is not on the participant list');
      beep('bad');
    }
    refreshStats();
  } catch (err) {
    showResult('bad', '✕', 'Error', '', err.message);
  } finally {
    busy = false;
  }
}

let resultTimer;
function showResult(kind, icon, title, name, sub) {
  const el = $('#scan-result');
  el.className = `scan-result ${kind}`;
  el.innerHTML = `<div class="r-icon">${icon}</div>
    <div class="r-title">${escapeHtml(title)}</div>
    ${name ? `<div class="r-name">${escapeHtml(name)}</div>` : ''}
    <div class="r-sub">${escapeHtml(sub)}</div>`;
  void el.offsetWidth; // restart the animation
  el.classList.add('show');
  clearTimeout(resultTimer);
  resultTimer = setTimeout(hideResult, kind === 'ok' ? 2600 : 3200);
}
function hideResult() {
  $('#scan-result').classList.remove('show');
}

// Short sounds so staff don't have to look at the screen for every scan.
let audioCtx;
function beep(kind) {
  try {
    audioCtx = audioCtx || new AudioContext();
    const tones = { ok: [880], warn: [520, 520], bad: [220] }[kind];
    tones.forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = freq;
      gain.gain.value = 0.08;
      osc.connect(gain).connect(audioCtx.destination);
      const t = audioCtx.currentTime + i * 0.18;
      osc.start(t);
      osc.stop(t + (kind === 'bad' ? 0.35 : 0.12));
    });
  } catch { /* sound is optional */ }
}

// ---------------- Participants ----------------

let participants = [];
let pFilter = 'all';

async function loadParticipants() {
  try {
    participants = await api('/api/participants');
    renderParticipants();
  } catch (err) {
    toast(err.message, true);
  }
}

const QR_ICON = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M3 3h8v8H3zm2 2v4h4V5zm8-2h8v8h-8zm2 2v4h4V5zM3 13h8v8H3zm2 2v4h4v-4zm8-2h3v3h-3zm5 0h3v3h-3zm-5 5h3v3h-3zm5 0h3v3h-3z"/></svg>';

function renderParticipants() {
  const q = $('#p-search').value.trim().toLowerCase();
  const present = participants.filter((p) => p.checked_in).length;
  $('#p-count').textContent = participants.length;
  $('#tab-all').textContent = participants.length;
  $('#tab-in').textContent = present;
  $('#tab-out').textContent = participants.length - present;

  const list = participants.filter((p) => {
    if (pFilter === 'in' && !p.checked_in) return false;
    if (pFilter === 'out' && p.checked_in) return false;
    return !q || p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q) || p.id.toLowerCase().includes(q);
  });

  $('#p-empty').classList.toggle('hidden', participants.length > 0);
  $('#p-rows').innerHTML = list
    .map((p) => {
      const id = escapeHtml(p.id);
      const total = p.checkins.length;
      const checkins = total
        ? `<button class="ci-btn" data-history="${id}" title="See every check-in">
             <span class="ci-count${p.checkins_today ? ' on' : ''}">${p.checkins_today}</span>
             <span class="ci-text"><b>today</b><span>${total} total · ${plural(p.days_attended, 'day')}</span></span>
           </button>`
        : `<button class="ci-btn ci-none" data-history="${id}"><span class="ci-text"><span>None yet</span></span></button>`;
      return `<tr>
        <td class="name">${escapeHtml(p.name)}</td>
        <td>${escapeHtml(p.email)}</td>
        <td>${checkins}</td>
        ${p.checked_in_at ? `<td class="time last"><b>${fmtHour(p.checked_in_at)}</b><span>${p.checked_in ? 'Today' : fmtDay(p.checked_in_at)}</span></td>` : '<td class="time dim">—</td>'}
        <td><button class="qr-btn" data-qr="${escapeHtml(p.id)}" title="Show QR code">${QR_ICON}</button></td>
        <td>${p.checked_in ? '<span class="status status-present">Present</span>' : '<span class="status status-absent">Not yet</span>'}</td>
        <td class="end"><button class="mark-btn" data-checkin="${id}" title="Add a check-in now">Check in</button><button class="trash-btn" data-del="${escapeHtml(p.id)}" title="Delete ${escapeHtml(p.name)}" aria-label="Delete ${escapeHtml(p.name)}"></button></td>
      </tr>`;
    })
    .join('');
}

$('#p-search').addEventListener('input', renderParticipants);
$('#p-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  pFilter = b.dataset.filter;
  $$('#p-tabs button').forEach((x) => x.classList.toggle('on', x === b));
  renderParticipants();
});

// Buttons inside the table (one listener for all rows).
$('#p-rows').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.qr) return openQr(b.dataset.qr);
  if (b.dataset.del) return deleteOne(b.dataset.del);
  if (b.dataset.history) return openHistory(b.dataset.history);
  if (b.dataset.checkin) manualCheckin(b.dataset.checkin);
});

/** Add a check-in by hand (button in the table or in the history window). */
async function manualCheckin(id) {
  try {
    const r = await api('/api/checkin', { method: 'POST', body: { code: id } });
    const p = r.participant;
    if (r.status === 'checked_in') toast(`${p.name}: check-in #${r.numberToday} today`);
    else toast(`${p.name} was checked in ${r.secondsAgo} sec ago`, true);
    await loadParticipants();
    refreshStats();
    if ($('#hist-dialog').open) renderHistory(id);
  } catch (err) {
    toast(err.message, true);
  }
}

// ---- Attendance history (every check-in of one person, grouped by day) ----

function openHistory(id) {
  renderHistory(id);
  $('#hist-dialog').showModal();
}

function renderHistory(id) {
  const p = participants.find((x) => x.id === id);
  if (!p) return $('#hist-dialog').close();
  const dlg = $('#hist-dialog');
  dlg.dataset.id = id;
  $('#hist-name').textContent = p.name;
  $('#hist-meta').textContent = p.checkins.length
    ? `${plural(p.checkins.length, 'check-in')} over ${plural(p.days_attended, 'day')} · ID ${p.id}`
    : `No check-ins yet · ID ${p.id}`;
  const byDay = new Map();
  [...p.checkins].sort().forEach((at) => {
    const k = localDayKey(at);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(at);
  });
  const todayKey = localDayKey(new Date().toISOString());
  $('#hist-body').innerHTML = byDay.size
    ? [...byDay.entries()]
        .map(([day, list]) => `<div class="hist-day">
          <div class="hist-day-title">${fmtLongDay(fromDayKey(day))}${day === todayKey ? ' <span class="tag tag-green">Today</span>' : ''}<span class="muted">${plural(list.length, 'check-in')}</span></div>
          <ol>${list.map((at, i) => `<li><span class="num">${i + 1}</span><span class="t">${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            <button type="button" class="trash-btn" data-at="${escapeHtml(at)}" title="Remove this check-in" aria-label="Remove this check-in"></button></li>`).join('')}</ol>
        </div>`)
        .join('')
    : '<div class="panel-empty">Not checked in yet. Scan their QR code, or press “Check in now”.</div>';
}

$('#hist-add').addEventListener('click', () => manualCheckin($('#hist-dialog').dataset.id));
$('#hist-body').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-at]');
  if (!b) return;
  const id = $('#hist-dialog').dataset.id;
  try {
    await api(`/api/participants/${encodeURIComponent(id)}/checkins`, { method: 'DELETE', body: { at: b.dataset.at } });
    toast('Check-in removed');
    await loadParticipants();
    refreshStats();
    renderHistory(id);
  } catch (err) {
    toast(err.message, true);
  }
});

async function deleteOne(id) {
  const p = participants.find((x) => x.id === id);
  if (!p) return;
  const ok = await confirmDialog({
    title: `Delete ${p.name}?`,
    html: `${escapeHtml(p.email)} will be removed from the list. Their QR code will stop working. <b>This cannot be undone.</b>`,
    okText: 'Delete',
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/participants/${encodeURIComponent(id)}`, { method: 'DELETE', body: {} });
    toast(`Deleted ${p.name}`);
    loadParticipants();
    refreshStats();
  } catch (err) {
    toast(err.message, true);
  }
}

function openQr(id) {
  const p = participants.find((x) => x.id === id);
  if (!p) return;
  const url = `/api/participants/${encodeURIComponent(p.id)}/qr.png`;
  $('#qr-img').src = url;
  $('#qr-name').textContent = p.name;
  $('#qr-meta').textContent = `${p.email} · ID ${p.id}`;
  $('#qr-download').href = url;
  $('#qr-download').setAttribute('download', `qr-${p.name.replace(/[^\w-]+/g, '-')}.png`);
  $('#qr-dialog').showModal();
}
// Click outside a dialog's box to close it.
$$('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close('cancel'); }));

// Add participant
$('#btn-add').addEventListener('click', () => {
  $('#add-form').reset();
  $('#add-dialog').showModal();
  $('#add-name').focus();
});
$('#add-cancel').addEventListener('click', () => $('#add-dialog').close());
$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const p = await api('/api/participants', { method: 'POST', body: { name: $('#add-name').value, email: $('#add-email').value } });
    $('#add-dialog').close();
    toast(`Added ${p.name}`);
    loadParticipants();
    refreshStats();
  } catch (err) {
    toast(err.message, true);
  }
});

$('#delete-all').addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: 'Delete all participants?',
    html: `This removes all ${participants.length} participants, their check-ins and QR codes. Old QR codes will stop working. <b>This cannot be undone.</b> Export first if you need the list.`,
    okText: 'Delete all',
    danger: true,
    requireText: 'DELETE',
  });
  if (!ok) return;
  try {
    await api('/api/participants', { method: 'DELETE', body: { confirm: 'DELETE' } });
    toast('All participants deleted');
    loadParticipants();
    refreshStats();
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------------- Function 1: CSV import ----------------

async function importFile(file) {
  if (!file) return;
  const box = $('#import-result');
  box.innerHTML = `<div class="import-loading"><span class="spinner"></span>Importing <b>${escapeHtml(file.name)}</b>…</div>`;
  try {
    const csv = await file.text();
    const r = await api('/api/participants/import', { method: 'POST', body: { csv } });
    const skippedList = r.skipped
      .slice(0, 50)
      .map((s) => `<li>${s.row ? `Row ${s.row}: ` : ''}${escapeHtml(s.reason)}</li>`)
      .join('');
    $('#drop').classList.add('hidden'); // show the result on its own; the back button brings the upload box back
    box.innerHTML = `<div class="import-summary">
      <div class="import-top">
        <button type="button" class="back-btn" data-import-again title="Back to upload" aria-label="Back to upload"><svg class="ico" viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>
        <div class="import-file">✓ <b>${escapeHtml(file.name)}</b> imported</div>
      </div>
      <div class="import-stats">
        <div class="ist ist-green"><b>${r.added}</b><span>Added</span></div>
        <div class="ist ${r.skipped.length ? 'ist-amber' : ''}"><b>${r.skipped.length}</b><span>Skipped</span></div>
        <div class="ist"><b>${r.total}</b><span>Total in list</span></div>
      </div>
      <div class="import-next">
        <button type="button" class="btn btn-light btn-again" data-import-again><svg class="ico" viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4"/></svg>Import another file</button>
        <span class="spacer"></span>
        <a class="btn btn-light" href="#participants">View participants</a>
        <a class="btn" href="#email">Send QR codes →</a>
      </div>
      ${r.skipped.length ? `<details class="skipped"><summary>Why ${r.skipped.length === 1 ? '1 row was' : `${r.skipped.length} rows were`} skipped</summary><ul>${skippedList}</ul>${r.skipped.length > 50 ? `<p class="muted small">…and ${r.skipped.length - 50} more</p>` : ''}</details>` : ''}
    </div>`;
    refreshStats();
  } catch (err) {
    box.innerHTML = `<div class="import-summary notice notice-red">${escapeHtml(err.message)} Choose another file above to try again.</div>`;
  } finally {
    $('#csv-file').value = ''; // allow choosing the same file again
  }
}

/** Back to the empty upload box, ready for another file. */
function resetImport() {
  $('#import-result').innerHTML = '';
  $('#drop').classList.remove('hidden');
}
$('#import-result').addEventListener('click', (e) => {
  if (e.target.closest('[data-import-again]')) resetImport();
});

$('#csv-file').addEventListener('change', (e) => importFile(e.target.files[0]));
const drop = $('#drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  importFile(e.dataTransfer.files[0]);
});

// ---------------- Function 4: Send QR codes ----------------

let config = {};
let toMode = 'unsent'; // "unsent" = only people who haven't got their QR yet, "all" = everyone
let previewIndex = 0;
let previewTotal = 0;
let previewKey = null; // which draft the preview on screen belongs to
let pollTimer = null;
let jobStartedHere = null; // a send started from this page (so we show its result)
let dismissedJob = null; // a finished send the user closed with "Back to compose"
let excluded = []; // IDs removed from this send (they stay in the participant list)
let overrides = {}; // { ID: { subject, body } } — emails edited for one person only
let previewPerson = null; // the participant shown in the preview right now

/** A small "type an email, press Enter" box that turns addresses into chips. Used for Cc and Bcc. */
function chipInput(el, onChange) {
  const input = el.querySelector('input');
  let list = [];
  const render = () => {
    el.querySelectorAll('.email-chip').forEach((c) => c.remove());
    list.forEach((addr, i) => {
      const chip = document.createElement('span');
      chip.className = 'email-chip';
      chip.innerHTML = `${escapeHtml(addr)}<button type="button" aria-label="Remove">×</button>`;
      chip.querySelector('button').onclick = () => { list.splice(i, 1); render(); onChange(); };
      el.insertBefore(chip, input);
    });
  };
  const commit = () => {
    const parts = input.value.split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!parts.length) return true;
    const bad = parts.filter((a) => !EMAIL_RE.test(a));
    parts.filter((a) => EMAIL_RE.test(a) && !list.includes(a)).forEach((a) => list.push(a));
    if (list.length > 10) { list = list.slice(0, 10); toast('At most 10 addresses', true); }
    input.value = bad.join(', ');
    if (bad.length) {
      el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
      toast(`"${bad[0]}" is not a valid email`, true);
    }
    render();
    onChange();
    return !bad.length;
  };
  input.addEventListener('keydown', (e) => {
    if (['Enter', ',', ';'].includes(e.key) || (e.key === ' ' && input.value.trim())) {
      e.preventDefault();
      commit();
    } else if (e.key === 'Backspace' && !input.value && list.length) {
      list.pop(); render(); onChange();
    }
  });
  input.addEventListener('blur', commit);
  input.addEventListener('paste', () => setTimeout(commit, 0));
  el.addEventListener('click', () => input.focus());
  return {
    get: () => list.slice(),
    set: (arr) => { list = (arr || []).slice(0, 10); render(); },
  };
}

const cc = chipInput($('#cc-input'), () => draftChanged());
const bcc = chipInput($('#bcc-input'), () => draftChanged());

function draft() {
  return {
    subject: $('#em-subject').value,
    body: $('#em-body').value,
    cc: cc.get(),
    bcc: bcc.get(),
    onlyUnsent: toMode === 'unsent',
    exclude: excluded.slice(),
    overrides: { ...overrides },
  };
}
const draftKey = () => JSON.stringify(draft());
const recipients = () =>
  participants.filter((p) => !(toMode === 'unsent' && p.qr_sent) && !excluded.includes(p.id));

function saveDraft() {
  try { localStorage.setItem('emailDraft', JSON.stringify({ ...draft(), toMode })); } catch { /* fine */ }
}

function draftChanged() {
  saveDraft();
  updateQrHint();
  updateCcRows();
  updateSendState();
  schedulePreview();
}
$('#em-subject').addEventListener('input', draftChanged);
$('#em-body').addEventListener('input', draftChanged);

// To: Not sent yet / Everyone
$('#to-mode').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  setToMode(b.dataset.mode);
  previewIndex = 0;
  draftChanged();
});
function setToMode(mode) {
  toMode = mode === 'all' ? 'all' : 'unsent';
  $$('#to-mode button').forEach((x) => x.classList.toggle('on', x.dataset.mode === toMode));
  renderRecipients();
}

// Cc / Bcc rows open when you click "Cc" / "Bcc" (or when they already have addresses)
function updateCcRows(forceOpen) {
  for (const [kind, box] of [['cc', cc], ['bcc', bcc]]) {
    const row = $(`#row-${kind}`);
    if (forceOpen === kind) row.classList.remove('hidden');
    $(`#show-${kind}`).classList.toggle('on', !row.classList.contains('hidden'));
    if (box.get().length) row.classList.remove('hidden');
  }
  $('#cc-note').classList.toggle('hidden', !cc.get().length && !bcc.get().length);
}
for (const kind of ['cc', 'bcc']) {
  $(`#show-${kind}`).addEventListener('click', () => {
    const row = $(`#row-${kind}`);
    const box = kind === 'cc' ? cc : bcc;
    if (!row.classList.contains('hidden') && !box.get().length) {
      row.classList.add('hidden'); // clicking again closes an empty row
    } else {
      row.classList.remove('hidden');
      row.querySelector('input').focus();
    }
    updateCcRows();
  });
}

// Tell the user where the QR code will end up.
const HAS_QR = /\{\{\s*qr\s*\}\}/i;
function updateQrHint() {
  $('#qr-hint').textContent = HAS_QR.test($('#em-body').value)
    ? '✓ QR code goes where {{qr}} is'
    : 'No {{qr}} yet: the QR code won’t show in the message (only attached as a PNG)';
}

// Placeholder buttons insert {{name}} etc. where the cursor is.
$$('.chip[data-ph]').forEach((chip) =>
  chip.addEventListener('click', () => {
    const ta = $('#em-body');
    const pos = ta.selectionStart ?? ta.value.length;
    ta.value = ta.value.slice(0, pos) + chip.dataset.ph + ta.value.slice(ta.selectionEnd ?? pos);
    ta.focus();
    ta.selectionStart = ta.selectionEnd = pos + chip.dataset.ph.length;
    draftChanged();
  })
);

/** Enable/disable "Send" and "Send test", and explain why in the hint. */
function updateSendState() {
  const d = draft();
  const n = recipients().length;
  const hasText = d.subject.trim() && d.body.trim();
  const running = Boolean(currentJob && currentJob.running);
  let hint = '';
  if (!config.emailConfigured) hint = 'Connect Gmail first';
  else if (!participants.length) hint = 'Import participants first';
  else if (!n) hint = 'Everyone already has their QR';
  else if (!hasText) hint = 'Add a subject and message';
  else if (previewKey !== draftKey()) hint = 'Updating preview…';
  else if (running) hint = 'A send is in progress';

  $('#send-hint').textContent = hint;
  $('#btn-send').disabled = Boolean(hint);
  $('#btn-send').textContent = n ? `Send to ${plural(n, 'person').replace('persons', 'people')}` : 'Send';
  $('#btn-test').disabled = !config.emailConfigured || !hasText || !n;
  $('#cnt-unsent').textContent = participants.filter((p) => !p.qr_sent).length;
  $('#cnt-all').textContent = participants.length;
  $('#cnt-rcpt').textContent = n;
}

// ---- Live preview ----

const schedulePreview = debounce(() => loadPreview(previewIndex), 350);

function clearPreview(message) {
  previewKey = null;
  $('#pv-name').textContent = '—';
  $('#pv-counter').textContent = '';
  $('#pv-subject').textContent = message;
  $('#pv-to').textContent = '—';
  $('#pv-cc-line').classList.add('hidden');
  $('#pv-bcc-line').classList.add('hidden');
  $('#pv-frame').srcdoc = '';
  $('#pv-prev').disabled = true;
  $('#pv-next').disabled = true;
  previewPerson = null;
  $('#pv-edit').disabled = true;
  $('#pv-remove').disabled = true;
  $('#pv-edited').classList.add('hidden');
  closeEditor();
  updateSendState();
}

async function loadPreview(index) {
  const d = draft();
  if (!participants.length) return clearPreview('Import participants to see a preview');
  if (!recipients().length) {
    return clearPreview(excluded.length
      ? 'Everyone was removed from this send. Restore people in the Recipients tab.'
      : 'Everyone has already received their QR code. Choose “Everyone” to send again.');
  }
  if (!d.subject.trim() || !d.body.trim()) return clearPreview('Write a subject and message to see the preview');
  const key = draftKey();
  try {
    const r = await api('/api/email/preview', { method: 'POST', body: { ...d, index } });
    if (key !== draftKey()) return; // the draft changed while we waited; a newer preview is coming
    previewIndex = r.index;
    previewTotal = r.total;
    previewKey = key;
    if (!previewPerson || previewPerson.id !== r.participant.id) closeEditor();
    previewPerson = r.participant;
    $('#pv-edit').disabled = false;
    $('#pv-remove').disabled = false;
    $('#pv-edited').classList.toggle('hidden', !r.edited);
    $('#pv-name').textContent = r.participant.name;
    $('#pv-counter').textContent = `Preview ${r.index + 1} of ${r.total}`;
    $('#pv-subject').textContent = r.subject;
    $('#pv-to').textContent = r.to;
    $('#pv-cc').textContent = r.cc.join(', ');
    $('#pv-bcc').textContent = r.bcc.join(', ');
    $('#pv-cc-line').classList.toggle('hidden', !r.cc.length);
    $('#pv-bcc-line').classList.toggle('hidden', !r.bcc.length);
    $('#pv-frame').srcdoc = `<body style="margin:18px">${r.html}</body>`; // height is fitted on load
    $('#pv-prev').disabled = r.index === 0;
    $('#pv-next').disabled = r.index >= r.total - 1;
    updateSendState();
  } catch (err) {
    clearPreview(err.message);
  }
}

// Grow the preview to fit the whole email, so the QR code is never cut off.
$('#pv-frame').addEventListener('load', () => {
  const f = $('#pv-frame');
  try {
    const doc = f.contentDocument;
    const fit = () => (f.style.height = Math.max(200, doc.documentElement.scrollHeight) + 'px');
    fit();
    doc.querySelectorAll('img').forEach((img) => img.addEventListener('load', fit));
  } catch { /* keep the default height */ }
});

$('#pv-prev').addEventListener('click', () => loadPreview(previewIndex - 1));
$('#pv-next').addEventListener('click', () => loadPreview(previewIndex + 1));
document.addEventListener('keydown', (e) => {
  if (location.hash !== '#email' || isTyping() || !previewKey) return;
  if (e.key === 'ArrowLeft' && previewIndex > 0) loadPreview(previewIndex - 1);
  if (e.key === 'ArrowRight' && previewIndex < previewTotal - 1) loadPreview(previewIndex + 1);
});

// ---- Edit one person's email, or remove them from this send ----

/** Fill in {{name}}, {{email}}, {{id}} so the editor shows what this person will read. {{qr}} stays. */
function fillFor(text, p) {
  return String(text || '').replace(/\{\{\s*(name|email|id)\s*\}\}/gi, (m, k) => p[k.toLowerCase()]);
}

function openEditor() {
  const p = previewPerson;
  if (!p) return;
  const o = overrides[p.id];
  const d = draft();
  $('#pv-ed-name').textContent = p.name;
  $('#pv-ed-subject').value = o ? o.subject : fillFor(d.subject, p);
  let body = o ? o.body : fillFor(d.body, p);
  $('#pv-ed-body').value = body;
  $('#pv-ed-reset').classList.toggle('hidden', !o);
  $('#pv-editor').classList.remove('hidden');
  $('#pv-edit').classList.add('hidden');
  $('#pv-ed-body').focus();
}
function closeEditor() {
  $('#pv-editor').classList.add('hidden');
  $('#pv-edit').classList.remove('hidden');
}

$('#pv-edit').addEventListener('click', openEditor);
$('#pv-ed-cancel').addEventListener('click', closeEditor);
$('#pv-ed-save').addEventListener('click', () => {
  const p = previewPerson;
  const subject = $('#pv-ed-subject').value.trim();
  const body = $('#pv-ed-body').value.trim();
  if (!p) return;
  if (!subject || !body) return toast('Subject and message cannot be empty', true);
  overrides[p.id] = { subject, body };
  closeEditor();
  toast(`Saved a custom email for ${p.name}`);
  renderRecipients();
  draftChanged();
});
$('#pv-ed-reset').addEventListener('click', () => {
  const p = previewPerson;
  if (!p) return;
  delete overrides[p.id];
  closeEditor();
  toast(`${p.name} gets the main message again`);
  renderRecipients();
  draftChanged();
});

function excludePerson(id) {
  const p = participants.find((x) => x.id === id);
  if (!p || excluded.includes(id)) return;
  excluded.push(id);
  renderRecipients();
  draftChanged();
  toast(`${p.name} removed from this send`);
}
function restorePerson(id) {
  excluded = id ? excluded.filter((x) => x !== id) : [];
  renderRecipients();
  draftChanged();
}
$('#pv-remove').addEventListener('click', () => previewPerson && excludePerson(previewPerson.id));

// ---- Preview / Recipients tabs ----

$$('.tabs button').forEach((b) =>
  b.addEventListener('click', () => showTab(b.dataset.tab))
);
function showTab(tab) {
  $$('.tabs button').forEach((x) => x.classList.toggle('on', x.dataset.tab === tab));
  $('#tab-preview').classList.toggle('hidden', tab !== 'preview');
  $('#tab-recipients').classList.toggle('hidden', tab !== 'recipients');
}

function renderRecipients() {
  const list = recipients();
  $('#rcpt-list').innerHTML = list.length
    ? list
        .map((p, i) => {
          const tag = p.qr_sent
            ? '<span class="tag tag-blue">Sent</span>'
            : p.qr_error
              ? `<span class="tag tag-red" title="${escapeHtml(p.qr_error)}">Failed</span>`
              : '<span class="tag tag-gray">Not sent</span>';
          const edited = overrides[p.id] ? '<span class="tag tag-blue">Edited</span>' : '';
          return `<li data-i="${i}"><div class="who"><b>${escapeHtml(p.name)}</b><span>${escapeHtml(p.email)}</span></div>${edited}${tag}
            <button class="trash-btn" data-remove="${escapeHtml(p.id)}" title="Remove from this send" aria-label="Remove ${escapeHtml(p.name)} from this send"></button></li>`;
        })
        .join('')
    : `<li class="empty-row">${!participants.length ? 'No participants yet' : excluded.length ? 'Everyone was removed from this send' : 'Everyone already has their QR code'}</li>`;

  // People removed from this send, with a way to put them back.
  const removed = excluded.map((id) => participants.find((p) => p.id === id)).filter(Boolean);
  const box = $('#rcpt-removed');
  box.classList.toggle('hidden', !removed.length);
  box.innerHTML = removed.length
    ? `<div class="head"><b>Removed from this send · ${removed.length}</b><button type="button" class="link-btn" data-restore="*">Restore all</button></div>
       <ul>${removed.map((p) => `<li><span>${escapeHtml(p.name)} · ${escapeHtml(p.email)}</span><button type="button" class="link-btn" data-restore="${escapeHtml(p.id)}">Restore</button></li>`).join('')}</ul>`
    : '';
}
$('#rcpt-removed').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-restore]');
  if (b) restorePerson(b.dataset.restore === '*' ? null : b.dataset.restore);
});
// Click a recipient → see their email.
$('#rcpt-list').addEventListener('click', (e) => {
  const del = e.target.closest('button[data-remove]');
  if (del) return excludePerson(del.dataset.remove);
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  showTab('preview');
  loadPreview(Number(li.dataset.i));
});

// ---- Gmail connection ----

function renderGmail() {
  const pill = $('#gmail-status');
  const form = $('#gmail-form');
  if (config.emailConfigured && form.dataset.editing !== '1') {
    pill.innerHTML = `<span class="dot dot-green"></span>Sending from <b>${escapeHtml(config.fromName || config.gmailUser)}</b>
      ${config.fromName ? `<span class="muted">${escapeHtml(config.gmailUser)}</span>` : ''}
      ${config.canEditEmailSettings ? '<button type="button" id="gmail-change">Change</button>' : ''}`;
    pill.classList.remove('hidden');
    form.classList.add('hidden');
    const change = $('#gmail-change');
    if (change) change.onclick = () => { form.dataset.editing = '1'; renderGmail(); };
  } else {
    pill.classList.add('hidden');
    form.classList.remove('hidden');
    form.gmailUser.value = form.gmailUser.value || config.gmailUser || '';
    form.fromName.value = form.fromName.value || config.fromName || '';
    if (!config.canEditEmailSettings) {
      form.querySelector('.connect-fields').classList.add('hidden');
      $('#gmail-error').textContent = 'Gmail can only be connected on the laptop that runs the app.';
    }
  }
}

$('#gmail-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const btn = $('#gmail-connect');
  $('#gmail-error').textContent = '';
  btn.disabled = true;
  btn.textContent = 'Checking with Google…';
  try {
    await api('/api/email/settings', {
      method: 'POST',
      body: { gmailUser: form.gmailUser.value, appPassword: form.appPassword.value, fromName: form.fromName.value },
    });
    form.appPassword.value = '';
    form.dataset.editing = '';
    config = await api('/api/config');
    toast('Gmail connected');
    renderGmail();
    updateSendState();
  } catch (err) {
    $('#gmail-error').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect';
  }
});

// ---- Test & send ----

$('#btn-test').addEventListener('click', async () => {
  const btn = $('#btn-test');
  btn.disabled = true;
  btn.textContent = 'Sending test…';
  try {
    const r = await api('/api/email/test', { method: 'POST', body: { ...draft(), index: previewIndex } });
    toast(`Test sent to ${r.sentTo} (with ${r.usingParticipant}'s QR)`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.textContent = 'Send test to me';
    updateSendState();
  }
});

/** Ask for confirmation, then start sending in the background. */
async function startSend({ retry = false } = {}) {
  if (retry) setToMode('unsent');
  const d = draft();
  const n = recipients().length;
  if (!n) return toast('Nobody left to send to', true);
  const mins = Math.max(1, Math.ceil((n * 1.6) / 60));
  const row = (label, value) => `<li><span>${label}</span><span>${value}</span></li>`;
  const noQr = !HAS_QR.test(d.body)
    ? '<div class="notice">⚠ Your message has no <b>{{qr}}</b>, so the QR code will not show inside the email. It is only attached as a PNG file.</div>'
    : '';
  const ok = await confirmDialog({
    title: retry ? `Retry ${plural(n, 'email')}?` : `Send ${plural(n, 'email')}?`,
    html: `${noQr}Each person gets their own email with their QR code.
      <ul class="confirm-list">
        ${row('To', `${n} participant${n === 1 ? '' : 's'} ${d.onlyUnsent ? '(not sent yet)' : '(everyone)'}`)}
        ${d.cc.length ? row('Cc', escapeHtml(d.cc.join(', ')) + ` <span class="muted">· ${n} copies each</span>`) : ''}
        ${d.bcc.length ? row('Bcc', escapeHtml(d.bcc.join(', ')) + ` <span class="muted">· ${n} copies each</span>`) : ''}
        ${row('Subject', escapeHtml(d.subject))}
        ${Object.keys(d.overrides).length ? row('Edited', `${plural(Object.keys(d.overrides).length, 'person').replace('persons', 'people')} with their own version`) : ''}
        ${d.exclude.length ? row('Removed', `${d.exclude.length} not included`) : ''}
        ${row('Time', `about ${mins} min`)}
      </ul>`,
    okText: `Send ${plural(n, 'email')}`,
  });
  if (!ok) return;
  try {
    await api('/api/email/send', { method: 'POST', body: d });
    toast('Sending started — you can leave this page');
    const job = await api('/api/email/status');
    jobStartedHere = job.startedAt;
    showProgress(true);
    startPolling();
  } catch (err) {
    toast(err.message, true);
  }
}
$('#btn-send').addEventListener('click', () => startSend());
$('#pg-retry').addEventListener('click', () => startSend({ retry: true }));

$('#pg-stop').addEventListener('click', async () => {
  await api('/api/email/stop', { method: 'POST' }).catch(() => {});
  toast('Stopping after the current email…');
});
$('#pg-back').addEventListener('click', async () => {
  dismissedJob = currentJob && currentJob.startedAt;
  showProgress(false);
  await loadParticipants();
  renderRecipients();
  draftChanged();
});

function showProgress(on) {
  $('#progress').classList.toggle('hidden', !on);
  $('#compose-area').classList.toggle('hidden', on);
  $('#gmail-form').classList.toggle('hidden', on || (config.emailConfigured && $('#gmail-form').dataset.editing !== '1'));
}

// ---- Progress while sending ----

let currentJob = null;

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(pollJob, 1000);
  pollJob();
}

async function pollJob() {
  try {
    currentJob = await api('/api/email/status');
  } catch {
    return; // try again next second
  }
  renderJob(currentJob);
  if (!currentJob.running) {
    clearInterval(pollTimer);
    refreshStats();
    await loadParticipants(); // update "Sent / Failed" everywhere
    renderRecipients();
    updateSendState();
  }
}

function renderJob(job) {
  const done = job.sent + job.failed;
  const left = Math.max(0, job.total - done);
  const pct = (n) => (job.total ? (n / job.total) * 100 : 0) + '%';
  $('#pg-bar-sent').style.width = pct(job.sent);
  $('#pg-bar-failed').style.width = pct(job.failed);
  $('#pg-sent').textContent = job.sent;
  $('#pg-failed').textContent = job.failed;
  $('#pg-left').textContent = left;

  const stopped = !job.running && left > 0;
  const unsent = job.failed + left;
  if (job.running) {
    $('#pg-kicker').textContent = 'Sending';
    $('#pg-title').textContent = `Sending ${done + 1 > job.total ? job.total : done + 1} of ${job.total}…`;
    $('#pg-sub').textContent = `${job.current ? `Now: ${job.current} · ` : ''}about ${Math.max(1, Math.ceil((left * 1.6) / 60))} min left. You can leave this page.`;
  } else {
    $('#pg-kicker').textContent = stopped ? 'Stopped' : 'Finished';
    $('#pg-title').textContent = job.failed || stopped
      ? `${job.sent} sent · ${unsent} not delivered`
      : `All ${plural(job.sent, 'email')} sent ✓`;
    $('#pg-sub').textContent = `Subject: ${job.subject}${job.finishedAt ? ` · ${fmtHour(job.finishedAt)}` : ''}`;
  }
  $('#pg-stop').classList.toggle('hidden', !job.running);
  $('#pg-back').classList.toggle('hidden', job.running);
  $('#pg-retry').classList.toggle('hidden', job.running || unsent === 0);
  $('#pg-retry').textContent = `Retry ${unsent} unsent`;

  $('#pg-abort').classList.toggle('hidden', !job.abortReason);
  $('#pg-abort').textContent = job.abortReason || '';

  $('#pg-failures').innerHTML = job.failures.length
    ? `<div class="fail-list"><h3>Failed emails</h3><div class="table-wrap"><table class="table">
        <thead><tr><th>Name</th><th>Email</th><th>Reason</th></tr></thead>
        <tbody>${job.failures.map((f) => `<tr><td>${escapeHtml(f.name)}</td><td>${escapeHtml(f.email)}</td><td>${escapeHtml(f.error)}</td></tr>`).join('')}</tbody>
      </table></div></div>`
    : '';
}

// Opening the Send page: refresh everything, and show progress if a send is running.
async function openEmailPage() {
  try {
    [config, participants] = await Promise.all([api('/api/config'), api('/api/participants')]);
    currentJob = await api('/api/email/status');
  } catch (err) {
    return toast(err.message, true);
  }
  // Forget removed/edited entries for people who no longer exist.
  const ids = new Set(participants.map((p) => p.id));
  excluded = excluded.filter((id) => ids.has(id));
  overrides = Object.fromEntries(Object.entries(overrides).filter(([id]) => ids.has(id)));
  renderGmail();
  renderRecipients();
  updateCcRows();
  const j = currentJob;
  const showJob = j.startedAt && (j.running || (j.startedAt === jobStartedHere && j.startedAt !== dismissedJob));
  showProgress(Boolean(showJob));
  if (showJob) {
    renderJob(j);
    if (j.running) startPolling();
  }
  updateSendState();
  schedulePreview();
}

// ---------------- Start-up ----------------

async function init() {
  try {
    config = await api('/api/config');
  } catch (err) {
    toast(err.message, true);
  }
  $('#event-name').textContent = config.eventName || 'Event Check-in';
  document.title = config.eventName || 'Event Check-in';

  // Restore the email draft from last time.
  try {
    const saved = JSON.parse(localStorage.getItem('emailDraft') || 'null');
    if (saved) {
      $('#em-subject').value = saved.subject || '';
      $('#em-body').value = saved.body || '';
      cc.set(saved.cc);
      bcc.set(saved.bcc);
      excluded = Array.isArray(saved.exclude) ? saved.exclude : [];
      overrides = saved.overrides && typeof saved.overrides === 'object' ? saved.overrides : {};
      setToMode(saved.toMode || 'unsent');
    }
  } catch { /* ignore */ }

  updateQrHint();
  showPage();
  refreshStats();
  setInterval(refreshStats, 4000); // keeps numbers fresh if a second laptop is also scanning
}

init();
