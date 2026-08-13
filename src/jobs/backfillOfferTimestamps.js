/**
 * One-off fix: the original seedProducts.js wrote offer docs via a raw batch
 * write with no createdAt/updatedAt, so the admin-portal's `orderBy('createdAt')`
 * query silently excluded them (Firestore drops docs missing the orderBy field).
 * Backfills any offer doc missing those fields. Safe to re-run.
 *
 *   cd backend && node src/jobs/backfillOfferTimestamps.js
 */
require("dotenv").config();
const { db } = require("../config/firebase");
const { COLLECTIONS } = require("../config/constants");

async function main() {
  const firestore = db();
  const snap = await firestore.collection(COLLECTIONS.OFFERS).get();
  const now = Date.now();

  const missing = snap.docs.filter((d) => !d.data().createdAt);
  if (missing.length === 0) {
    console.log("✓ All offers already have createdAt — nothing to backfill.");
    return;
  }

  const batch = firestore.batch();
  missing.forEach((doc) => {
    batch.update(doc.ref, { createdAt: doc.data().validFrom || now, updatedAt: now });
  });
  await batch.commit();
  console.log(`✓ Backfilled createdAt/updatedAt on ${missing.length} offer(s): ${missing.map((d) => d.data().code).join(", ")}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
