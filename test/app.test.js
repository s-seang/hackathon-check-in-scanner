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

const app = require('../server');

let server;
let base;

before(async () => {
  server = app.listen(0); // 0 = any free port
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
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
  assert.match(lines[0], /^﻿?id,name,email,Organization,checked_in/);
  assert.ok(text.includes('"Chan, Sophea"'), 'commas inside names must be quoted');
  assert.ok(text.includes('សុខ ដារ៉ា'), 'Khmer names must survive');
});

test('export of checked-in participants only includes checked-in people', async () => {
  const res = await get('/api/export/checked-in.csv');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /participants-checked-in-.*\.csv/);
  const lines = (await res.text()).trim().split('\r\n');
  assert.equal(lines.length, 2); // header + 1 person
  assert.match(lines[1], /,yes,/);
});

test('email preview shows the right person with placeholders filled in', async () => {
  const res = await post('/api/email/preview', { subject: 'Ticket for {{name}}', body: 'Hi {{name}} ({{email}}) from {{organization}}', index: 1 });
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
  assert.ok(!fs.existsSync(process.env.ENV_FILE), 'nothing saved on failure');
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
