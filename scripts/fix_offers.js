const { db } = require("../src/config/firebase");
async function fix() {
  const snap = await db().collection("offers").get();
  let count = 0;
  for (const doc of snap.docs) {
    if (!doc.data().createdAt) {
      await doc.ref.update({ createdAt: Date.now(), updatedAt: Date.now() });
      count++;
    }
  }
  console.log(`Fixed ${count} offers`);
  process.exit(0);
}
fix();
