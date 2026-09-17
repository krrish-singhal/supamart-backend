// One-off migration for the order-status simplification (one shop, one rider): PACKING and
// READY_FOR_DELIVERY were removed from ORDER_STATUS / ORDER_STATUS_FLOW (see
// config/constants.js), but any order doc already sitting in one of those two statuses is
// still on disk with the now-invalid value. Left alone, ORDER_STATUS_FLOW.indexOf(order.status)
// returns -1 for those orders, so admin-portal/delivery-app could never advance them again
// (only cancel).
//
// Folds both back to ORDER_ACCEPTED — not forward to OUT_FOR_DELIVERY — because neither
// PACKING nor READY_FOR_DELIVERY means the rider has actually picked the order up yet; that's
// still true after the collapse, so ACCEPTED (shop has it, rider doesn't yet) is the honest
// re-mapping. The admin/rider then manually advances it to OUT_FOR_DELIVERY same as any order.
//
// Run with --dry to print affected orders without writing anything.
require("dotenv").config();
const { db } = require("../config/firebase");
const { COLLECTIONS, ORDER_STATUS } = require("../config/constants");

const DRY_RUN = process.argv.includes("--dry");
const STALE_STATUSES = ["PACKING", "READY_FOR_DELIVERY"]; // no longer in ORDER_STATUS — hardcoded on purpose

async function main() {
  const snap = await db()
    .collection(COLLECTIONS.ORDERS)
    .where("status", "in", STALE_STATUSES)
    .get();

  if (snap.empty) {
    console.log("No orders on PACKING / READY_FOR_DELIVERY — nothing to migrate.");
    return;
  }

  console.log(`Found ${snap.size} order(s) to migrate:`);
  for (const doc of snap.docs) {
    const o = doc.data();
    console.log(`  #${o.orderNo}  ${o.status} -> ${ORDER_STATUS.ACCEPTED}  (${o.userName || o.userId})`);
  }

  if (DRY_RUN) {
    console.log("\n--dry: no writes made. Re-run without --dry to apply.");
    return;
  }

  const now = Date.now();
  const batch = db().batch();
  for (const doc of snap.docs) {
    const o = doc.data();
    batch.update(doc.ref, {
      status: ORDER_STATUS.ACCEPTED,
      statusHistory: [...(o.statusHistory || []), { status: ORDER_STATUS.ACCEPTED, at: now }],
      updatedAt: now,
    });
  }
  await batch.commit();
  console.log(`\nMigrated ${snap.size} order(s) to ${ORDER_STATUS.ACCEPTED}.`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
