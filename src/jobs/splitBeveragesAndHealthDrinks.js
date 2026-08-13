// Splits the merged "Beverages & Health Drinks" top-level category back into two
// separate top-level categories, per the client's correction: Beverages and Health
// Drinks are different categories to the shop, they should not have been merged.
//
// - Renames the existing "Beverages & Health Drinks" doc to "Beverages" (keeps its
//   id, and its "Tea" / "Coffee" / "Fruit Drinks & Desserts" subcategories as-is).
// - Creates a new top-level "Health Drinks" category.
// - Re-parents the existing "Health & Energy Drinks" subcategory doc onto the new
//   "Health Drinks" top-level (only the sub's parentId changes — the products under
//   it already point at the subcategory id, not the top-level, so no product writes
//   are needed).
//
// Run with --dry to print the plan without writing anything.
require("dotenv").config();
const { db } = require("../config/firebase");
const { COLLECTIONS } = require("../config/constants");

const DRY_RUN = process.argv.includes("--dry");

const OLD_TOP_NAME = "Beverages & Health Drinks";
const BEVERAGES_NAME = "Beverages";
const HEALTH_DRINKS_NAME = "Health Drinks";
const SUB_TO_MOVE = "Health & Energy Drinks";

async function run() {
  const firestore = db();
  const now = Date.now();

  const catSnap = await firestore.collection(COLLECTIONS.CATEGORIES).get();
  const cats = catSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  const oldTop = cats.find((c) => !c.parentId && c.name === OLD_TOP_NAME);
  if (!oldTop) {
    console.log(`Aborting: top-level category "${OLD_TOP_NAME}" not found — has this already run?`);
    process.exit(1);
  }

  const subs = cats.filter((c) => c.parentId === oldTop.id);
  const subToMove = subs.find((c) => c.name === SUB_TO_MOVE);
  if (!subToMove) {
    console.log(`Aborting: sub-category "${SUB_TO_MOVE}" not found under "${OLD_TOP_NAME}".`);
    process.exit(1);
  }
  const staying = subs.filter((c) => c.id !== subToMove.id);

  const topLevelCount = cats.filter((c) => !c.parentId).length;

  console.log("=".repeat(70));
  console.log("PLAN");
  console.log("=".repeat(70));
  console.log(`"${OLD_TOP_NAME}" -> renamed to "${BEVERAGES_NAME}" (reusing id ${oldTop.id})`);
  staying.forEach((s) => console.log(`  > stays: ${s.name}`));
  console.log(`\nNew top-level category "${HEALTH_DRINKS_NAME}" created`);
  console.log(`  > moved in: ${subToMove.name} (reusing existing sub doc, re-parented)`);
  console.log(`\nTop-level categories: ${topLevelCount} -> ${topLevelCount + 1}`);

  if (DRY_RUN) {
    console.log("\nDry run — no writes performed.");
    process.exit(0);
  }

  await firestore.collection(COLLECTIONS.CATEGORIES).doc(oldTop.id).update({ name: BEVERAGES_NAME, updatedAt: now });
  console.log(`Renamed "${OLD_TOP_NAME}" -> "${BEVERAGES_NAME}"`);

  const newTopRef = await firestore.collection(COLLECTIONS.CATEGORIES).add({
    name: HEALTH_DRINKS_NAME, image: "", imageKey: null, order: topLevelCount, parentId: null, isActive: true, createdAt: now, updatedAt: now,
  });
  console.log(`Created top-level "${HEALTH_DRINKS_NAME}" (id ${newTopRef.id})`);

  await firestore.collection(COLLECTIONS.CATEGORIES).doc(subToMove.id).update({ parentId: newTopRef.id, updatedAt: now });
  console.log(`Re-parented "${SUB_TO_MOVE}" -> "${HEALTH_DRINKS_NAME}"`);

  console.log("\nDone.");
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
