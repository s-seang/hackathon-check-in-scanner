// login.js — the login page (and the "create account" form on first use).

const $ = (sel) => document.querySelector(sel);
let creating = false; // true = first visit, creating the admin account

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function start() {
  let s;
  try {
    s = await (await fetch('/api/auth/status')).json();
  } catch {
    $('#login-sub').textContent = 'Cannot reach the server. Is it still running (npm start)?';
    return;
  }
  if (s.user) return location.replace('/'); // already logged in

  if (!s.accountExists) {
    if (!s.canCreateAccount) {
      $('#login-title').textContent = 'Not set up yet';
      $('#login-sub').textContent = '';
      $('#login-blocked').textContent = 'Open this app on the laptop that runs it to create the admin account first. Then you can log in here.';
      $('#login-blocked').classList.remove('hidden');
      return;
    }
    creating = true;
    $('#login-title').textContent = 'Create your account';
    $('#login-sub').textContent = 'First time here. Choose a username and password. Everyone will need them to open this app.';
    $('#password').autocomplete = 'new-password';
    $('#password').placeholder = 'At least 8 characters';
    $('#confirm-wrap').classList.remove('hidden');
    $('#password2').required = true;
    $('#login-btn').textContent = 'Create account';
  }
  $('#login-form').classList.remove('hidden');
  $('#username').focus();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#login-error');
  const btn = $('#login-btn');
  err.textContent = '';
  const body = { username: $('#username').value.trim(), password: $('#password').value };
  if (creating && body.password !== $('#password2').value) {
    err.textContent = 'The two passwords are not the same.';
    return;
  }
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = creating ? 'Creating…' : 'Logging in…';
  try {
    await post(creating ? '/api/auth/setup' : '/api/auth/login', body);
    location.replace('/');
  } catch (ex) {
    err.textContent = ex.message;
    $('#password').value = '';
    $('#password').focus();
    btn.disabled = false;
    btn.textContent = label;
  }
});

// Show / hide password
document.querySelectorAll('.pw-toggle').forEach((b) =>
  b.addEventListener('click', () => {
    const input = document.getElementById(b.dataset.for);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    b.textContent = show ? 'Hide' : 'Show';
  })
);

start();
