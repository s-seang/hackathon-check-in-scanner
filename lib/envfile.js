// ---------------------------------------------------------------
// envfile.js — save settings into the .env file.
//
// Used by the "Connect Gmail" form, so you don't have to edit .env by hand.
// Existing lines and comments are kept; only the given keys are changed.
// ---------------------------------------------------------------

const fs = require('fs');

/** Turn a value into a safe .env value (one line, quoted if it has spaces). */
function formatValue(value) {
  const v = String(value).replace(/[\r\n"]/g, '').trim();
  return /[\s#'=]/.test(v) ? `"${v}"` : v;
}

/**
 * Set KEY=value lines in the .env file (creating the file if needed).
 * @param {string} file    path to .env
 * @param {object} values  e.g. { GMAIL_USER: 'me@gmail.com' }
 */
function setEnvValues(file, values) {
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const remaining = { ...values };
  lines = lines.map((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m && m[1] in remaining) {
      const out = `${m[1]}=${formatValue(remaining[m[1]])}`;
      delete remaining[m[1]];
      return out;
    }
    return line;
  });
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const [k, v] of Object.entries(remaining)) lines.push(`${k}=${formatValue(v)}`);
  // 0o600 = only your user account can read it (it contains the Gmail app password).
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

module.exports = { setEnvValues, formatValue };
