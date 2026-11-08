// ---------------------------------------------------------------
// audit.js — a simple security log (data/audit.log).
//
// Every import, export, delete and email send is written here as
// one JSON line, so you can see what happened and when.
// ---------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { DATA_FILE } = require('./store');

const AUDIT_FILE = path.join(path.dirname(DATA_FILE), 'audit.log');

/**
 * Record one event.
 * @param {object} req     the request (for the IP address); may be null
 * @param {string} action  short name, e.g. "export_all"
 * @param {object} details any extra info
 */
function audit(req, action, details = {}) {
  const entry = {
    time: new Date().toISOString(),
    action,
    ip: req ? req.ip : null,
    ...details,
  };
  try {
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true, mode: 0o700 });
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch (err) {
    console.error('Could not write audit log:', err.message);
  }
}

module.exports = { audit, AUDIT_FILE };
