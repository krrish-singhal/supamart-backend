const express = require('express');
const router = express.Router();
// Old email links can no longer authorize a password change.
router.get('/reset-password', (req, res) => {
  res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>MS Traders password reset</title><body style="background:#ecfdf5;font-family:Arial,sans-serif;padding:32px;color:#064e3b"><main style="max-width:480px;margin:40px auto;background:white;padding:28px;border-radius:16px"><h1>Reset your password in the app</h1><p>Open MS Traders, select Forgot password on the login screen, and request a six-digit email code.</p><p>Enter the latest code in the app, then choose and confirm your new password. Old reset links are no longer accepted.</p></main></body></html>`);
});
module.exports = router;
