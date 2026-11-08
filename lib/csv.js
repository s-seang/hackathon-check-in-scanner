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

/**
 * Build CSV text from participants.
 * Starts with a BOM so Excel opens non-English names (e.g. Khmer) correctly.
 */
function participantsToCsv(list) {
  // Collect every extra column that appears in any row.
  const extraCols = [...new Set(list.flatMap((p) => Object.keys(p.extra || {})))];
  const header = ['id', 'name', 'email', ...extraCols, 'checked_in', 'checked_in_at', 'qr_sent', 'qr_sent_at'];
  const lines = [header.map(csvCell).join(',')];
  for (const p of list) {
    lines.push(
      [
        p.id,
        p.name,
        p.email,
        ...extraCols.map((c) => (p.extra || {})[c]),
        p.checked_in ? 'yes' : 'no',
        p.checked_in_at || '',
        p.qr_sent ? 'yes' : 'no',
        p.qr_sent_at || '',
      ]
        .map(csvCell)
        .join(',')
    );
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

module.exports = { parseParticipantsCsv, participantsToCsv, EMAIL_RE };
