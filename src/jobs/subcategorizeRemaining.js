// Adds sub-categories to the top-level categories that were left flat (zero subs,
// products sitting directly on the top-level doc) — Cooking Oils & Ghee, Dairy,
// Spices & Masala, Rice/Atta/Grains, Instant/Ready-to-Cook Mixes, Dry Fruits & Nuts,
// and Fresh Vegetables. Same pattern as consolidateCategories.js: create each named
// sub-category under its existing top-level (parentId unchanged, no rename/merge/
// delete needed here since these top-levels aren't overlapping with anything), then
// move every listed product's categoryId from the top-level onto the new sub.
//
// "Bakery Items" (0 products) and "Pooja & Devotional Items" (2 products, both
// agarbathi/incense) are deliberately left flat — too few/no products to make
// sub-categorization meaningful.
//
// Run with --dry to print the full plan (including validating every product name
// actually exists, and that nothing in these top-levels was forgotten) without
// writing anything.
require("dotenv").config();
const { db } = require("../config/firebase");
const { COLLECTIONS } = require("../config/constants");

const DRY_RUN = process.argv.includes("--dry");

const COOKING_OILS_GHEE_SUBS = {
  "Cooking Oils": ["Pulari Rice Bran Oil", "R.G. Palm Oil", "Prakrithi Coconut Oil", "Ruchi Gold Palm Oil", "Pavithram Gingelly (Sesame) Oil"],
  "Ghee": ["Milma Ghee Cake", "Milma Ghee"],
};

const DAIRY_SUBS = {
  "Butter": ["Milma Butter"],
  "Paneer": ["Milma Paneer"],
  "Dairy Sweets": ["Milma Ghee Cake / Choco Brownie"],
};

const SPICES_MASALA_SUBS = {
  "Masala Powders": ["Coriander Powder", "Meat Masala Powder", "Devon Chilly Powder", "Egg Masala Powder", "Kashmiri Chilli Powder", "Chicken Masala Powder", "Mutton Masala Powder", "Chilli Powder", "Devon Coriander Powder", "Cumin (Jeera) Powder", "Turmeric Powder", "Garam Masala Powder", "Black Pepper Powder", "Sambar Powder"],
  "Asafoetida": ["TT Asafoetida Cake", "TT Asafoetida (Kayam)"],
  "Herbs & Pastes": ["Bakers Kasuri Methi", "Ginger Garlic Paste"],
};

const RICE_ATTA_GRAINS_SUBS = {
  "Rice": ["Rose Kaima Rice", "SSK Ponni Rice 1st", "S S K Doppi Rice 1st", "Dolphin IR8 Pachari Rice", "Kitchen King BT Rice", "Nirmal Urutty Rose Rice", "Bharath Doppi Rice", "KPR Jaya Rice", "Pulari Rice Bran (rice)", "786 Surekha Rice"],
  "Atta, Maida & Flour": ["Elite Maida", "Devon Corn Starch (household/cooking use)", "DH Corn Flour", "Elite Atta", "Elite Rava", "Elite Rice Puttu Podi"],
  "Pulses & Dals": ["Red Masoor Dal", "White Kadala / Black Benny", "Cheru Paruppu (Moong Dal)", "Kadala Paruppu (Chana Dal)", "Vada Paruppu (Urad Dal)", "Maharaja Orid Dhall", "Green Peas 1st"],
  "Jaggery & Sweeteners": ["Sarkara (Jaggery)"],
};

const INSTANT_MIXES_SUBS = {
  "Idiyappam & Puttu Mixes": ["DH White Puttu Podi", "DH Easy Idiyappam", "UT Appam Podi", "UT Puttu Podi", "DH Chicken Masala Idiyappam Mix", "Idiyappam Podi (steamed)", "DH Idiyappam / Appam Podi"],
  "Breakfast Cereals": ["Kellogg's Chocos", "Quaker Oats", "QK Multigrain Oats", "Kellogg's Corn Flakes"],
  "Rava, Vermicelli & Payasam Mix": ["UT Uppuma Rava", "DH Palada Payasam Mix", "DH Vermicelli Mix", "DH Macroni"],
  "Health & Traditional Mixes": ["Anus Chukku Kappi (Ginger Coffee Mix)", "DH Turmeric Powder", "DH Roast Ragi Powder"],
};

const DRY_FRUITS_NUTS_SUBS = {
  "Dry Fruits & Nuts": ["Kismiss Medium (Raisins Seedless)", "Dry Grapes Seedless (HD)", "Cashew Split", "Gold Walnut"],
  "Flours & Syrups": ["Kadala Mavu (Chickpea Flour)", "Dates Syrup"],
};

const FRESH_VEGETABLES_SUBS = {
  "Vegetables": ["Brinjal", "Yam (Senai Kilangu)", "Banana Flower (Ullie Poo)", "Ivy Gourd (Kovai Kai)", "Ladies Finger", "Carrot", "Beet Root", "Green Chilly", "Ginger", "Drumstick (Salladu)", "Capsicum (Green)", "Beans", "Cucumber", "Long Beans (Payeru)", "Potato"],
  "Leafy Greens & Herbs": ["Mint Leaves (Puthina)", "Coriander Leaves (Malli)", "Curry Leaves (K. Leaves)", "Local Greens (Bal Chambu)"],
  "Fruits": ["Gooseberry (Nelli Kai)", "Raw Mango (Amrai)", "Mango", "Lemon"],
  "Pooja Flowers": ["Flowers (assorted, for pooja)"],
};

const TOP_LEVELS = [
  { name: "Cooking Oils & Ghee", subs: COOKING_OILS_GHEE_SUBS },
  { name: "Dairy", subs: DAIRY_SUBS },
  { name: "Spices & Masala", subs: SPICES_MASALA_SUBS },
  { name: "Rice, Atta & Grains", subs: RICE_ATTA_GRAINS_SUBS },
  { name: "Instant / Ready-to-Cook Mixes", subs: INSTANT_MIXES_SUBS },
  { name: "Dry Fruits & Nuts", subs: DRY_FRUITS_NUTS_SUBS },
  { name: "Fresh Vegetables", subs: FRESH_VEGETABLES_SUBS },
];

async function run() {
  const firestore = db();
  const now = Date.now();

  const catSnap = await firestore.collection(COLLECTIONS.CATEGORIES).get();
  const cats = catSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const topByName = {};
  cats.filter((c) => !c.parentId).forEach((c) => { topByName[c.name] = c; });

  const prodSnap = await firestore.collection(COLLECTIONS.PRODUCTS).get();
  const prodByName = {};
  const prodDupes = new Set();
  prodSnap.docs.forEach((d) => {
    const name = d.data().name;
    if (prodByName[name]) prodDupes.add(name);
    prodByName[name] = { id: d.id, ...d.data() };
  });

  // ── Validate ──────────────────────────────────────────────────────────────────
  const allReferencedNames = TOP_LEVELS.flatMap((t) => Object.values(t.subs).flat());
  const notFound = allReferencedNames.filter((n) => !prodByName[n]);
  const seen = new Set();
  const referencedDupes = allReferencedNames.filter((n) => (seen.has(n) ? true : (seen.add(n), false)));

  console.log("=".repeat(70));
  console.log("VALIDATION");
  console.log("=".repeat(70));
  console.log(`Products referenced in this plan: ${allReferencedNames.length} (${new Set(allReferencedNames).size} unique)`);
  console.log(`Not found in live Firestore: ${notFound.length}`);
  notFound.forEach((n) => console.log("  MISSING:", n));
  console.log(`Referenced more than once in this plan: ${referencedDupes.length}`);
  referencedDupes.forEach((n) => console.log("  DUPLICATE REFERENCE:", n));
  if (prodDupes.size) {
    console.log(`Ambiguous product names (multiple live docs share the name): ${prodDupes.size}`);
    prodDupes.forEach((n) => console.log("  AMBIGUOUS:", n));
  }
  if (notFound.length || referencedDupes.length) {
    console.log("\nAborting: fix the issues above before proceeding.");
    process.exit(1);
  }

  const missingTop = TOP_LEVELS.filter((t) => !topByName[t.name]);
  if (missingTop.length) {
    console.log("\nAborting: top-level categories not found:", missingTop.map((t) => t.name).join(", "));
    process.exit(1);
  }

  // Confirm nothing currently sitting directly on these top-levels was forgotten.
  let forgottenTotal = 0;
  for (const t of TOP_LEVELS) {
    const top = topByName[t.name];
    const currentlyDirect = prodSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => p.categoryId === top.id);
    const planned = new Set(Object.values(t.subs).flat());
    const forgotten = currentlyDirect.filter((p) => !planned.has(p.name));
    if (forgotten.length) {
      console.log(`\nForgotten products currently in "${t.name}" not covered by plan: ${forgotten.length}`);
      forgotten.forEach((p) => console.log("  FORGOTTEN:", p.name));
      forgottenTotal += forgotten.length;
    }
  }
  if (forgottenTotal) {
    console.log("\nAborting: every product currently on these top-levels must be covered by the plan.");
    process.exit(1);
  }

  // ── Print plan ────────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(70));
  console.log("PLAN");
  console.log("=".repeat(70));
  for (const t of TOP_LEVELS) {
    console.log(`\n"${t.name}"`);
    for (const [subName, productNames] of Object.entries(t.subs)) {
      console.log(`  > ${subName}: ${productNames.length} products`);
    }
  }

  if (DRY_RUN) {
    console.log("\nDry run — no writes performed.");
    process.exit(0);
  }

  // ── Execute ───────────────────────────────────────────────────────────────────
  for (const t of TOP_LEVELS) {
    const top = topByName[t.name];
    let subOrder = 0;
    for (const [subName, productNames] of Object.entries(t.subs)) {
      const ref = await firestore.collection(COLLECTIONS.CATEGORIES).add({
        name: subName, image: "", imageKey: null, order: subOrder++, parentId: top.id, isActive: true, createdAt: now, updatedAt: now,
      });
      for (const productName of productNames) {
        const product = prodByName[productName];
        await firestore.collection(COLLECTIONS.PRODUCTS).doc(product.id).update({ categoryId: ref.id, updatedAt: now });
      }
      console.log(`Created "${t.name} > ${subName}" and moved ${productNames.length} products`);
    }
  }

  console.log("\nDone.");
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
