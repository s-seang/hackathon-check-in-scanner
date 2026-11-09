// ---------------------------------------------------------------
// csv.js — reading the participant CSV and writing export CSVs.
// ---------------------------------------------------------------

const { parse } = require('csv-parse/sync');

// Header names we accept (compared in lowercase, ignoring spaces/underscores).
const NAME_HEADERS = ['name', 'fullname', 'participantname', 'participant'];
const FIRST_NAME_HEADERS = ['firstname', 'givenname'];
const LAST_NAME_HEADERS = ['lastname', 'surname', 'familyname'];
const EMAIL_HEADERS = ['email', 'emailaddress', 'e-mail', 'mail'];

const normalize = (h) => String(h).toLowerCase().replace(/[\s_]/g, '');
// Column names that could change how JavaScript objects behave ("prototype pollution"). Never used as keys.
const UNSAFE_KEYS = ['__proto__', 'constructor', 'prototype'];
const MAX_EXTRA_COLUMNS = 30;
const MAX_EXTRA_VALUE = 500;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Turn CSV text into participant rows.
 * Returns { rows: [{name, email, extra}], errors: [{row, reason}] }.
 * Throws an Error with a friendly message if the file can't be used at all.
 */
function parseParticipantsCsv(text, { maxRows = 20000, maxName = 200, maxEmail = 254 } = {}) {
  let records;
  try {
    records = parse(text, {
      // Read the header line ourselves (below), so a column named "__proto__" can't do harm.
      columns: (header) => header.map((h) => (UNSAFE_KEYS.includes(String(h).trim().toLowerCase()) ? false : h)),
      bom: true, // Excel adds an invisible "BOM" character at the start — strip it
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true, // tolerate rows with a missing/extra cell
    });
  } catch (err) {
    throw new Error(`This doesn't look like a valid CSV file (${err.message}).`);
  }

  if (records.length === 0) {
    throw new Error('The CSV file has no participant rows.');
  }
  if (records.length > maxRows) {
    throw new Error(`The CSV has ${records.length} rows; the maximum is ${maxRows}.`);
  }

  // Work out which column holds the name and which holds the email.
  const headers = Object.keys(records[0]);
  const pick = (options) => headers.find((h) => options.includes(normalize(h)));
  const nameCol = pick(NAME_HEADERS);
  const firstCol = pick(FIRST_NAME_HEADERS);
  const lastCol = pick(LAST_NAME_HEADERS);
  const emailCol = pick(EMAIL_HEADERS);

  if (!emailCol || (!nameCol && !firstCol)) {
    throw new Error(
      `The CSV needs a "name" column and an "email" column. Found columns: ${headers.join(', ')}`
    );
  }

  const used = [nameCol, firstCol, lastCol, emailCol].filter(Boolean);
  const rows = [];
  const errors = [];

  records.forEach((rec, i) => {
    const rowNumber = i + 2; // +1 for the header line, +1 because people count from 1
    const name = nameCol
      ? rec[nameCol]
      : [rec[firstCol], lastCol ? rec[lastCol] : ''].filter(Boolean).join(' ');
    const email = rec[emailCol];

    if (!name) return errors.push({ row: rowNumber, reason: 'Missing name' });
    if (!email) return errors.push({ row: rowNumber, reason: 'Missing email' });
    if (name.length > maxName) return errors.push({ row: rowNumber, reason: `Name longer than ${maxName} characters` });
    if (email.length > maxEmail || !EMAIL_RE.test(email)) {
      return errors.push({ row: rowNumber, reason: `Invalid email "${email.slice(0, 80)}"` });
    }

    // Keep any other columns (organization, phone, …) so they show up in the exports.
    const extra = {};
    for (const h of headers.slice(0, MAX_EXTRA_COLUMNS + used.length)) {
      if (!used.includes(h) && h) extra[h] = String(rec[h] ?? '').slice(0, MAX_EXTRA_VALUE);
    }
    rows.push({ name, email, extra });
  });

  return { rows, errors };
}

/**
 * Escape one value for CSV: wrap in quotes if it contains a comma, quote, or line break.
 *
 * Security: a cell starting with = + - @ is run as a FORMULA by Excel/Sheets.
 * A participant named  =HYPERLINK("http://evil...")  could attack whoever opens
 * the export. Putting a ' in front makes the spreadsheet show it as plain text.
 */
function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const pad = (n) => String(n).padStart(2, '0');
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const BOM = '\uFEFF'; // so Excel opens non-English names (e.g. Khmer) correctly

/** "12:50 PM" (this computer's clock). */
function time12(iso) {
  const d = new Date(iso);
  const h = d.getHours() % 12 || 12;
  return `${h}:${pad(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
}
/** "2026-11-08" → "Sun, Nov 8, 2026" */
function dayLabel(key) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return `${WEEKDAYS[date.getDay()].slice(0, 3)}, ${MONTHS[m - 1]} ${d}, ${y}`;
}

/**
 * Build CSV text from participants (already passed through store.view).
 * Same columns as the Participants page, then one column per event day
 * listing every check-in time that day, e.g. "8:31 AM; 1:02 PM".
 */
function participantsToCsv(list, dayKey) {
  const dayCols = [...new Set(list.flatMap((p) => p.checkins.map(dayKey)))].sort();
  const header = ['Name', 'Email', 'Check-ins', 'Last check-in', 'Today', ...dayCols.map(dayLabel)];
  const lines = [header.map(csvCell).join(',')];
  for (const p of list) {
    lines.push(
      [
        p.name,
        p.email,
        p.checkins.length,
        p.checked_in_at ? `${dayLabel(dayKey(p.checked_in_at))} ${time12(p.checked_in_at)}` : '',
        p.checked_in ? 'Present' : 'Not yet',
        ...dayCols.map((d) => p.checkins.filter((c) => dayKey(c) === d).sort().map(time12).join('; ')),
      ]
        .map(csvCell)
        .join(',')
    );
  }
  return BOM + lines.join('\r\n') + '\r\n';
}

/** One row per check-in, in time order: date, weekday, time, and which check-in of that day it was. */
function attendanceToCsv(list, dayKey) {
  const rows = list
    .flatMap((p) => p.checkins.map((at) => ({ at, p })))
    .sort((a, b) => a.at.localeCompare(b.at));
  const countPerDay = new Map();
  const lines = [['date', 'weekday', 'time', 'check_in_number_that_day', 'id', 'name', 'email'].join(',')];
  for (const { at, p } of rows) {
    const key = `${p.id}|${dayKey(at)}`;
    countPerDay.set(key, (countPerDay.get(key) || 0) + 1);
    lines.push([dayKey(at), WEEKDAYS[new Date(at).getDay()], time12(at), countPerDay.get(key), p.id, p.name, p.email].map(csvCell).join(','));
  }
  return BOM + lines.join('\r\n') + '\r\n';
}

module.exports = { parseParticipantsCsv, participantsToCsv, attendanceToCsv, EMAIL_RE };
