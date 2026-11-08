// ---------------------------------------------------------------
// store.js — keeps the list of participants and saves it to disk.
//
// We use a plain JSON file (data/participants.json) instead of a
// database so it's easy to understand, back up, and inspect.
// Every change is written to disk right away, so nothing is lost
// if the server is stopped.
// ---------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Tests point DATA_FILE at a temporary file so real data is never touched.
const DATA_FILE =
  process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'participants.json');

let participants = [];

/** Load participants from disk (called once when the server starts). */
function load() {
  try {
    participants = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      participants = []; // First run: no file yet, start empty.
    } else {
      // Don't silently start empty — that would overwrite the real data on the next save.
      throw new Error(
        `Could not read ${DATA_FILE}: ${err.message}. Fix or move the file, then restart.`
      );
    }
  }
}

/** Save participants to disk. Writes to a temp file first, so a crash can't leave a half-written file. */
function save() {
  // mode 0o700 / 0o600 = only your user account on this computer can read the data.
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true, mode: 0o700 });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(participants, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, DATA_FILE);
}

/** A short random ID. This is what goes inside each participant's QR code. */
function newId() {
  let id;
  do {
    id = crypto.randomBytes(5).toString('hex').toUpperCase(); // e.g. "9F2A7C01BE"
  } while (participants.some((p) => p.id === id));
  return id;
}

function all() {
  return participants;
}

function findById(id) {
  const wanted = String(id || '').trim().toUpperCase();
  if (!/^[0-9A-F]{10}$/.test(wanted)) return null; // IDs are always 10 hex characters
  return participants.find((p) => p.id === wanted) || null;
}

function findByEmail(email) {
  const wanted = String(email || '').trim().toLowerCase();
  return participants.find((p) => p.email.toLowerCase() === wanted) || null;
}

/** Add one participant. Returns the new record. Caller is responsible for calling save(). */
function add({ name, email, extra = {} }) {
  const p = {
    id: newId(),
    name: name.trim(),
    email: email.trim(),
    extra, // any other CSV columns (e.g. organization), kept for exports
    checked_in: false,
    checked_in_at: null,
    qr_sent: false,
    qr_sent_at: null,
    qr_error: null, // last email error, if sending failed
    created_at: new Date().toISOString(),
  };
  participants.push(p);
  return p;
}

function removeAll() {
  participants = [];
  save();
}

function stats() {
  return {
    total: participants.length,
    checkedIn: participants.filter((p) => p.checked_in).length,
    qrSent: participants.filter((p) => p.qr_sent).length,
    qrFailed: participants.filter((p) => !p.qr_sent && p.qr_error).length,
  };
}

module.exports = { load, save, all, findById, findByEmail, add, removeAll, stats, DATA_FILE };
