const { messaging, db } = require("../config/firebase");
const { COLLECTIONS } = require("../config/constants");

// --- Push (FCM) ---
async function sendPush(tokens, title, body, data = {}) {
  if (!tokens || tokens.length === 0) return;
  await messaging().sendEachForMulticast({
    tokens,
    notification: { title, body },
    data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
  });
}

// --- In-app real-time notification (Firestore) + background push (FCM) ---
// Writes to users/{userId}/notifications so the customer app's live onSnapshot
// listener (and the bell badge) update instantly while the app is open, and also
// fires an FCM push for when it isn't. Called from markPaid(), rejectPayment(), and
// updateStatus() — i.e. every path that changes an order's payment/fulfillment state.
//
// Entirely best-effort and never throws: this fires *after* the order's own Firestore
// transaction has already committed, so a notification failure (bad token, transient
// Firestore error, whatever) must never bubble up and make the caller think the actual
// order/payment change itself failed.
async function notifyUser(userId, title, body, data = {}) {
  try {
    const now = Date.now();
    const userRef = db().collection(COLLECTIONS.USERS).doc(userId);
    await userRef.collection("notifications").add({ title, body, data, read: false, createdAt: now });

    const userSnap = await userRef.get();
    const fcmTokens = userSnap.exists ? userSnap.data().fcmTokens : null;
    if (fcmTokens && fcmTokens.length > 0) {
      await sendPush(fcmTokens, title, body, data);
    }
  } catch (err) {
    console.error(`notifyUser: failed to notify user ${userId}`, err);
  }
}

async function broadcast(allTokens, title, body) {
  // chunk to FCM's 500-token limit
  for (let i = 0; i < allTokens.length; i += 500) {
    await sendPush(allTokens.slice(i, i + 500), title, body, { type: "BROADCAST" });
  }
}

// Pushes a "New Order" alert to every browser tab that has the admin portal open and has
// registered for notifications (see POST /api/admin/fcm-token, which the admin portal calls
// once it has Notification permission + a token). Tokens live on config/adminDevices rather
// than a per-admin user doc — the admin portal only has Firebase Auth users with a `role`
// custom claim, no Firestore user profile, so there's nowhere else to hang this. Best-effort
// and never throws, same rationale as notifyUser: this fires after the order's own Firestore
// transaction already committed, so a push failure must never look like the order failed.
async function notifyAdminsNewOrder(order) {
  try {
    const snap = await db().collection(COLLECTIONS.CONFIG).doc("adminDevices").get();
    const tokens = snap.exists ? snap.data().fcmTokens || [] : [];
    if (!tokens.length) return;
    const itemCount = (order.items || []).length;
    await sendPush(
      tokens,
      `New order #${order.orderNo}`,
      `₹${order.total} • ${itemCount} item${itemCount === 1 ? "" : "s"}`,
      { type: "NEW_ORDER", orderId: order.id }
    );
  } catch (err) {
    console.error("notifyAdminsNewOrder: failed to push", err);
  }
}

// --- WhatsApp to store owner (optional, feature-flagged adapter) ---
// Implement against your provider (e.g. WhatsApp Cloud API) when ready.
async function sendOwnerWhatsApp(order) {
  if (process.env.WHATSAPP_ENABLED !== "true") return;
  const lines = order.items.map((i) => `${i.name} ${i.variantLabel} x${i.qty}`).join("\n");
  const message =
    `Order #${order.orderNo}\n${lines}\nTotal: ₹${order.total}\n` +
    `Customer: ${order.addressSnapshot.houseNo}, ${order.addressSnapshot.street}`;
  // await axios.post(provider, { to: process.env.OWNER_PHONE, message });
  return { queued: true, message };
}

module.exports = { sendPush, broadcast, sendOwnerWhatsApp, notifyUser, notifyAdminsNewOrder };
