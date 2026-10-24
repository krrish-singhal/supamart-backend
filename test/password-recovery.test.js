process.env.JWT_SECRET = 'recovery-tests-only-secret';
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const records = new Map();
let tail = Promise.resolve();
const snapshot = path => ({ id: path.split('/').at(-1), exists: records.has(path), data: () => structuredClone(records.get(path)) });
const ref = path => ({ path, get: async () => snapshot(path), update: async patch => { assert(records.has(path)); records.set(path, { ...records.get(path), ...patch }); } });
function collection(path, filters = []) {
  return { doc: id => ref(`${path}/${id}`), where: (key, op, value) => collection(path, [...filters, [key, value]]), limit() { return this; },
    get: async () => { const docs = [...records.keys()].filter(key => key.startsWith(`${path}/`) && filters.every(([field, value]) => records.get(key)[field] === value)).map(snapshot); return { docs, empty: !docs.length }; } };
}
const firebase = require('../src/config/firebase');
firebase.db = () => ({ collection, runTransaction: callback => {
  const run = tail.then(async () => {
    const writes = [];
    const result = await callback({ get: async r => snapshot(r.path), set: (r, value) => writes.push(() => records.set(r.path, value)),
      update: (r, value) => writes.push(() => { assert(records.has(r.path)); records.set(r.path, { ...records.get(r.path), ...value }); }) });
    writes.forEach(write => write()); return result;
  }); tail = run.catch(() => {}); return run;
} });
let authPassword, failAuth = false, sent = [], deliveryFails = false;
firebase.authAdmin = () => ({ updateUser: async (uid, { password }) => { if (failAuth) throw Object.assign(new Error('unavailable'), { code: 'auth/internal-error' }); authPassword = password; }, revokeRefreshTokens: async () => {} });
const emailService = require('../src/services/emailService');
emailService.sendOTPEmail = async (email, otp) => { sent.push({ email, otp }); return { delivered: !deliveryFails }; };
const { issueCode, verifyCode, cancelCode } = require('../src/services/accountCodes');
const express = require('express');
const { errorHandler } = require('../src/middleware/error');
const app = express(); app.use(express.json()); app.use('/auth', require('../src/routes/auth.routes')); app.use(errorHandler);
let server, base;
test.before(async () => { server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
test.beforeEach(async () => { records.clear(); sent = []; deliveryFails = false; failAuth = false;
  records.set('users/customer', { email: 'buyer@example.com', passwordHash: await bcrypt.hash('old-password', 4) });
});
async function post(path, body) { const response = await fetch(`${base}/auth/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; }
const email = 'buyer@example.com';
async function getToken() {
  assert.equal((await post('forgot-password', { email })).status, 200);
  const verified = await post('verify-reset-otp', { email, otp: sent.at(-1).otp });
  assert.equal(verified.status, 200); return verified.body.resetToken;
}
test('reset updates both login stores, rejects old credentials and token replay', async () => {
  const token = await getToken();
  const payload = { email, token, password: 'new-password-123', confirmPassword: 'new-password-123' };
  assert.equal((await post('reset-password', { ...payload, confirmPassword: 'wrong' })).status, 422);
  assert.equal((await post('reset-password', payload)).status, 200);
  assert.equal(authPassword, payload.password);
  assert(await bcrypt.compare(payload.password, records.get('users/customer').passwordHash));
  assert.equal((await post('login', { email, password: 'old-password' })).status, 401);
  const login = await post('login', { email, password: payload.password });
  assert.equal(login.status, 200); assert(login.body.token); assert(!('passwordHash' in login.body));
  assert.equal((await post('reset-password', payload)).status, 400);
});
test('simultaneous issuance leaves only latest code usable; verification consumes code once', async () => {
  const [first, second] = await Promise.all([issueCode('reset', email, 'customer'), issueCode('reset', email, 'customer')]);
  assert.notEqual(first.otp, second.otp);
  await assert.rejects(verifyCode('reset', email, first.otp), /Incorrect code/);
  const results = await Promise.allSettled([verifyCode('reset', email, second.otp), verifyCode('reset', email, second.otp)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const stored = [...records.entries()].find(([key]) => key.startsWith('accountSecurityCodes/'))[1];
  assert(!('otp' in stored)); assert(stored.codeHash === null);
});
test('three requests per rolling hour; counters reset after three hours', async () => {
  for (let i = 0; i < 3; i++) await issueCode('reset', email, 'customer');
  await assert.rejects(issueCode('reset', email, 'customer'), error => error.statusCode === 429);
  const entry = [...records.entries()].find(([key]) => key.startsWith('accountSecurityCodes/'));
  records.set(entry[0], { ...entry[1], windowStart: Date.now() - 3 * 3600000 });
  await issueCode('reset', email, 'customer');
});
test('three incorrect codes lock verification and issuance even after resending', async () => {
  const first = await issueCode('reset', email, 'customer');
  await assert.rejects(verifyCode('reset', email, first.otp === '000000' ? '000001' : '000000'));
  const second = await issueCode('reset', email, 'customer');
  const wrong = second.otp === '000000' ? '000001' : '000000';
  await assert.rejects(verifyCode('reset', email, wrong));
  await assert.rejects(verifyCode('reset', email, wrong), error => error.statusCode === 429);
  await assert.rejects(verifyCode('reset', email, second.otp), error => error.statusCode === 429);
  await assert.rejects(issueCode('reset', email, 'customer'), error => error.statusCode === 429);
});
test('resend invalidates reset permission; expired codes fail', async () => {
  const token = await getToken(); await issueCode('reset', email, 'customer');
  assert.equal((await post('reset-password', { email, token, password: 'new-password', confirmPassword: 'new-password' })).status, 400);
  const issued = await issueCode('deletion', 'customer', 'customer');
  const entry = [...records.entries()].find(([key, data]) => data.generation === issued.generation);
  records.set(entry[0], { ...entry[1], expiresAt: Date.now() - 1 });
  await assert.rejects(verifyCode('deletion', 'customer', issued.otp), /expired/);
});
test('SMTP failure reports error and cancels undelivered code', async () => {
  deliveryFails = true;
  assert.equal((await post('forgot-password', { email })).status, 503);
  assert.equal((await post('verify-reset-otp', { email, otp: sent.at(-1).otp })).status, 400);
});
test('earlier delivery failure cannot cancel newer code', async () => {
  const first = await issueCode('reset', email, 'customer'); const second = await issueCode('reset', email, 'customer');
  await cancelCode('reset', email, first.generation);
  assert((await verifyCode('reset', email, second.otp)).token);
});
test('Firebase failure does not report success and permits retry', async () => {
  const token = await getToken(); failAuth = true;
  const payload = { email, token, password: 'new-password', confirmPassword: 'new-password' };
  assert.equal((await post('reset-password', payload)).status, 503);
  assert(await bcrypt.compare('old-password', records.get('users/customer').passwordHash));
  failAuth = false; assert.equal((await post('reset-password', payload)).status, 200);
});
test('unknown accounts are rejected without sending email or issuing codes', async () => {
  const result = await post('forgot-password', { email: 'missing@example.com' });
  assert.equal(result.status, 404);
  assert.match(result.body.error, /Email does not exist/);
  assert.equal(sent.length, 0);
  assert.equal(records.size, 1);
});
test('registered email is normalized before sending a code', async () => {
  assert.equal((await post('forgot-password', { email: ' BUYER@EXAMPLE.COM ' })).status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].email, email);
});
test('malformed input and cross-purpose codes fail', async () => {
  assert.equal((await post('forgot-password', { email: {} })).status, 422);
  assert.equal((await post('verify-reset-otp', { email, otp: {} })).status, 422);
  const issued = await issueCode('deletion', 'customer', 'customer');
  await assert.rejects(verifyCode('reset', email, issued.otp));
});
test('email template uses theme, inline logo and escaped text', () => {
  const html = emailService.renderEmail('<Reset>', 'Instructions', '<p>code</p>', 'Latest code only');
  assert(html.includes('cid:ms-traders-logo')); assert(html.includes('#047857')); assert(html.includes('&lt;Reset&gt;'));
});
test('concurrent password saves permit exactly one winner', async () => {
  const token = await getToken();
  const results = await Promise.all(['first-new-password', 'second-new-password'].map(password => post('reset-password', { email, token, password, confirmPassword: password })));
  assert.equal(results.filter(result => result.status === 200).length, 1);
  assert(await bcrypt.compare(authPassword, records.get('users/customer').passwordHash));
});
test('reset permission does not survive changing the account email', async () => {
  const token = await getToken();
  records.set('users/customer', { ...records.get('users/customer'), email: 'changed@example.com' });
  assert.equal((await post('reset-password', { email, token, password: 'new-password', confirmPassword: 'new-password' })).status, 400);
});
