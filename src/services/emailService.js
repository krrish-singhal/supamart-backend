// SMTP credentials and email rendering stay on the server.
const path = require('path');
const { getSmtpTransport, readSmtpConfig, smtpFailure } = require('./smtpTransport');
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
function renderEmail(title, description, content, footnote) {
  return `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><meta charset="utf-8"><title>${escape(title)}</title></head>
<body style="margin:0;padding:24px 12px;background:#f1f5f2;font-family:Arial,Helvetica,sans-serif;color:#1f2937">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="540" cellspacing="0" cellpadding="0" style="width:100%;max-width:540px;background:#ffffff;border:1px solid #dce8df;border-radius:18px">
<tr><td style="padding:28px 28px 20px;border-bottom:3px solid #047857"><img src="cid:ms-traders-logo" width="196" height="60" alt="MS Traders" style="display:block;max-width:100%;height:auto"></td></tr>
<tr><td style="padding:28px"><h1 style="margin:0 0 16px;font-size:24px;color:#064e3b">${escape(title)}</h1>
<p style="font-size:15px;line-height:24px;margin:0 0 20px">${escape(description)}</p>${content}
<p style="font-size:14px;line-height:22px;color:#475569">${escape(footnote)}</p>
<p style="font-size:13px;line-height:21px;color:#64748b;border-top:1px solid #e2e8f0;padding-top:18px;margin-top:24px">Never share your code with anyone. MS Traders will never ask you to send it to our team. If you didn’t request this, ignore this email.</p></td></tr>
<tr><td style="padding:18px 28px;background:#ecfdf5;color:#047857;font-size:12px;border-radius:0 0 18px 18px">MS Traders · Account security</td></tr></table></td></tr></table></body></html>`;
}
async function deliver(to, subject, html, text) {
  try {
    const t = getSmtpTransport();
    const result = await t.sendMail({ from: process.env.SMTP_FROM?.trim() || { name: 'MS Traders', address: readSmtpConfig().auth.user },
      to, subject, html, text,
      attachments: [{ filename: 'ms-traders.png', path: path.join(__dirname, '../../assets/email-logo.png'), cid: 'ms-traders-logo', contentDisposition: 'inline' }],
      disableUrlAccess: true,
    });
    return { delivered: Array.isArray(result.accepted) && result.accepted.length > 0 };
  } catch (error) {
    // Never log codes, credentials or reset URLs, including in development.
    console.error('Nodemailer SMTP delivery failed:', smtpFailure(error));
    return { delivered: false };
  }
}
function sendCode(to, otp, deletion) {
  const title = deletion ? 'Confirm account deletion' : 'Reset your password';
  const description = deletion ? 'Enter this six-digit code in the MS Traders app to confirm your account deletion request.' : 'Enter this six-digit code in the MS Traders app to verify your email, then choose your new password.';
  const footnote = `This code expires in 15 minutes. Only the latest code works.${deletion ? ' Confirming deletion permanently removes your account and personal data.' : ''}`;
  const content = `<div style="text-align:center;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:12px;padding:22px 8px;font-size:34px;letter-spacing:8px;font-weight:bold;color:#047857">${escape(otp)}</div>`;
  return deliver(to, `MS Traders — ${title}`, renderEmail(title, description, content, footnote), `${title}\n\n${description}\n\n${otp}\n\n${footnote}\n\nNever share this code. If you did not request this, ignore this email.`);
}

function sendDeliveryDelayEmail(to, { orderNo, customerName, newEstimatedTime, delayReason }) {
  if (!to) return Promise.resolve({ delivered: false });
  const title = `Delivery Update: Order #${orderNo}`;
  const greeting = customerName ? `Hello ${customerName},` : 'Hello,';
  const description = `${greeting} your delivery partner has reported a short delay with your order delivery.`;
  const content = `
    <div style="background:#fffbeb;border:1px solid #fef3c7;border-radius:12px;padding:18px 20px;margin-bottom:18px">
      <p style="margin:0 0 8px;font-size:13px;color:#92400e;font-weight:bold;text-transform:uppercase;letter-spacing:0.5px">Reason for Delay</p>
      <div style="margin:0 0 16px;font-size:15px;color:#78350f;background:#ffffff;padding:12px 14px;border-radius:8px;border:1px solid #fde68a;font-weight:600">${escape(delayReason)}</div>
      <p style="margin:0 0 8px;font-size:13px;color:#92400e;font-weight:bold;text-transform:uppercase;letter-spacing:0.5px">New Estimated Delivery</p>
      <div style="margin:0;font-size:20px;font-weight:bold;color:#047857">${escape(newEstimatedTime)}</div>
    </div>
  `;
  const footnote = 'We appreciate your patience while our delivery partner safely reaches your doorstep.';
  const text = `${title}\n\n${description}\n\nReason: ${delayReason}\nNew estimated delivery: ${newEstimatedTime}\n\n${footnote}`;
  return deliver(to, `MS Traders — ${title}`, renderEmail(title, description, content, footnote), text);
}

module.exports = {
  sendOTPEmail: (to, otp) => sendCode(to, otp, false),
  sendDeleteAccountOTPEmail: (to, otp) => sendCode(to, otp, true),
  sendDeliveryDelayEmail,
  renderEmail,
};
