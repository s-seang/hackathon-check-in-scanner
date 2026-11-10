# Security

This app holds personal data (names and emails) and can send email from your Gmail account.
**Everyone must log in** before they can see any page or data. On top of that, by default
**only the laptop running the app can open it**.

## Login

- On the first visit, the laptop running the app shows **Create your account**: choose a username and a password (8+ characters).
  This can only be done on that laptop, so nobody else on the network can claim the account.
- After that, every page, export and API call needs a login. Without one, you are sent to the login page.
- The password is saved in `.env` as a **scrypt hash** (`ADMIN_PASSWORD_HASH`), never as plain text.
- A login lasts **12 hours**, in an `HttpOnly`, `SameSite=Strict` cookie signed with `SESSION_SECRET` (made automatically in `.env`).
- After **5 wrong passwords**, that device must wait 15 minutes.
- **Change password** is at the bottom of the sidebar. It logs out every other device.
- **Forgot the password?** Stop the app, delete the `ADMIN_USER` and `ADMIN_PASSWORD_HASH` lines from `.env`, start it again,
  and create a new account on the laptop.

## Quick checklist before the event

- [ ] Keep `HOST=127.0.0.1` (the default) unless other devices really need to connect.
- [ ] Use a strong password, and only share it with staff who need it.
- [ ] Lock the laptop and **Log out** when you step away.
- [ ] Never share or commit `.env`. It contains your Gmail App Password.
- [ ] After the event: export what you need, delete the participants, and remove the Gmail App Password at https://myaccount.google.com/apppasswords.

## What protects the app

| Protection | What it stops | Where |
|---|---|---|
| **Login required** for every page and API call; hashed password; 5-try lockout | Anyone without the password seeing or changing data | `lib/auth.js`, `server.js` |
| **Only this computer can connect** by default (`HOST=127.0.0.1`) | Other people on the venue Wi‑Fi reaching the app | `server.js` |
| **CSRF protection.** Changes must be same-site JSON requests. | A malicious website you visit secretly using the app from your browser | `csrfCheck()` in `lib/security.js` |
| **Host check** | "DNS rebinding", where a website points its domain at your laptop to read the app | `hostCheck()` |
| **Content Security Policy**: scripts only from this server, no framing | Injected scripts (XSS) and clickjacking | `securityHeaders()` |
| **All participant text is escaped** before it is shown, and email previews run in a sandboxed frame | A participant named `<script>…` running code | `public/app.js` |
| **Spreadsheet formula blocking** in exports | A participant named `=HYPERLINK(...)` attacking whoever opens the CSV in Excel | `csvCell()` in `lib/csv.js` |
| **Email header protection** | A crafted name adding hidden recipients to emails | `oneLine()` in `lib/mailer.js` |
| **Unsafe CSV column names ignored** (`__proto__` etc.) | "Prototype pollution" attacks | `lib/csv.js` |
| **Size limits** on every input, and 600 API requests per minute per device | Overloading the server | `server.js` |
| **Gmail can only be connected from the laptop running the app.** The login is checked with Google first, then saved in `.env`, which only your account can read. | Someone else on the network changing which account sends the emails | `/api/email/settings` in `server.js` |
| **Delete-all needs DELETE typed** | Accidental wiping of the list | `DELETE /api/participants` |
| **Private files**: `data/` is readable only by your user account | Other accounts on the same computer reading data | `lib/store.js` |
| **Short error messages**: details go to the terminal, not the browser | Leaking internal information | error handler in `server.js` |
| **No caching** of API responses | Data left behind in browser caches | `Cache-Control: no-store` |
| **Audit log** in `data/audit.log` | Not knowing what happened. Imports, exports, deletes and email sends are recorded. | `lib/audit.js` |

Run `npm test` to check all of the above.

## Letting other devices connect (door laptops, tablets)

> Other devices need the username and password to get in. Still, prefer a private network you
> control (your own hotspot or router), and turn on HTTPS (step 3) so the password is not sent
> over the Wi‑Fi unencrypted.

1. Find this laptop's IP address (macOS: System Settings → Wi‑Fi → Details; Windows: `ipconfig`), e.g. `192.168.1.20`.
2. In `.env`:
   ```
   HOST=0.0.0.0
   ALLOWED_HOSTS=192.168.1.20
   ```
3. **Turn on HTTPS** (recommended). Without it, data crosses the Wi‑Fi unencrypted, and phone/tablet browsers won't allow camera access.
   The easiest way is [mkcert](https://github.com/FiloSottile/mkcert):
   ```bash
   brew install mkcert          # or see the mkcert page for Windows
   mkcert -install
   mkdir certs
   mkcert -cert-file certs/cert.pem -key-file certs/key.pem 192.168.1.20 localhost 127.0.0.1
   ```
   Then in `.env`:
   ```
   TLS_CERT_FILE=certs/cert.pem
   TLS_KEY_FILE=certs/key.pem
   ```
   Other devices must trust the mkcert root certificate (`mkcert -CAROOT` shows where it is). Otherwise they will see a warning.
4. Restart and open `https://192.168.1.20:3000` on the other device.

## Things to know

- **The QR code contains only a random 10-character ID**, not the person's name or email.
- **Backups**: `data/participants.json` contains personal data. Store copies somewhere private and delete them when no longer needed.
- **Fonts** are loaded from Google Fonts. If the laptop is offline, the app falls back to system fonts. Nothing else is loaded from the internet.
