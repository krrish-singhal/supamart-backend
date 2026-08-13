require("dotenv").config();
const { db } = require("../config/firebase");
const { COLLECTIONS } = require("../config/constants");

// Additive-only companion to seed.js: seed.js only ever gave Detergent real
// sub-categories (Powder/Bars/.../Liquid) — every other category was left flat,
// so the customer app's Categories accordion has never had anything to expand
// for them. This script creates the missing sub-categories for the OTHER 11
// real top-level categories (verified against the live categories collection —
// there is no "Skin-Care"/"Beverages"/"Bath & Hygiene"/"Packaged Foods" category
// in this system). It never deletes or modifies an existing category doc; if a
// sub-category with a given name already exists under its parent, it's skipped.
//
// imageKey follows the same slugify(parent)-slugify(sub) convention the
// customer app's CategoriesScreen.js computes dynamically (src/utils/slugify.js)
// — set here too just for admin-portal/CategoryForm.jsx visibility, not required
// by the app's actual lookup logic.
const MISSING_SUB_CATEGORIES = {
  "Hair Care": [
    { name: "Shampoo", imageKey: "hair-care-shampoo" },
    { name: "Hair Oil", imageKey: "hair-care-hair-oil" },
    { name: "Conditioner", imageKey: "hair-care-conditioner" },
  ],
  "Bathing Soap": [
    { name: "Soaps", imageKey: "bathing-soap-soaps" },
    { name: "Hand Wash", imageKey: "bathing-soap-hand-wash" },
  ],
  "Dishwash": [
    { name: "Bars", imageKey: "dishwash-bars" },
    { name: "Liquid", imageKey: "dishwash-liquid" },
  ],
  "Face Wash": [
    { name: "Women", imageKey: "face-wash-women" },
    { name: "Men", imageKey: "face-wash-men" },
  ],
  "Oral-Care": [
    { name: "Toothpaste", imageKey: "oral-care-toothpaste" },
  ],
  "Talc & Grooming": [
    { name: "Talc", imageKey: "talc-grooming-talc" },
  ],
  "Tea & Coffee": [
    { name: "Coffee", imageKey: "tea-coffee-coffee" },
    { name: "Tea", imageKey: "tea-coffee-tea" },
  ],
  "Breakfast": [
    { name: "Cereals & Ready To Eat", imageKey: "breakfast-cereals-ready-to-eat" },
    { name: "Jam", imageKey: "breakfast-jam" },
  ],
  "Feminine Hygiene": [
    { name: "Intimate Wash", imageKey: "feminine-hygiene-intimate-wash" },
  ],
  "Sauces & Spreads": [
    { name: "Sauces & Ketchup", imageKey: "sauces-spreads-sauces-ketchup" },
    { name: "Soup", imageKey: "sauces-spreads-soup" },
  ],
  "Health Food Drinks": [
    { name: "Health Drink & Supplements", imageKey: "health-food-drinks-health-drink-supplements" },
  ],
};

async function addMissingSubCategories() {
  const firestore = db();
  const now = Date.now();

  const snap = await firestore.collection(COLLECTIONS.CATEGORIES).get();
  const existing = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const topLevelByName = {};
  existing.filter((c) => !c.parentId).forEach((c) => { topLevelByName[c.name] = c; });

  let created = 0;
  let skippedExisting = 0;
  let skippedMissingParent = 0;

  for (const [parentName, subs] of Object.entries(MISSING_SUB_CATEGORIES)) {
    const parent = topLevelByName[parentName];
    if (!parent) {
      console.error(`✗ Parent category "${parentName}" not found — skipping its sub-categories`);
      skippedMissingParent += subs.length;
      continue;
    }
    const alreadyHasChildren = existing.filter((c) => c.parentId === parent.id);
    let subOrder = alreadyHasChildren.length;

    for (const sub of subs) {
      const dup = alreadyHasChildren.find((c) => c.name === sub.name);
      if (dup) {
        console.log(`  [skip] "${parentName}" > "${sub.name}" already exists (${dup.id})`);
        skippedExisting++;
        continue;
      }
      const ref = await firestore.collection(COLLECTIONS.CATEGORIES).add({
        name: sub.name,
        image: "",
        imageKey: sub.imageKey,
        order: subOrder++,
        parentId: parent.id,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      });
      console.log(`  [created] "${parentName}" > "${sub.name}" -> ${ref.id}`);
      created++;
    }
  }

  console.log("\n============================================================");
  console.log(`  Created: ${created}`);
  console.log(`  Already existed (skipped): ${skippedExisting}`);
  console.log(`  Missing parent (skipped): ${skippedMissingParent}`);
  console.log("============================================================\n");
  process.exit(0);
}

addMissingSubCategories().catch((e) => {
  console.error(e);
  process.exit(1);
});
