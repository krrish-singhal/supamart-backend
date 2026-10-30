const { db } = require('../config/firebase');
const { sendDeliveryDelayEmail } = require('./emailService');

const COLLECTION = 'deliveryDelayEmailOutbox';
const MAX_ATTEMPTS = 8;
const RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
let workerTimer = null;
let workerRunning = false;

async function enqueueDeliveryDelayEmail({ orderId, to, ...message }) {
  const ref = db().collection(COLLECTION).doc();
  const now = Date.now();
  await ref.set({
    orderId,
    to: String(to).trim(),
    message,
    status: 'PENDING',
    attempts: 0,
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return ref.id;
}

async function processDeliveryDelayEmail(id) {
  const firestore = db();
  const ref = firestore.collection(COLLECTION).doc(id);
  const now = Date.now();
  const job = await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const data = snap.data();
    if (data.status === 'SENT' || data.status === 'FAILED') return null;
    if (Number(data.nextAttemptAt) > now) return null;
    if (data.status === 'SENDING' && Number(data.leaseUntil) > now) return null;

    const attempts = (Number(data.attempts) || 0) + 1;
    tx.update(ref, { status: 'SENDING', attempts, leaseUntil: now + 60_000, updatedAt: now });
    return { ...data, attempts };
  });
  if (!job) return null;

  let result;
  try {
    result = await sendDeliveryDelayEmail(job.to, job.message);
  } catch (error) {
    result = { delivered: false, error: error?.message || 'Email provider request failed.' };
  }

  const completedAt = Date.now();
  const sent = Boolean(result?.delivered);
  const failedPermanently = !sent && job.attempts >= MAX_ATTEMPTS;
  const status = sent ? 'SENT' : failedPermanently ? 'FAILED' : 'PENDING';
  const retryDelay = RETRY_DELAYS_MS[Math.min(job.attempts - 1, RETRY_DELAYS_MS.length - 1)];
  const update = {
    status,
    lastError: sent ? null : String(result?.error || 'Email provider did not accept the message.'),
    lastAttemptAt: completedAt,
    updatedAt: completedAt,
    leaseUntil: null,
    ...(sent ? { deliveredAt: completedAt, providerMessageId: result.id || null } : {}),
    ...(status === 'PENDING' ? { nextAttemptAt: completedAt + retryDelay } : {}),
  };
  await ref.update(update);

  try {
    await firestore.collection('orders').doc(job.orderId).update({
      'deliveryDelay.emailStatus': status,
      'deliveryDelay.emailAttempts': job.attempts,
      'deliveryDelay.emailUpdatedAt': completedAt,
      'deliveryDelay.emailSentAt': sent ? completedAt : null,
      'deliveryDelay.emailError': sent ? null : failedPermanently ? update.lastError : null,
    });
  } catch (error) {
    console.warn('Could not sync delivery delay email status to order:', error?.message || error);
  }
  return { status, error: update.lastError, attempts: job.attempts };
}

async function processDueDeliveryDelayEmails() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    const firestore = db();
    const [pending, sending] = await Promise.all([
      firestore.collection(COLLECTION).where('status', '==', 'PENDING').limit(50).get(),
      firestore.collection(COLLECTION).where('status', '==', 'SENDING').limit(50).get(),
    ]);
    const due = [...pending.docs, ...sending.docs].filter((snap) => {
      const data = snap.data();
      return Number(data.nextAttemptAt) <= Date.now() &&
        (data.status !== 'SENDING' || Number(data.leaseUntil) <= Date.now());
    });
    await Promise.allSettled(due.map((snap) => processDeliveryDelayEmail(snap.id)));
  } catch (error) {
    console.error('Delivery delay email retry worker failed:', error?.message || error);
  } finally {
    workerRunning = false;
  }
}

function startDeliveryDelayEmailWorker() {
  if (workerTimer) return;
  workerTimer = setInterval(processDueDeliveryDelayEmails, 10_000);
  workerTimer.unref?.();
  processDueDeliveryDelayEmails();
}

module.exports = {
  enqueueDeliveryDelayEmail,
  processDeliveryDelayEmail,
  processDueDeliveryDelayEmails,
  startDeliveryDelayEmailWorker,
};
