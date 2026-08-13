// ONLY this file knows about Nodemailer/SMTP.
const nodemailer = require("nodemailer");

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return transporter;
}

// Sends the password-reset email. If SMTP isn't configured (e.g. local dev), logs the
// link to the console instead of failing, so the reset flow is still testable end-to-end.
async function sendPasswordResetEmail(toEmail, resetUrl) {
  const t = getTransporter();
  if (!t) {
    console.warn(`SMTP not configured — password reset link for ${toEmail}: ${resetUrl}`);
    return { delivered: false };
  }
  await t.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: toEmail,
    subject: "Reset your MS Traders password",
    html: `
      <p>We received a request to reset your MS Traders password.</p>
      <p><a href="${resetUrl}">Click here to reset your password</a> (valid for 1 hour).</p>
      <p>If you didn't request this, you can safely ignore this email.</p>
    `,
  });
  return { delivered: true };
}

module.exports = { sendPasswordResetEmail };
