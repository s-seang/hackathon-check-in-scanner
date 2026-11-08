# Event QR Check-in

A small web app for running check-in at an event:

1. **Import** your participant list from a CSV file.
2. **Email** every participant their own QR code (through Gmail).
3. **Scan** QR codes at the door with the laptop camera (or a USB scanner) to check people in.
4. **Export** the full list or only the people who checked in, as CSV.

Everything runs on your own laptop. Participant data is saved in `data/participants.json`.
There is no login. By default only the laptop running the app can open it. See **[SECURITY.md](SECURITY.md)**.

---

## How to run it

You need **Node.js 18 or newer**. Check with `node -v`, or download it from https://nodejs.org.

```bash
# 1. Install the libraries (only the first time)
npm install

# 2. Start the app
npm start
```

3. Open **http://localhost:3000** in Chrome, Edge or Safari.

To stop the app, press `Ctrl + C` in the terminal.

> Gmail is only needed for "Send QR Codes". You connect it inside the app (see below), so there's no file to edit.
> A `.env` file is optional, for other settings (copy `.env.example` to `.env`).

---

## Create a Gmail App Password

Gmail does not let apps log in with your normal password. You need an **App Password** instead:

1. Go to https://myaccount.google.com/security and turn on **2-Step Verification** (required).
2. Go to https://myaccount.google.com/apppasswords
3. Type a name such as `Event check-in` and click **Create**.
4. Google shows a 16-letter password like `abcd efgh ijkl mnop`. Copy it.
5. In the app, open **Send QR Codes** and fill in **Connect Gmail**: your Gmail address, the App Password, and a sender name.
   Click **Connect**. The app checks the login with Google and saves it in `.env` on this laptop. No restart needed.
   To switch accounts later, click **Change** next to "Sending from".

Notes:
- If you don't see the App Passwords page, your account may be a school or work account where the admin has turned it off. Use a personal Gmail account instead.
- A normal Gmail account can send about **500 emails per day**. Google Workspace accounts can send more.

---

## The CSV file

The first line must contain the column names. You need a `name` column and an `email` column:

```csv
name,email,organization
Sok Dara,dara@example.com,TSA
Chan Sophea,sophea@example.com,MPTC
```

- `first name` + `last name` columns also work instead of `name`.
- Extra columns (like `organization`) are kept. They show up in the exports and can be used in emails as `{{organization}}`.
- Rows with a missing or invalid email are skipped and listed so you can fix them.
- A person whose email is already in the list is skipped, so importing the same file twice is safe.
- From Excel: **File → Save As → CSV UTF-8**.

A sample file is in `public/sample-participants.csv` (also downloadable from the Import page).

---

## Using it at the event

### Sending QR codes (before the event)
1. Go to **Send QR Codes** and connect Gmail (once).
2. **To:** choose **Not sent yet** (usual) or **Everyone**. Click **Cc** / **Bcc** to copy other addresses on every email (type an address and press Enter).
3. Write a subject and message. Use the **Insert** buttons for `{{name}}`, `{{email}}`, `{{id}}` (any CSV column name works too).
4. The preview on the right updates as you type. Use ‹ › (or the arrow keys) to check each person's email, or open **Recipients** and click a name.
5. Click **Send test to me** and check it on your phone. Tests go only to you, never to Cc/Bcc.
6. Click **Send to N people**, check the summary, and confirm. Emails go out one every 1.5 seconds with a live progress bar (sent / failed / left).
7. If some fail, the reason is listed. Click **Retry N unsent** to send only to those who didn't get it.

You can leave the page while sending; it continues on the server. Come back to see progress.

### Check-in (at the door)
1. Click **Check-in Scanner**. The camera opens full screen (allow camera access the first time).
2. Hold up a QR code. A pop-up shows the person's name:
   - **green** "Welcome" → checked in
   - **amber** "Already checked in" → this code was used before (with the time)
   - **red** "Not found" → this code is not in the list
3. No camera? Type the ID at the bottom, or plug in a USB QR scanner (it types the code automatically).
4. Press the **←** arrow (top-left) or `Esc` to leave the scanner.
5. To fix a mistake: **Participants** → **Undo**. Walk-ins: **Participants** → **+ Add**, then **Mark present** or click the QR icon to show their code.

### After the event
On **Participants**, click **Export** → **All participants** or **Present only**. The files open in Excel and Google Sheets.

---

## Settings (`.env`)

| Setting | What it does | Default |
|---|---|---|
| `EVENT_NAME` | Name shown in the app | `Event Check-in` |
| `HOST` | `127.0.0.1` = this laptop only; `0.0.0.0` = other devices too | `127.0.0.1` |
| `ALLOWED_HOSTS` | Extra addresses allowed when `HOST=0.0.0.0`, e.g. `192.168.1.20` | (none) |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | Turn on HTTPS (see SECURITY.md) | (off) |
| `PORT` | Web address port | `3000` |
| `GMAIL_USER` | Gmail address that sends the emails (set by **Connect Gmail**) | (none) |
| `GMAIL_APP_PASSWORD` | Gmail App Password (set by **Connect Gmail**) | (none) |
| `FROM_NAME` | Sender name shown in inboxes | your Gmail address |
| `SEND_DELAY_MS` | Pause between emails, in milliseconds | `1500` |

---

## Running the tests

```bash
npm test
```

This checks that the server starts, that the security protections work, CSV import works (including bad rows and duplicates), check-in works (including "already checked in" and unknown codes), both exports download correctly, email previews fill in placeholders, and the sending loop records sent/failed people correctly. The tests use a temporary data file and never send real email.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Port 3000 is already in use` | Another copy is running. Close it, or set `PORT=3001` in `.env`. |
| "Gmail rejected the login" | Check `GMAIL_USER`, and make sure `GMAIL_APP_PASSWORD` is an App Password, not your normal password. |
| Camera doesn't start | Allow camera access in the browser (click the camera icon in the address bar). The camera only works on `http://localhost`, not from another computer's IP address. |
| I want to start over | Participants page → **Delete all participants** (asks you to type DELETE), or delete `data/participants.json` while the app is stopped. |
| Another device can't connect | By default only this laptop can. See "Letting other devices connect" in SECURITY.md. |
| Who did what? | See `data/audit.log` (imports, exports, deletes, email sends). |
| Backup | Copy `data/participants.json` somewhere safe. |

---

## Project files

```
server.js              the web server and all /api routes
lib/store.js           saves/loads participants (data/participants.json)
lib/csv.js             reads the import CSV, writes the export CSVs
lib/mailer.js          builds each email with its QR code and sends them in the background
lib/security.js        rate limit, CSRF/host checks, security headers
lib/audit.js           security log (data/audit.log)
public/index.html      the page layout
public/styles.css      the look
public/app.js          what the buttons do (scanner, import, email preview, …)
test/app.test.js       automated tests (npm test)
```
# hackathon-check-in-scanner
