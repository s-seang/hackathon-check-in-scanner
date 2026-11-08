// ---------------------------------------------------------------
// security.js — protections that work without any login.
//
//  1. Rate limit         stops one device flooding the server
//  2. Request checks     blocks other websites from using the app
//                        (CSRF and DNS-rebinding attacks)
//  3. Security headers   tells the browser to lock the page down
// ---------------------------------------------------------------

// ================= 1. Rate limit =================

// General limit for all API calls, against floods (very generous for normal use).
const API_MAX_PER_MINUTE = 600;
const apiCounts = new Map(); // ip → { count, windowStart }
function apiRateLimit(req, res, next) {
  const now = Date.now();
  let c = apiCounts.get(req.ip);
  if (!c || now - c.windowStart > 60_000) {
    c = { count: 0, windowStart: now };
    apiCounts.set(req.ip, c);
  }
  if (++c.count > API_MAX_PER_MINUTE) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: 'Too many requests. Please wait a minute.' });
  }
  next();
}

// ================= 2. Request checks =================

/**
 * Host check (blocks "DNS rebinding"): a malicious website could point its own
 * domain name at 127.0.0.1 to read this app. We only answer to names we know.
 */
function hostCheck(allowedHosts) {
  const allowed = new Set(['localhost', '127.0.0.1', '[::1]', ...allowedHosts.map((h) => h.toLowerCase())]);
  return (req, res, next) => {
    const host = String(req.headers.host || '').toLowerCase();
    // Remove the ":port" at the end (keeping IPv6 "[::1]" intact).
    const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
    if (!allowed.has(hostname)) {
      return res.status(421).type('text').send(
        `This server does not answer to "${hostname}". Add it to ALLOWED_HOSTS in .env if you trust it.`
      );
    }
    next();
  };
}

/**
 * CSRF check: requests that change data must
 *  - come from this same site (Origin header, if the browser sends one), and
 *  - be JSON (normal HTML forms on other websites can't send JSON).
 */
function csrfCheck(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const origin = req.headers.origin;
  if (origin) {
    const expected = `${req.protocol}://${req.headers.host}`;
    if (origin !== expected) {
      return res.status(403).json({ error: 'Blocked: request came from another website.' });
    }
  }
  if (!req.is('application/json')) {
    return res.status(415).json({ error: 'Requests must be sent as JSON.' });
  }
  next();
}

// ================= 3. Security headers =================

/**
 * Content Security Policy = a list of what the page is allowed to load.
 * Scripts may only come from this server, so even if someone sneaks HTML into a
 * participant's name, the browser won't run it.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // 'unsafe-inline' is only for styles (the email preview uses inline styles); scripts stay strict.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff'); // don't guess file types
  res.setHeader('X-Frame-Options', 'DENY'); // can't be put inside another site's frame (clickjacking)
  res.setHeader('Referrer-Policy', 'no-referrer'); // don't leak URLs to other sites
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  // Participant data should never be stored in browser or proxy caches.
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
}

module.exports = { apiRateLimit, hostCheck, csrfCheck, securityHeaders };
