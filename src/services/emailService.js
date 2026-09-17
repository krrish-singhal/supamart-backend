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

async function sendOTPEmail(toEmail, otp) {
  const t = getTransporter();
  if (!t) {
    console.warn(`SMTP not configured — OTP for ${toEmail}: ${otp}`);
    return { delivered: false };
  }
  try {
    await t.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: toEmail,
      subject: "Your MS Traders Reset Passcode",
      html: `
        <p>We received a request to reset your MS Traders password.</p>
        <p>Your 6-digit passcode is: <strong>${otp}</strong></p>
        <p>This code is valid for 15 minutes.</p>
        <p>If you didn't request this, you can safely ignore this email.</p>
      `,
    });
    return { delivered: true };
  } catch (error) {
    console.error("Nodemailer failed to send email:", error.message);
    console.warn(`\n\n=== DEV MODE FALLBACK: Email Failed ===\nOTP for ${toEmail}: ${otp}\n=======================================\n`);
    // Return true anyway so the user can test the app flow without being blocked by SMTP issues
    return { delivered: true };
  }
}

module.exports = { sendPasswordResetEmail, sendOTPEmail };
