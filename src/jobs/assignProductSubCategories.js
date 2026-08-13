// One-off, additive-only data-fix job. Run manually with `node src/jobs/assignProductSubCategories.js`.
// Pass --dry to only print the plan without writing.
//
// Context: addMissingSubCategories.js created 19 subcategories, but no products were ever
// reassigned into them, so every subcategory filter pill in the app showed zero products.
// This assigns existing products' categoryId to the matching subcategory based on name
// keywords. Products with no clear keyword match are left on the parent category
// unchanged — they still show up under the "All" pill, just not under a specific
// subcategory pill, which is correct given ambiguous naming.
require("dotenv").config();
const { db } = require("../config/firebase");

const DRY_RUN = process.argv.includes("--dry");

// name: subcategory name (must match an existing doc under that parent),
// test: (productName) => boolean, checked in array order, first match wins.
const RULES = {
  "Oral-Care": [
    { name: "Toothpaste", test: () => true },
  ],
  "Bathing Soap": [
    { name: "Hand Wash", test: (n) => /hand wash/i.test(n) },
    { name: "Soaps", test: () => true },
  ],
  "Tea & Coffee": [
    { name: "Coffee", test: (n) => /coffee/i.test(n) },
    { name: "Tea", test: (n) => /tea|elaichi/i.test(n) },
  ],
  Breakfast: [
    { name: "Jam", test: (n) => /jam|marmalade/i.test(n) },
    { name: "Cereals & Ready To Eat", test: (n) => /cereal|muesli|oats|corn flakes/i.test(n) },
  ],
  "Feminine Hygiene": [
    { name: "Intimate Wash", test: (n) => /wash/i.test(n) },
  ],
  "Health Food Drinks": [
    { name: "Health Drink & Supplements", test: () => true },
  ],
  Dishwash: [
    { name: "Liquid", test: (n) => /liquid|gel/i.test(n) },
    { name: "Bars", test: (n) => /bar/i.test(n) },
  ],
  "Hair Care": [
    { name: "Hair Oil", test: (n) => /hair oil/i.test(n) },
    { name: "Shampoo", test: (n) => /shampoo/i.test(n) },
    { name: "Conditioner", test: (n) => /conditioner/i.test(n) },
  ],
  "Talc & Grooming": [
    { name: "Talc", test: () => true },
  ],
  "Face Wash": [
    { name: "Men", test: (n) => /\bmen\b/i.test(n) },
    { name: "Women", test: () => true },
  ],
  "Sauces & Spreads": [
    { name: "Soup", test: (n) => /soup/i.test(n) },
    { name: "Sauces & Ketchup", test: (n) => /sauce|mayo|ketchup/i.test(n) },
  ],
};

(async () => {
  const catsSnap = await db().collection("categories").get();
  const cats = catsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const topLevelByName = {};
  cats.filter((c) => !c.parentId).forEach((c) => (topLevelByName[c.name] = c));

  const subByParentAndName = {};
  cats.filter((c) => c.parentId).forEach((c) => {
    subByParentAndName[`${c.parentId}::${c.name}`] = c;
  });

  const prodSnap = await db().collection("products").get();
  const prods = prodSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  const updates = [];
  for (const [catName, rules] of Object.entries(RULES)) {
    const top = topLevelByName[catName];
    if (!top) {
      console.warn(`Skipping unknown category "${catName}"`);
      continue;
    }
    const items = prods.filter((p) => p.categoryId === top.id);
    for (const p of items) {
      const rule = rules.find((r) => r.test(p.name || ""));
      if (!rule) continue;
      const sub = subByParentAndName[`${top.id}::${rule.name}`];
      if (!sub) {
        console.warn(`  No subcategory doc "${rule.name}" under "${catName}" — skipping ${p.name}`);
        continue;
      }
      updates.push({ product: p, sub, catName });
    }
  }

  console.log(`Plan: ${updates.length} of ${prods.length} products will be reassigned.\n`);
  for (const u of updates) {
    console.log(`  [${u.catName}] "${u.product.name}" -> ${u.sub.name} (${u.sub.id})`);
  }

  if (DRY_RUN) {
    console.log("\nDry run — no writes performed.");
    process.exit(0);
  }

  const chunks = [];
  for (let i = 0; i < updates.length; i += 450) chunks.push(updates.slice(i, i + 450));
  for (const chunk of chunks) {
    const batch = db().batch();
    chunk.forEach((u) => batch.update(db().collection("products").doc(u.product.id), { categoryId: u.sub.id }));
    await batch.commit();
  }
  console.log(`\nDone. ${updates.length} products reassigned.`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
