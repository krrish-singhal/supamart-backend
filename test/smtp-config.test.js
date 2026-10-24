const test = require('node:test');
const assert = require('node:assert/strict');
const { readSmtpConfig, smtpFailure } = require('../src/services/smtpTransport');
const credentials = { SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'sender@example.test', SMTP_PASS: 'mocktestpass' };
test('Gmail App Password paste formatting is normalized with trimmed SMTP host and user', () => {
  const options = readSmtpConfig({ ...credentials, SMTP_HOST: ' smtp.gmail.com ', SMTP_USER: ' sender@example.test ', SMTP_PASS: '"mock test pass"' });
  assert.equal(options.auth.pass, 'mocktestpass'); assert.equal(options.auth.user, credentials.SMTP_USER);
  assert.equal(options.host, credentials.SMTP_HOST); assert.equal(options.port, 587); assert(options.requireTLS); assert(!options.secure);
});
test('465 uses implicit TLS, and non-Gmail passwords retain significant whitespace', () => {
  const options = readSmtpConfig({ ...credentials, SMTP_HOST: 'smtp.example.test', SMTP_PORT: '465', SMTP_PASS: ' password with spaces ' });
  assert(options.secure); assert(!options.requireTLS); assert.equal(options.auth.pass, ' password with spaces ');
});
test('missing credentials and invalid ports fail clearly', () => {
  assert.throws(() => readSmtpConfig({}), error => error.code === 'SMTP_NOT_CONFIGURED');
  for (const value of ['abc', '0', '-1', '65536', '587.5']) assert.throws(() => readSmtpConfig({ ...credentials, SMTP_PORT: value }), error => error.code === 'SMTP_INVALID_PORT');
});
test('authentication diagnostic preserves SMTP status without exposing responses or secrets', () => {
  const failure = smtpFailure({ code: 'EAUTH', responseCode: 535, response: '535 5.7.8 password=secret recipient@example.test' });
  assert.equal(failure.smtpStatus, '5.7.8'); assert.equal(failure.responseCode, 535); assert(failure.hint.includes('App Password'));
  assert(!JSON.stringify(failure).includes('secret')); assert(!JSON.stringify(failure).includes('recipient@example.test'));
});
