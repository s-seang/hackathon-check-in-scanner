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
    participants.forEach(upgrade);
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

/**
 * Older data files had one check-in per person (checked_in / checked_in_at).
 * Now every scan is kept in `checkins` (a list of times), so people can check in many times, on many days.
 */
function upgrade(p) {
  if (!Array.isArray(p.checkins)) p.checkins = p.checked_in_at ? [p.checked_in_at] : [];
  delete p.checked_in;
  delete p.checked_in_at;
  return p;
}

const pad = (n) => String(n).padStart(2, '0');
/** The calendar day of a time, on this computer's clock, like "2026-11-25". */
function dayKey(time) {
  const d = new Date(time);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const today = () => dayKey(new Date());

/**
 * A participant plus a summary of their attendance, for the web page and exports:
 * checked_in = checked in at least once today.
 */
function view(p) {
  const t = today();
  const todayCount = p.checkins.filter((c) => dayKey(c) === t).length;
  return {
    ...p,
    checked_in: todayCount > 0,
    checked_in_at: p.checkins[p.checkins.length - 1] || null, // most recent check-in
    checkins_today: todayCount,
    days_attended: new Set(p.checkins.map(dayKey)).size,
  };
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
    checkins: [], // the time of every check-in (scan)
    qr_sent: false,
    qr_sent_at: null,
    qr_error: null, // last email error, if sending failed
    created_at: new Date().toISOString(),
  };
  participants.push(p);
  return p;
}

/** Remove one participant by ID. Returns the removed record, or null. */
function remove(id) {
  const p = findById(id);
  if (!p) return null;
  participants = participants.filter((x) => x !== p);
  save();
  return p;
}

function removeAll() {
  participants = [];
  save();
}

function stats() {
  const t = today();
  const all = participants.flatMap((p) => p.checkins.map((at) => ({ at, day: dayKey(at), p })));
  // Attendance per day: how many people came, and how many scans in total.
  const byDay = new Map();
  for (const c of all) {
    const d = byDay.get(c.day) || { day: c.day, people: new Set(), checkins: 0 };
    d.people.add(c.p.id);
    d.checkins++;
    byDay.set(c.day, d);
  }
  const days = [...byDay.values()]
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((d) => ({ day: d.day, people: d.people.size, checkins: d.checkins }));
  const recent = all
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 8)
    .map((c) => ({ id: c.p.id, name: c.p.name, at: c.at }));
  const todayInfo = days.find((d) => d.day === t);
  return {
    today: t,
    total: participants.length,
    checkedIn: todayInfo ? todayInfo.people : 0, // people present today
    checkinsToday: todayInfo ? todayInfo.checkins : 0,
    days,
    recent,
    qrSent: participants.filter((p) => p.qr_sent).length,
    qrFailed: participants.filter((p) => !p.qr_sent && p.qr_error).length,
  };
}

module.exports = { load, save, all, findById, findByEmail, add, remove, removeAll, stats, view, dayKey, upgrade, DATA_FILE };
