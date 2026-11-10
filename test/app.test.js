// ---------------------------------------------------------------
// Automated checks. Run with:  npm test
// Uses a temporary data file, so your real participant list is never touched.
// ---------------------------------------------------------------

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-test-'));
process.env.DATA_FILE = path.join(tmpDir, 'participants.json');
process.env.ENV_FILE = path.join(tmpDir, '.env'); // never touch the real .env
process.env.SEND_DELAY_MS = '0';
// Make sure tests never send real email. (Empty strings, so a real .env can't fill them in.)
process.env.GMAIL_USER = '';
process.env.GMAIL_APP_PASSWORD = '';
process.env.ALLOWED_HOSTS = '';
process.env.ADMIN_USER = '';
process.env.ADMIN_PASSWORD_HASH = '';
process.env.SESSION_SECRET = '';

const app = require('../server');

let server;
let base;
let sessionCookie = '';
const realFetch = globalThis.fetch;
// Every request in the tests is logged in, unless it passes { anonymous: true }.
globalThis.fetch = (url, opts = {}) => {
  const headers = { ...(opts.headers || {}) };
  if (!opts.anonymous && sessionCookie) headers.Cookie = sessionCookie;
  return realFetch(url, { ...opts, headers });
};

before(async () => {
  server = app.listen(0); // 0 = any free port
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;

  // Create the admin account, then send the login cookie with every request in these tests.
  const res = await realFetch(base + '/api/auth/setup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'correct horse' }),
  });
  assert.equal(res.status, 200, 'account setup works');
  sessionCookie = res.headers.get('set-cookie').split(';')[0];
});

after(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const get = (url) => fetch(base + url);
const post = (url, body, extraHeaders = {}) =>
  fetch(base + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });

test('server starts and serves the page', async () => {
  const res = await get('/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Check-in Scanner/);
  const lib = await get('/vendor/html5-qrcode.min.js');
  assert.equal(lib.status, 200, 'QR scanner library should be served locally');
});

test('CSV import adds valid rows and skips bad/duplicate ones', async () => {
  const csv =
    '﻿Name,Email,Organization\n' +
    'Sok Dara,dara@example.com,TSA\n' +
    '"Chan, Sophea",sophea@example.com,MPTC\n' +
    'No Email,,X\n' +
    'Bad Email,not-an-email,X\n' +
    'Dara Again,DARA@example.com,TSA\n' +
    'សុខ ដារ៉ា,khmer@example.com,TSA\n';
  const res = await post('/api/participants/import', { csv });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.added, 3);
  assert.equal(data.skipped.length, 3);

  // Importing the same file again adds nobody.
  const again = await (await post('/api/participants/import', { csv })).json();
  assert.equal(again.added, 0);

  const list = await (await get('/api/participants')).json();
  assert.equal(list.length, 3);
  assert.equal(list[1].name, 'Chan, Sophea');
  assert.equal(list[0].extra.Organization, 'TSA');
});

test('CSV import without an email column gives a clear error', async () => {
  const res = await post('/api/participants/import', { csv: 'name,phone\nA,123\n' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /email/i);
});

test('check-in works, then reports "already checked in", and unknown codes are not found', async () => {
  const [p] = await (await get('/api/participants')).json();

  const first = await (await post('/api/checkin', { code: p.id })).json();
  assert.equal(first.status, 'checked_in');
  assert.ok(first.participant.checked_in_at);

  const second = await (await post('/api/checkin', { code: ` ${p.id.toLowerCase()} ` })).json();
  assert.equal(second.status, 'already_checked_in');
  assert.equal(second.participant.checked_in_at, first.participant.checked_in_at);

  const unknown = await post('/api/checkin', { code: 'NOPE123' });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).status, 'not_found');

  const stats = await (await get('/api/stats')).json();
  assert.equal(stats.checkedIn, 1);
});

test('QR code image is a PNG', async () => {
  const [p] = await (await get('/api/participants')).json();
  const res = await get(`/api/participants/${p.id}/qr.png`);
  assert.equal(res.headers.get('content-type'), 'image/png');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(1, 4).toString(), 'PNG');
});

test('export of all participants downloads as CSV', async () => {
  const res = await get('/api/export/all.csv');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="participants-all-.*\.csv"/);
  const text = await res.text();
  const lines = text.trim().split('\r\n');
  assert.equal(lines.length, 4); // header + 3 people
  assert.match(lines[0], /^﻿?Name,Email,Check-ins,From team/);
  assert.ok(text.includes(',TSA'), 'organization is used as the team');
  assert.ok(text.includes('"Chan, Sophea"'), 'commas inside names must be quoted');
  assert.ok(text.includes('សុខ ដារ៉ា'), 'Khmer names must survive');
});

test('present participants export only includes people who checked in', async () => {
  const res = await get('/api/export/present.csv');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /participants-present-.*\.csv/);
  const lines = (await res.text()).trim().split('\r\n');
  assert.equal(lines.length, 2); // header + 1 person
  assert.match(lines[0], /^﻿?Name,Email,Check-ins,From team,"\w{3}, \w{3} \d+, \d{4}"/);
  assert.match(lines[1], /,1,[^,]*,\d{1,2}:\d{2} (AM|PM)/);
});

test('attendance log export has one row per check-in', async () => {
  const res = await get('/api/export/attendance.csv');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attendance-log-.*\.csv/);
  const lines = (await res.text()).trim().split('\r\n');
  assert.equal(lines.length, 2); // header + 1 check-in
  assert.match(lines[0], /date,weekday,time,check_in_number_that_day,id,name,email/);
  assert.match(lines[1], /^\d{4}-\d{2}-\d{2},\w+day,\d{1,2}:\d{2} (AM|PM),1,/);
});

test('the same person can check in again later, and on other days', async () => {
  const store = require('../lib/store');
  const added = await (await post('/api/participants', { name: 'Multi Day', email: 'multi@example.com' })).json();
  const rec = store.findById(added.id);
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const twoMinAgo = new Date(Date.now() - 120 * 1000).toISOString();
  rec.checkins.push(yesterday, twoMinAgo); // attended yesterday, and once today already
  const r = await (await post('/api/checkin', { code: added.id })).json();
  assert.equal(r.status, 'checked_in', 'a later scan counts as a new check-in');
  assert.equal(r.participant.checkins.length, 3);
  assert.equal(r.participant.days_attended, new Date(yesterday).getDate() === new Date().getDate() ? 1 : 2);
  // Remove one check-in by its time
  const del = await fetch(`${base}/api/participants/${added.id}/checkins`, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ at: yesterday }),
  });
  assert.equal(del.status, 200);
  assert.equal((await del.json()).checkins.length, 2);
  const stats = await (await get('/api/stats')).json();
  assert.ok(Array.isArray(stats.days) && stats.days.length >= 1);
  assert.ok(stats.recent[0].name);
  await fetch(`${base}/api/participants/${added.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' });
});

test('old data files with one check-in are upgraded', () => {
  const store = require('../lib/store');
  const old = { id: 'AAAAAAAAAA', name: 'Old', email: 'o@x.com', checked_in: true, checked_in_at: '2025-01-01T09:00:00.000Z' };
  const p = store.upgrade({ ...old });
  assert.deepEqual(p.checkins, [old.checked_in_at]);
  assert.equal(p.checked_in, undefined);
  assert.deepEqual(store.upgrade({ id: 'B', checked_in: false, checked_in_at: null }).checkins, []);
});

test('email preview shows the right person with placeholders filled in', async () => {
  const res = await post('/api/email/preview', { subject: 'Ticket for {{name}}', body: 'Hi {{name}} ({{email}}) from {{organization}}\n{{qr}}', index: 1 });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.total, 3);
  assert.equal(data.index, 1);
  assert.equal(data.subject, 'Ticket for Chan, Sophea');
  assert.match(data.html, /Hi Chan, Sophea \(sophea@example.com\) from MPTC/);
  assert.match(data.html, /data:image\/png;base64,/);
});

test('sending without Gmail set up gives a clear message', async () => {
  const cfg = await (await get('/api/config')).json();
  assert.equal(cfg.emailConfigured, false);
  assert.deepEqual(cfg.missingEmailSettings, ['GMAIL_USER', 'GMAIL_APP_PASSWORD']);
  const res = await post('/api/email/send', { subject: 'x', body: 'y' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Gmail/);
});

test('background sending saves qr_sent, records failures, and a retry only sends to the rest', async () => {
  const mailer = require('../lib/mailer');
  const sentTo = [];
  // Fake Gmail: fails for anyone whose address starts with "bad".
  mailer._setTransporter({
    sendMail: async (msg) => {
      if (msg.to.address.includes('bad')) throw Object.assign(new Error('Mailbox not found'), { code: 'EENVELOPE' });
      sentTo.push(msg.to.address);
    },
  });
  const people = [
    { id: 'A1', name: 'Good One', email: 'good1@example.com', qr_sent: false },
    { id: 'B2', name: 'Bad One', email: 'bad@example.com', qr_sent: false },
    { id: 'C3', name: 'Good Two', email: 'good2@example.com', qr_sent: false },
  ];
  const fakeStore = { save() {} };
  const waitForJob = async () => { while (mailer.job.running) await new Promise((r) => setTimeout(r, 5)); };

  mailer.startJob(people, 'Hi {{name}}', 'Your QR', fakeStore);
  await waitForJob();
  assert.equal(mailer.job.sent, 2);
  assert.equal(mailer.job.failed, 1);
  assert.equal(mailer.job.failures[0].email, 'bad@example.com');
  assert.match(mailer.job.failures[0].error, /Mailbox not found/);
  assert.deepEqual(people.map((p) => p.qr_sent), [true, false, true]);

  // Retry: only people without qr_sent.
  sentTo.length = 0;
  people[1].email = 'fixed@example.com';
  mailer.startJob(people.filter((p) => !p.qr_sent), 'Hi', 'Your QR', fakeStore);
  await waitForJob();
  assert.equal(sentTo.length, 1);
  assert.match(sentTo[0], /fixed@example.com/);
  assert.ok(people.every((p) => p.qr_sent));
});

// ======================= Security tests =======================

test('security: requests from another website (CSRF) are blocked', async () => {
  const evil = await post('/api/checkin', { code: 'X' }, { Origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  // A plain HTML form post (not JSON) is refused too.
  const form = await fetch(base + '/api/checkin', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'code=X',
  });
  assert.equal(form.status, 415);
});

test('security: unknown Host names are refused (DNS rebinding)', async () => {
  const http = require('http');
  const status = await new Promise((resolve) => {
    http.get({ host: 'localhost', port: server.address().port, path: '/', headers: { Host: 'evil.example' } },
      (res) => { res.resume(); resolve(res.statusCode); });
  });
  assert.equal(status, 421);
});

test('security: protective headers are sent', async () => {
  const res = await get('/');
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-powered-by'), null);
  assert.equal((await get('/api/stats')).headers.get('cache-control'), 'no-store');
});

test('security: spreadsheet formulas in names are neutralised in exports', async () => {
  const res = await post('/api/participants', { name: '=HYPERLINK("http://evil")', email: 'formula@example.com' });
  assert.equal(res.status, 201);
  const text = await (await get('/api/export/all.csv')).text();
  assert.ok(text.includes(`"'=HYPERLINK(""http://evil"")"`));
});

test('security: a CSV column named __proto__ cannot pollute objects', async () => {
  const res = await post('/api/participants/import', { csv: 'name,email,__proto__\nProto,proto@example.com,evil\n' });
  assert.equal(res.status, 200);
  assert.equal({}.polluted, undefined);
});

test('deleting everything needs DELETE typed to confirm', async () => {
  const del = (body) => fetch(base + '/api/participants', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await del({})).status, 400);
  assert.equal((await del({ confirm: 'DELETE' })).status, 200);
  assert.equal((await (await get('/api/participants')).json()).length, 0);
});

test('email preview includes Cc and Bcc, and rejects invalid addresses', async () => {
  await post('/api/participants', { name: 'Cc Test', email: 'cctest@example.com' });
  const ok = await post('/api/email/preview', { subject: 'Hi', body: 'Hello', cc: ['Boss@Example.com'], bcc: 'a@example.com, b@example.com' });
  const data = await ok.json();
  assert.equal(ok.status, 200);
  assert.deepEqual(data.cc, ['boss@example.com']);
  assert.deepEqual(data.bcc, ['a@example.com', 'b@example.com']);
  const bad = await post('/api/email/preview', { subject: 'Hi', body: 'Hello', cc: ['not-an-email'] });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /Cc/);
});

test('background sending copies Cc/Bcc on every email', async () => {
  const mailer = require('../lib/mailer');
  const seen = [];
  mailer._setTransporter({ sendMail: async (msg) => seen.push(msg) });
  const people = [
    { id: 'A1', name: 'One', email: 'one@example.com', qr_sent: false },
    { id: 'B2', name: 'Two', email: 'two@example.com', qr_sent: false },
  ];
  mailer.startJob(people, 'Hi', 'QR', { save() {} }, { cc: ['cc@example.com'], bcc: ['bcc@example.com'] });
  while (mailer.job.running) await new Promise((r) => setTimeout(r, 5));
  assert.equal(seen.length, 2);
  assert.ok(seen.every((m) => m.cc[0] === 'cc@example.com' && m.bcc[0] === 'bcc@example.com'));
  // "Send test to me" never copies Cc/Bcc.
  seen.length = 0;
  const email = await mailer.buildEmail(people[0], 'Hi', 'QR', { cc: ['cc@example.com'], bcc: [] });
  await mailer.send(email, 'me@example.com');
  assert.equal(seen[0].to, 'me@example.com');
  assert.equal(seen[0].cc, undefined);
});

test('connect Gmail rejects a normal password before contacting Google', async () => {
  const res = await post('/api/email/settings', { gmailUser: 'me@gmail.com', appPassword: 'my normal password1' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /App Password/);
  const env = fs.existsSync(process.env.ENV_FILE) ? fs.readFileSync(process.env.ENV_FILE, 'utf8') : '';
  assert.ok(!env.includes('GMAIL_USER'), 'nothing saved on failure');
});

test('.env writer updates keys and keeps other lines', () => {
  const { setEnvValues } = require('../lib/envfile');
  const file = path.join(tmpDir, 'writer.env');
  fs.writeFileSync(file, '# comment\nPORT=3000\nGMAIL_USER=old@gmail.com\n');
  setEnvValues(file, { GMAIL_USER: 'new@gmail.com', FROM_NAME: 'Open Data Team' });
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text, '# comment\nPORT=3000\nGMAIL_USER=new@gmail.com\nFROM_NAME="Open Data Team"\n');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('one participant can be deleted on their own', async () => {
  const a = await (await post('/api/participants', { name: 'Keep Me', email: 'keep@example.com' })).json();
  const b = await (await post('/api/participants', { name: 'Delete Me', email: 'deleteme@example.com' })).json();
  const res = await fetch(`${base}/api/participants/${b.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 200);
  const ids = (await (await get('/api/participants')).json()).map((p) => p.id);
  assert.ok(ids.includes(a.id));
  assert.ok(!ids.includes(b.id));
  const again = await fetch(`${base}/api/participants/${b.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(again.status, 404);
});

test('{{qr}} puts the QR code where it is typed; without it there is no QR image in the message', async () => {
  const mailer = require('../lib/mailer');
  const p = { id: 'ABCDEF1234', name: 'Q', email: 'q@example.com' };
  const middle = await mailer.buildEmail(p, 'Hi', 'Top text\n{{qr}}\nBottom text');
  assert.ok(middle.html.indexOf('Top text') < middle.html.indexOf('<img'));
  assert.ok(middle.html.indexOf('<img') < middle.html.indexOf('Bottom text'));
  assert.ok(!middle.html.includes('{{qr}}'));
  assert.match(middle.text, /Top text\n\[Your QR code is attached/);
  const none = await mailer.buildEmail(p, 'Hi', 'Only text');
  assert.ok(!none.html.includes('<img'));
  assert.equal(none.attachments.length, 2, 'QR is still attached as a file');
});

test('preview and send skip removed people and use per-person edits', async () => {
  const list = await (await get('/api/participants')).json();
  assert.ok(list.length >= 2);
  const [first, second] = list;
  const body = {
    subject: 'Main', body: 'Main text', onlyUnsent: false,
    exclude: [first.id],
    overrides: { [second.id]: { subject: 'Just for you', body: 'Special {{qr}} text' } },
  };
  const r = await (await post('/api/email/preview', { ...body, index: 0 })).json();
  assert.equal(r.participant.id, second.id, 'removed person is skipped');
  assert.equal(r.total, list.length - 1);
  assert.equal(r.subject, 'Just for you');
  assert.equal(r.edited, true);
  assert.match(r.html, /Special/);

  const bad = await post('/api/email/preview', { ...body, overrides: { [second.id]: { subject: '', body: 'x' } } });
  assert.equal(bad.status, 400);

  const mailer = require('../lib/mailer');
  const seen = [];
  mailer._setTransporter({ sendMail: async (msg) => seen.push(msg) });
  const people = [{ id: 'A1', name: 'One', email: 'one@example.com' }, { id: 'B2', name: 'Two', email: 'two@example.com' }];
  mailer.startJob(people, 'Main', 'Main text', { save() {} }, { overrides: { B2: { subject: 'Custom', body: 'Custom text' } } });
  while (mailer.job.running) await new Promise((res) => setTimeout(res, 5));
  assert.equal(seen[0].subject, 'Main');
  assert.equal(seen[1].subject, 'Custom');
});

// ---------------- Login ----------------

test('login: without logging in, pages go to the login page and the API says 401', async () => {
  const page = await fetch(base + '/', { anonymous: true, redirect: 'manual' });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/login.html');
  const api = await fetch(base + '/api/participants', { anonymous: true });
  assert.equal(api.status, 401);
  const exp = await fetch(base + '/api/export/all.csv', { anonymous: true });
  assert.equal(exp.status, 401, 'exports are protected');
  const login = await fetch(base + '/login.html', { anonymous: true });
  assert.equal(login.status, 200, 'the login page itself is public');
  const forged = await fetch(base + '/api/participants', { anonymous: true, headers: { Cookie: 'session=eyJ1IjoiYWRtaW4ifQ.fake' } });
  assert.equal(forged.status, 401, 'a made-up cookie is rejected');
});

test('login: the password is stored as a hash, never as text', () => {
  const env = fs.readFileSync(process.env.ENV_FILE, 'utf8');
  assert.ok(!env.includes('correct horse'));
  assert.match(env, /ADMIN_PASSWORD_HASH=scrypt\$/);
});

test('login: a second account cannot be created', async () => {
  const res = await post('/api/auth/setup', { username: 'evil', password: 'password123' });
  assert.equal(res.status, 409);
});

test('login: right password logs in, wrong one is refused, then locked after 5 tries', async () => {
  const login = (password) => fetch(base + '/api/auth/login', {
    anonymous: true, method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'Admin', password }),
  });
  const ok = await login('correct horse');
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const list = await fetch(base + '/api/participants', { anonymous: true, headers: { Cookie: cookie.split(';')[0] } });
  assert.equal(list.status, 200);

  for (let i = 0; i < 5; i++) assert.equal((await login('wrong password')).status, 401);
  const locked = await login('correct horse');
  assert.equal(locked.status, 429, 'locked even with the right password after 5 wrong tries');
  require('../lib/auth').clearFails('::1');
  require('../lib/auth').clearFails('::ffff:127.0.0.1');
  require('../lib/auth').clearFails('127.0.0.1');
});

test('login: changing the password logs out old sessions', async () => {
  const oldCookie = sessionCookie;
  const res = await post('/api/auth/password', { current: 'correct horse', password: 'new password 1' });
  assert.equal(res.status, 200);
  sessionCookie = res.headers.get('set-cookie').split(';')[0];
  const old = await fetch(base + '/api/participants', { anonymous: true, headers: { Cookie: oldCookie } });
  assert.equal(old.status, 401, 'the old session no longer works');
  assert.equal((await get('/api/participants')).status, 200, 'the new session works');
});
