// One-off dedup pass. The 196-item catalog and the restored 119-item catalog share 9
// brands (Surf Excel, Wheel, Comfort, Vim, Dove, Lux, Lifebuoy, Pears, Horlicks) — no
// two products across the whole 310-item catalog have an EXACT matching name (verified),
// but several are clearly the same real product line described differently, e.g. "Vim
// Bar / Tub" (new, 500gm) vs the pre-existing "Vim Dishwash Bar Tub 500g" (500g). For
// each such pair this script keeps the older, more specific product as the surviving
// doc, adds any of the new product's pack-size variants that aren't already covered,
// then deletes the redundant new-catalog product entirely.
//
// Run with --dry to print the plan only.
require("dotenv").config();
const { db } = require("../config/firebase");
const { COLLECTIONS } = require("../config/constants");

const DRY_RUN = process.argv.includes("--dry");

function variantId(label) {
  return label.toLowerCase().replace(/[^a-z0-9]/g, "_").replace(/^_+|_+$/g, "");
}

// Each entry: the redundant new-catalog product's exact name -> the surviving
// old-catalog product's exact name. Every pair below was verified by hand against the
// live catalog (see conversation) — same brand, same real product line.
const DUP_PAIRS = [
  { redundant: "Vim Bar / Tub", survivor: "Vim Dishwash Bar Tub 500g" },
  { redundant: "Vim Dishwash Liquid / Gel", survivor: "Vim Dishwash Gel Liquid Lemon 250ml" },
  { redundant: "Surf Excel Easy Wash Detergent Liquid", survivor: "Surf Excel Detergent Liquid Easy Wash 500ml" },
  { redundant: "Surf Excel Detergent Powder", survivor: "Surf Excel Detergent Powder Quick Wash 1kg" },
  { redundant: "Wheel Detergent Bar / Powder", survivor: "Wheel Detergent Powder Blue 1kg" },
  { redundant: "Comfort Fabric Conditioner", survivor: "Comfort Fabric Conditioner Blue 220ml" },
  { redundant: "Horlicks Women 400 gm Jar", survivor: "Women's Horlicks Caramel Pet Jar 400g" },
  { redundant: "Horlicks Women 200 gm Pouch", survivor: "Women's Horlicks Caramel Pet Jar 400g" },
  { redundant: "Horlicks Biscuit", survivor: "Horlicks Plain Biscuits 45g" },
  { redundant: "Pears Glycerin Soap (Pure & Gentle)", survivor: "Pears Bathing Soap Pure & Gentle 60g" },
  { redundant: "Dove Cream Beauty Bar", survivor: "Dove Bathing Soap Cream Beauty 50g" },
];

async function run() {
  const firestore = db();
  const prodSnap = await firestore.collection(COLLECTIONS.PRODUCTS).get();
  const byName = {};
  prodSnap.docs.forEach((d) => { byName[d.data().name] = { id: d.id, ...d.data() }; });

  const plan = [];
  for (const pair of DUP_PAIRS) {
    const redundant = byName[pair.redundant];
    const survivor = byName[pair.survivor];
    if (!redundant) { console.warn(`SKIP: redundant product "${pair.redundant}" not found`); continue; }
    if (!survivor) { console.warn(`SKIP: survivor product "${pair.survivor}" not found`); continue; }

    const existingLabels = new Set(survivor.variants.map((v) => v.label.toLowerCase()));
    const newVariants = redundant.variants.filter((v) => {
      // Compound labels like "250 ml / 500 ml" (one source line-item covering two sizes
      // in a single string) would create a confusing near-duplicate variant alongside a
      // clean existing "250ml" — skip merging these; the concept is already covered.
      if (v.label.includes("/")) return false;
      return !existingLabels.has(v.label.toLowerCase());
    });

    plan.push({ redundant, survivor, newVariants });
  }

  console.log("=".repeat(70));
  console.log("DEDUP PLAN");
  console.log("=".repeat(70));
  for (const { redundant, survivor, newVariants } of plan) {
    console.log(`\n"${redundant.name}" (${redundant.variants.map((v) => v.label).join(", ")})`);
    console.log(`  -> merged into "${survivor.name}" (currently: ${survivor.variants.map((v) => v.label).join(", ")})`);
    if (newVariants.length) {
      console.log(`  -> adds variant(s): ${newVariants.map((v) => `${v.label}=₹${v.price}`).join(", ")}`);
    } else {
      console.log(`  -> exact size already covered, no new variant added`);
    }
    console.log(`  -> deletes product doc ${redundant.id}`);
  }
  console.log(`\n${plan.length} duplicate pairs resolved, ${plan.length} product docs will be deleted.`);

  if (DRY_RUN) {
    console.log("\nDry run — no writes performed.");
    process.exit(0);
  }

  for (const { redundant, survivor, newVariants } of plan) {
    if (newVariants.length) {
      const updatedVariants = [...survivor.variants, ...newVariants.map((v) => ({ ...v, id: variantId(v.label) }))];
      await firestore.collection(COLLECTIONS.PRODUCTS).doc(survivor.id).update({ variants: updatedVariants, updatedAt: Date.now() });
    }
    await firestore.collection(COLLECTIONS.PRODUCTS).doc(redundant.id).delete();
    console.log(`Merged and deleted "${redundant.name}"`);
  }

  console.log(`\nDone. ${plan.length} duplicate products removed.`);
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
