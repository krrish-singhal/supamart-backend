const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
Object.assign(process.env, { SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_USER: 'accounts@example.test', SMTP_PASS: 'test-only' });
delete process.env.SMTP_FROM;
let config, mail, mode;
const nodemailer = require('nodemailer');
nodemailer.createTransport = options => { config = options; return { sendMail: async options => {
  mail = options;
  if (mode === 'error') throw Object.assign(new Error('test failure'), { code: 'ETIMEDOUT' });
  return { accepted: mode === 'reject' ? [] : [options.to] };
} }; };
const { sendOTPEmail, sendDeleteAccountOTPEmail } = require('../src/services/emailService');
test('reset mail contains code, inline logo, text alternative and encrypted transport', async () => {
  assert.deepEqual(await sendOTPEmail('buyer@example.test', '012345'), { delivered: true });
  assert.equal(config.requireTLS, true); assert.equal(config.port, 587);
  assert.equal(mail.from.name, 'MS Traders'); assert(mail.html.includes('012345')); assert(mail.text.includes('012345'));
  assert(mail.html.includes('cid:ms-traders-logo')); assert(fs.existsSync(mail.attachments[0].path));
});
test('deletion mail matches theme and six digit instructions', async () => {
  await sendDeleteAccountOTPEmail('buyer@example.test', '654321');
  assert(mail.text.includes('six-digit')); assert(mail.html.includes('#047857')); assert(mail.html.includes('654321'));
});
test('SMTP rejection and transport errors are failures and never log the code', async () => {
  mode = 'reject'; assert.equal((await sendOTPEmail('buyer@example.test', '012345')).delivered, false);
  mode = 'error'; const logs = []; const original = console.error;
  console.error = (...args) => logs.push(args.join(' '));
  try { assert.equal((await sendOTPEmail('buyer@example.test', '012345')).delivered, false); }
  finally { console.error = original; }
  assert(!logs.join(' ').includes('012345')); assert(!logs.join(' ').includes('buyer@example.test'));
});
