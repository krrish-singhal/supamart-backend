const { messaging } = require("../config/firebase");

// --- Push (FCM) ---
async function sendPush(tokens, title, body, data = {}) {
  if (!tokens || tokens.length === 0) return;
  await messaging().sendEachForMulticast({
    tokens,
    notification: { title, body },
    data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
  });
}

async function broadcast(allTokens, title, body) {
  // chunk to FCM's 500-token limit
  for (let i = 0; i < allTokens.length; i += 500) {
    await sendPush(allTokens.slice(i, i + 500), title, body, { type: "BROADCAST" });
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

module.exports = { sendPush, broadcast, sendOwnerWhatsApp };
