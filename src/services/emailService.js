// SMTP credentials and email rendering stay on the server.
const fs = require('fs');
const path = require('path');
const { getSmtpTransport, readSmtpConfig, smtpFailure } = require('./smtpTransport');

let logoBase64 = null;
try {
  const logoPath = path.join(__dirname, '../../assets/email-logo.png');
  if (fs.existsSync(logoPath)) {
    logoBase64 = fs.readFileSync(logoPath).toString('base64');
  }
} catch {
  logoBase64 = null;
}

const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
function renderEmail(title, description, content, footnote, category = 'SECURITY') {
  let subFooter = 'Never share your code with anyone. MS Traders will never ask you to send it to our team. If you didn’t request this, ignore this email.';
  let bottomBadge = 'MS Traders · Account security';

  if (category === 'DELETION') {
    subFooter = 'Never share your verification code with anyone. MS Traders staff will never ask for your code. If you did not request account deletion, please secure your account immediately.';
    bottomBadge = 'MS Traders · Account Safety';
  } else if (category === 'DELIVERY') {
    subFooter = 'You can track the live location and status of your order directly from the MS Traders app.';
    bottomBadge = 'MS Traders · Fast & Fresh Delivery';
  }

  return `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><meta charset="utf-8"><title>${escape(title)}</title></head>
<body style="margin:0;padding:28px 12px;background:#f1f5f2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="540" cellspacing="0" cellpadding="0" style="width:100%;max-width:540px;background:#ffffff;border:1px solid #dce8df;border-radius:16px;box-shadow:0 4px 16px rgba(0,0,0,0.04);overflow:hidden">
<tr><td style="padding:24px 28px 20px;border-bottom:3px solid #047857;background:#ffffff"><img src="cid:ms-traders-logo" width="180" height="55" alt="MS Traders" style="display:block;max-width:180px;height:auto;border:0;outline:none;text-decoration:none"></td></tr>
<tr><td style="padding:28px 28px 24px"><h1 style="margin:0 0 14px;font-size:22px;font-weight:700;color:#064e3b;letter-spacing:-0.3px;line-height:28px">${escape(title)}</h1>
<p style="font-size:15px;line-height:24px;color:#374151;margin:0 0 20px">${escape(description)}</p>${content}
<p style="font-size:13.5px;line-height:22px;color:#475569;margin:20px 0 0">${escape(footnote)}</p>
<p style="font-size:12.5px;line-height:20px;color:#64748b;border-top:1px solid #e2e8f0;padding-top:18px;margin-top:24px">${escape(subFooter)}</p></td></tr>
<tr><td style="padding:14px 28px;background:#ecfdf5;color:#047857;font-size:12px;font-weight:600;border-top:1px solid #d1fae5;border-radius:0 0 16px 16px">${escape(bottomBadge)}</td></tr></table></td></tr></table></body></html>`;
}

async function deliverViaResend(to, subject, html, text) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.RESEND_FROM?.trim() || 'MS Traders <onboarding@resend.dev>';

  const payload = {
    from,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
    text,
    ...(logoBase64 ? {
      attachments: [{
        filename: 'ms-traders.png',
        content: logoBase64,
        contentId: 'ms-traders-logo',
        content_id: 'ms-traders-logo',
      }]
    } : {}),
  };

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('Resend email delivery failed:', { status: response.status, data });
    return { delivered: false };
  }
  return { delivered: true, id: data.id };
}

async function deliver(to, subject, html, text) {
  // 1. If RESEND_API_KEY is configured, send via Resend HTTP API (Port 443 — works on Render Free)
  if (process.env.RESEND_API_KEY?.trim()) {
    try {
      return await deliverViaResend(to, subject, html, text);
    } catch (error) {
      console.error('Resend delivery error:', error);
      return { delivered: false };
    }
  }

  // 2. Otherwise fall back to Nodemailer SMTP
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
  const description = deletion
    ? 'Enter this six-digit code in the MS Traders app to confirm your account deletion request.'
    : 'Enter this six-digit code in the MS Traders app to verify your email, then choose your new password.';
  const footnote = `This code expires in 15 minutes. Only the latest code works.${deletion ? ' Confirming deletion permanently removes your account and personal data.' : ''}`;

  const content = deletion
    ? `<div style="background:#fff1f2;border:1px solid #fecdd3;border-radius:12px;padding:14px 18px;margin-bottom:18px">
         <div style="font-size:13px;font-weight:700;color:#9f1239;margin-bottom:4px">⚠️ Warning: Irreversible Action</div>
         <div style="font-size:13px;line-height:20px;color:#be123c">
           Confirming deletion permanently removes your account profile, order history, and saved addresses.
         </div>
       </div>
       <div style="text-align:center;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:14px;padding:22px 16px;margin:18px 0">
         <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;color:#047857;margin-bottom:8px">Six-Digit Deletion Code</div>
         <div style="font-size:36px;letter-spacing:10px;font-weight:800;color:#047857;font-family:Consolas,Monaco,'Courier New',monospace;padding-left:10px">${escape(otp)}</div>
         <div style="font-size:12px;color:#059669;margin-top:8px">Expires in 15 minutes · One-time confirmation</div>
       </div>`
    : `<div style="text-align:center;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:14px;padding:22px 16px;margin:20px 0">
         <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;color:#047857;margin-bottom:8px">Six-Digit Reset Code</div>
         <div style="font-size:36px;letter-spacing:10px;font-weight:800;color:#047857;font-family:Consolas,Monaco,'Courier New',monospace;padding-left:10px">${escape(otp)}</div>
         <div style="font-size:12px;color:#059669;margin-top:8px">Expires in 15 minutes · Never share this code</div>
       </div>`;

  const category = deletion ? 'DELETION' : 'SECURITY';
  const textSubFooter = deletion
    ? 'Never share this code. If you did not request account deletion, ignore this email.'
    : 'Never share this code. If you did not request this, ignore this email.';

  return deliver(
    to,
    `MS Traders — ${title}`,
    renderEmail(title, description, content, footnote, category),
    `${title}\n\n${description}\n\n${otp}\n\n${footnote}\n\n${textSubFooter}`
  );
}

function sendDeliveryDelayEmail(to, { orderNo, customerName, newEstimatedTime, delayReason, updatedBy = 'Delivery Partner' }) {
  if (!to) return Promise.resolve({ delivered: false });
  const title = `Delivery Update: Order #${orderNo}`;
  const greeting = customerName ? `Hello ${customerName},` : 'Hello,';
  const updaterText = updatedBy === 'Store Admin' || updatedBy === 'Admin'
    ? 'our store operations team has updated the delivery estimate for your order.'
    : 'your delivery partner has reported a short delay with your order delivery.';
  const description = `${greeting} ${updaterText}`;
  const content = `
    <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:14px;padding:20px 22px;margin:20px 0">
      <div style="margin-bottom:14px">
        <span style="display:inline-block;background:#fef3c7;color:#92400e;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;padding:4px 10px;border-radius:6px;border:1px solid #fcd34d">Delivery Rescheduled</span>
      </div>
      <div style="margin-bottom:16px">
        <p style="margin:0 0 6px;font-size:12px;color:#92400e;font-weight:700;text-transform:uppercase;letter-spacing:0.5px">Reason for Delay</p>
        <div style="font-size:14px;line-height:22px;color:#78350f;background:#ffffff;padding:12px 14px;border-radius:8px;border:1px solid #fde68a;font-weight:600">${escape(delayReason)}</div>
      </div>
      <div>
        <p style="margin:0 0 6px;font-size:12px;color:#92400e;font-weight:700;text-transform:uppercase;letter-spacing:0.5px">New Estimated Arrival</p>
        <div style="font-size:22px;font-weight:800;color:#047857;letter-spacing:-0.2px">${escape(newEstimatedTime)}</div>
      </div>
    </div>
  `;
  const footnote = 'We appreciate your patience while our delivery partner safely reaches your doorstep.';
  const text = `${title}\n\n${description}\n\nReason: ${delayReason}\nNew estimated delivery: ${newEstimatedTime}\n\n${footnote}`;
  return deliver(to, `MS Traders — ${title}`, renderEmail(title, description, content, footnote, 'DELIVERY'), text);
}

module.exports = {
  sendOTPEmail: (to, otp) => sendCode(to, otp, false),
  sendDeleteAccountOTPEmail: (to, otp) => sendCode(to, otp, true),
  sendDeliveryDelayEmail,
  renderEmail,
};
