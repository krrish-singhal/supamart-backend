const crypto = require('crypto');
const { db } = require('../config/firebase');
const HOUR = 60 * 60 * 1000;
const TTL = 15 * 60 * 1000;
const digest = value => crypto.createHmac('sha256', process.env.JWT_SECRET).update(value).digest('hex');
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const refFor = (purpose, identity) => db().collection('accountSecurityCodes').doc(digest(`${purpose}:${identity}`));
const TRIVIAL_CODES = new Set([
  '000000', '111111', '222222', '333333', '444444',
  '555555', '666666', '777777', '888888', '999999',
  '123456', '654321', '012345', '543210',
]);
function generateSecureOtp() {
  let code;
  do {
    code = crypto.randomInt(100000, 1000000).toString();
  } while (TRIVIAL_CODES.has(code));
  return code;
}
function allowance(data, now) {
  if (!data.windowStart || now >= data.windowStart + 3 * HOUR) return { windowStart: now, requests: [], failures: 0, blockedUntil: 0 };
  return { windowStart: data.windowStart, requests: data.requests || [], failures: data.failures || 0, blockedUntil: data.blockedUntil || 0 };
}
function limited(state, now) {
  if (state.blockedUntil > now) throw fail('Too many incorrect attempts. Please try again after the three-hour security window.', 429);
}
async function issueCode(purpose, identity, uid) {
  const ref = refFor(purpose, identity);
  let otp = generateSecureOtp();
  const generation = crypto.randomBytes(24).toString('hex');
  await db().runTransaction(async tx => {
    const data = (await tx.get(ref)).data() || {};
    const now = Date.now();
    while (data.codeHash && data.codeHash === digest(`${data.generation}:${otp}`)) otp = generateSecureOtp();
    const state = allowance(data, now);
    limited(state, now);
    if (data.processing) throw fail('A password update is in progress. Please try again shortly.', 409);
    const recent = state.requests.filter(time => time > now - HOUR);
    if (recent.length >= 3) throw fail('Only three code requests are allowed per hour. Please try again later.', 429);
    tx.set(ref, { ...state, requests: [...recent, now], uid: uid || null, generation,
      codeHash: digest(`${generation}:${otp}`), expiresAt: now + TTL, tokenHash: null, processing: false });
  });
  return { otp, generation };
}
async function cancelCode(purpose, identity, generation) {
  const ref = refFor(purpose, identity);
  await db().runTransaction(async tx => {
    const data = (await tx.get(ref)).data();
    if (data?.generation === generation) tx.update(ref, { codeHash: null, tokenHash: null });
  });
}
async function verifyCode(purpose, identity, otp) {
  if (typeof otp !== 'string' || !/^\d{6}$/.test(otp)) throw fail('Enter the six-digit code from your email.', 422);
  const ref = refFor(purpose, identity);
  const token = crypto.randomBytes(32).toString('hex');
  const outcome = await db().runTransaction(async tx => {
    const data = (await tx.get(ref)).data();
    const now = Date.now();
    if (!data) return { error: 'Invalid or expired code. Please request a new code.' };
    const state = allowance(data, now);
    limited(state, now);
    if (!data.codeHash || data.expiresAt <= now || !data.uid) return { error: 'Invalid or expired code. Please request a new code.' };
    const actual = digest(`${data.generation}:${otp}`);
    if (!crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(data.codeHash))) {
      const failures = state.failures + 1;
      tx.update(ref, { failures, blockedUntil: failures >= 3 ? state.windowStart + 3 * HOUR : 0,
        ...(failures >= 3 ? { codeHash: null, tokenHash: null } : {}) });
      return { error: failures >= 3 ? 'Too many incorrect attempts. Try again after the three-hour security window.' : 'Incorrect code. Use the latest email.', status: failures >= 3 ? 429 : 400 };
    }
    tx.update(ref, { codeHash: null, tokenHash: digest(token), expiresAt: now + TTL });
    return { uid: data.uid };
  });
  if (outcome.error) throw fail(outcome.error, outcome.status);
  return { token, uid: outcome.uid };
}
async function claimReset(email, token) {
  const ref = refFor('reset', email);
  const data = await db().runTransaction(async tx => {
    const entry = (await tx.get(ref)).data();
    if (!entry || !entry.tokenHash || entry.tokenHash !== digest(token) || entry.expiresAt <= Date.now()) throw fail('Reset permission has expired or is invalid. Request a new code.');
    if (entry.processing) throw fail('Your password update is already in progress.', 409);
    const user = (await tx.get(db().collection('users').doc(entry.uid))).data();
    if (!user || String(user.email || '').trim().toLowerCase() !== email) throw fail('The account email has changed. Request a new code.');
    tx.update(ref, { processing: true });
    return entry;
  });
  return { ref, ...data };
}
module.exports = { issueCode, cancelCode, verifyCode, claimReset, digest, fail };
