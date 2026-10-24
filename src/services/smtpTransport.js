const nodemailer = require('nodemailer');

let transporter;
function readSmtpConfig(env = process.env) {
  const host = String(env.SMTP_HOST || '').trim();
  const user = String(env.SMTP_USER || '').trim();
  let pass = String(env.SMTP_PASS || '');
  // Google displays App Passwords in groups. Accept a pasted grouped password.
  if (/^smtp\.(gmail|googlemail)\.com$/i.test(host)) {
    pass = pass.trim().replace(/^(['"])(.*)\1$/, '$2').replace(/\s/g, '');
  }
  if (!host || !user || !pass) {
    throw Object.assign(new Error('Set SMTP_HOST, SMTP_USER and SMTP_PASS in the backend environment.'), { code: 'SMTP_NOT_CONFIGURED' });
  }
  const port = Number(String(env.SMTP_PORT || '587').trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw Object.assign(new Error('SMTP_PORT must be a valid port, usually 587 or 465.'), { code: 'SMTP_INVALID_PORT' });
  }
  return { host, port, secure: port === 465, requireTLS: port !== 465,
    auth: { user, pass }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 10000 };
}
function getSmtpTransport() {
  if (!transporter) transporter = nodemailer.createTransport(readSmtpConfig());
  return transporter;
}
function smtpFailure(error) {
  const code = error.code || 'SMTP_ERROR';
  let hint = 'Check the SMTP server configuration and availability.';
  if (code === 'EAUTH') hint = 'SMTP login rejected. Check SMTP_USER and SMTP_PASS. Gmail requires a valid App Password for that same account; a regular account password will not work.';
  else if (code === 'SMTP_NOT_CONFIGURED' || code === 'SMTP_INVALID_PORT') hint = error.message;
  else if (['EDNS', 'ECONNECTION', 'ESOCKET', 'ETIMEDOUT'].includes(code)) hint = 'Check that this backend can reach SMTP_HOST on SMTP_PORT.';
  return { code, ...(Number.isInteger(error.responseCode) ? { responseCode: error.responseCode } : {}),
    ...(error.response?.match(/\b[245]\.\d+\.\d+\b/) ? { smtpStatus: error.response.match(/\b[245]\.\d+\.\d+\b/)[0] } : {}), hint };
}
module.exports = { readSmtpConfig, getSmtpTransport, smtpFailure };
