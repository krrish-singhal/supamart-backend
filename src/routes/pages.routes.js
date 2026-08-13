// Tiny server-rendered pages for links that go out in emails (password reset).
// The customer app is mobile-only with no web frontend, so this is the simplest
// robust way to let a "Reset your password" email link land somewhere real —
// no app deep-linking / universal-links setup required.
const express = require("express");

const router = express.Router();

router.get("/reset-password", (req, res) => {
  const token = String(req.query.token || "");
  res.set("Content-Type", "text/html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Reset your MS Traders password</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; background: #f8fafc; margin: 0; padding: 24px; display: flex; min-height: 100vh; align-items: center; justify-content: center; }
    .card { background: #fff; border-radius: 20px; padding: 32px; max-width: 380px; width: 100%; box-shadow: 0 8px 30px rgba(0,0,0,0.08); }
    h1 { font-size: 20px; margin: 0 0 20px; color: #0f172a; }
    label { font-size: 13px; font-weight: 600; color: #334155; display: block; margin-bottom: 6px; }
    input { width: 100%; height: 46px; border-radius: 10px; border: 1px solid #e2e8f0; padding: 0 14px; font-size: 15px; box-sizing: border-box; margin-bottom: 16px; }
    button { width: 100%; height: 48px; border-radius: 10px; border: none; background: #16a34a; color: #fff; font-weight: 700; font-size: 15px; cursor: pointer; }
    button:disabled { opacity: 0.6; }
    #msg { margin-top: 14px; font-size: 13px; text-align: center; }
    .error { color: #dc2626; }
    .success { color: #16a34a; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Reset your password</h1>
    <form id="f">
      <label for="p">New password</label>
      <input id="p" type="password" minlength="8" required placeholder="At least 8 characters" />
      <label for="p2">Confirm new password</label>
      <input id="p2" type="password" minlength="8" required placeholder="Repeat password" />
      <button type="submit" id="btn">Reset Password</button>
      <div id="msg"></div>
    </form>
  </div>
  <script>
    const token = ${JSON.stringify(token)};
    const form = document.getElementById('f');
    const msg = document.getElementById('msg');
    const btn = document.getElementById('btn');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const p = document.getElementById('p').value;
      const p2 = document.getElementById('p2').value;
      msg.className = ''; msg.textContent = '';
      if (p !== p2) { msg.className = 'error'; msg.textContent = 'Passwords do not match.'; return; }
      btn.disabled = true; btn.textContent = 'Resetting…';
      try {
        const res = await fetch('/api/auth/reset-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, password: p }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Something went wrong');
        msg.className = 'success';
        msg.textContent = 'Password updated! You can close this page and sign in with your new password.';
        form.querySelectorAll('input,button').forEach((el) => (el.disabled = true));
      } catch (err) {
        msg.className = 'error';
        msg.textContent = err.message;
        btn.disabled = false;
        btn.textContent = 'Reset Password';
      }
    });
  </script>
</body>
</html>`);
});

module.exports = router;
