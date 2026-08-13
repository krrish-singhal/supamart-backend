// One-off, additive-only restore: brings the original 119-product catalog (from
// seedProducts.js's PRODUCTS_DATA, before it was wiped by reseedNewCatalog.js) back
// alongside the current 191-product catalog, so both coexist — nothing currently in
// Firestore gets deleted or modified by this script. Dedup is by exact name match:
// a category/brand with the same name already live is reused (its id), never
// duplicated; verified beforehand that there are zero product-name or category-name
// collisions between the two catalogs, and exactly 9 brand-name collisions (Surf Excel,
// Wheel, Comfort, Vim, Dove, Lux, Lifebuoy, Pears, Horlicks) which reuse the existing doc.
//
// Run with --dry to print the plan only. Run addMissingSubCategories.js and
// assignProductSubCategories.js again afterward to restore the original subcategory
// structure (both scripts are already additive/idempotent, safe to re-run as-is).
require("dotenv").config();
const { db } = require("../config/firebase");
const { COLLECTIONS, AVAILABILITY } = require("../config/constants");

const DRY_RUN = process.argv.includes("--dry");

const raw = require("fs").readFileSync(__dirname + "/seedProducts.js", "utf8");
const match = raw.match(/const PRODUCTS_DATA = (\[[\s\S]*?\n\]);/);
const PRODUCTS_DATA = eval(match[1]);

const BRAND_ALIASES = { "TRESemme": "TRESemmé", "Close Up": "Closeup" };

function imgs() {
  // Matches the original seed's per-category Cloudinary demo placeholders — but those
  // were never real per-product photos anyway (see productImages.js's GENERIC_STOCK_PHOTO
  // handling); leaving images empty here is consistent with how the 191-product catalog
  // was seeded, and the frontend's restored local productImages.js map supplies the real
  // bundled photo for these 119 by product name.
  return [];
}

function variantId(label) {
  return label.toLowerCase().replace(/[^a-z0-9]/g, "_");
}

function parseSize(name) {
  const m = name.match(/(\d+(?:\.\d+)?)\)?\s?(kg|g|ml|l|pcs)\b(?!.*\d)/i);
  if (!m) return { label: "Standard Pack", unit: "pack" };
  return { label: `${m[1]}${m[2]}`, unit: m[2].toLowerCase() };
}

const DEFAULT_STOCK = 100;

async function run() {
  const firestore = db();
  const now = Date.now();

  const catSnap = await firestore.collection(COLLECTIONS.CATEGORIES).get();
  const existingCats = catSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const topByName = {};
  existingCats.filter((c) => !c.parentId).forEach((c) => { topByName[c.name] = c; });
  // "Top::Sub" -> category doc, for Detergent's original 6 subcategories (Powder/Bars/
  // Bleach/Matic Liquid/Fabric Conditioner/Liquid) — these were part of the base seed
  // itself (each product's own `subCategory` field), unlike the other 11 categories'
  // subcategories, which were added later by addMissingSubCategories.js and are re-run
  // separately after this script.
  const subByKey = {};
  existingCats.filter((c) => c.parentId).forEach((c) => {
    const parent = existingCats.find((p) => p.id === c.parentId);
    if (parent) subByKey[`${parent.name}::${c.name}`] = c;
  });

  const brandSnap = await firestore.collection(COLLECTIONS.BRANDS).get();
  const existingBrands = brandSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const brandByName = {};
  existingBrands.forEach((b) => { brandByName[b.name] = b; });

  const prodSnap = await firestore.collection(COLLECTIONS.PRODUCTS).get();
  const existingProductNames = new Set(prodSnap.docs.map((d) => d.data().name));

  const requiredCategories = [...new Set(PRODUCTS_DATA.map((p) => p.category))];
  const categoriesToCreate = requiredCategories.filter((c) => !topByName[c]);

  const requiredSubcats = [...new Set(
    PRODUCTS_DATA.filter((p) => p.subCategory).map((p) => `${p.category}::${p.subCategory}`)
  )];
  const subcatsToCreate = requiredSubcats.filter((key) => !subByKey[key]);

  const requiredBrands = [...new Set(PRODUCTS_DATA.map((p) => BRAND_ALIASES[p.brand] || p.brand))];
  const brandsToCreate = requiredBrands.filter((b) => !brandByName[b]);
  const brandsReused = requiredBrands.filter((b) => brandByName[b]);

  const productsToCreate = PRODUCTS_DATA.filter((p) => !existingProductNames.has(p.name));
  const productsSkipped = PRODUCTS_DATA.filter((p) => existingProductNames.has(p.name));

  console.log("=".repeat(70));
  console.log("RESTORE PLAN (additive — nothing existing gets deleted or modified)");
  console.log("=".repeat(70));
  console.log(`\nTop-level categories to create: ${categoriesToCreate.length}`);
  categoriesToCreate.forEach((c) => console.log(`  - ${c}`));
  console.log(`\nDetergent subcategories to create: ${subcatsToCreate.length}`);
  subcatsToCreate.forEach((k) => console.log(`  - ${k}`));
  console.log(`\nBrands to create: ${brandsToCreate.length}`);
  brandsToCreate.forEach((b) => console.log(`  - ${b}`));
  console.log(`\nBrands reused (exact name already exists — no duplicate created): ${brandsReused.length}`);
  brandsReused.forEach((b) => console.log(`  - ${b} -> ${brandByName[b].id}`));
  console.log(`\nProducts to create: ${productsToCreate.length}`);
  console.log(`Products skipped (name already exists — would be a duplicate): ${productsSkipped.length}`);
  productsSkipped.forEach((p) => console.log(`  - ${p.name}`));

  if (DRY_RUN) {
    console.log("\nDry run — no writes performed.");
    process.exit(0);
  }

  // ── Create missing top-level categories ─────────────────────────────────
  let catOrder = existingCats.filter((c) => !c.parentId).length;
  for (const name of categoriesToCreate) {
    const ref = await firestore.collection(COLLECTIONS.CATEGORIES).add({
      name, image: "", imageKey: null, order: catOrder++, parentId: null, isActive: true, createdAt: now, updatedAt: now,
    });
    topByName[name] = { id: ref.id, name };
    console.log(`Created category "${name}" -> ${ref.id}`);
  }

  // ── Create missing Detergent subcategories ──────────────────────────────
  for (const key of subcatsToCreate) {
    const [parentName, subName] = key.split("::");
    const parent = topByName[parentName];
    const siblingCount = Object.keys(subByKey).filter((k) => k.startsWith(`${parentName}::`)).length;
    const ref = await firestore.collection(COLLECTIONS.CATEGORIES).add({
      name: subName, image: "", imageKey: null, order: siblingCount, parentId: parent.id, isActive: true, createdAt: now, updatedAt: now,
    });
    subByKey[key] = { id: ref.id, name: subName };
    console.log(`Created subcategory "${parentName}" > "${subName}" -> ${ref.id}`);
  }

  // ── Create missing brands ────────────────────────────────────────────────
  let brandOrder = existingBrands.length;
  for (const name of brandsToCreate) {
    const ref = await firestore.collection(COLLECTIONS.BRANDS).add({
      name, logoUrl: "", order: brandOrder++, isActive: true, createdAt: now, updatedAt: now,
    });
    brandByName[name] = { id: ref.id, name };
    console.log(`Created brand "${name}" -> ${ref.id}`);
  }

  // ── Create missing products ──────────────────────────────────────────────
  const chunks = [];
  for (let i = 0; i < productsToCreate.length; i += 450) chunks.push(productsToCreate.slice(i, i + 450));
  let created = 0;
  for (const chunk of chunks) {
    const batch = firestore.batch();
    chunk.forEach((product, idx) => {
      const categoryId = product.subCategory
        ? subByKey[`${product.category}::${product.subCategory}`].id
        : topByName[product.category].id;
      const brandId = brandByName[BRAND_ALIASES[product.brand] || product.brand].id;
      const { label, unit } = parseSize(product.name);
      const docRef = firestore.collection(COLLECTIONS.PRODUCTS).doc();
      batch.set(docRef, {
        name: product.name,
        description: "",
        categoryId,
        brandId,
        unit,
        images: imgs(),
        variants: [{ id: variantId(label), label, price: product.mrp, offerPrice: null, stock: DEFAULT_STOCK }],
        availability: AVAILABILITY.AVAILABLE,
        isAvailableToday: true,
        isFeatured: idx % 30 === 0,
        isTrending: idx % 30 === 1,
        soldCount: 0,
        createdAt: now,
        updatedAt: now,
      });
    });
    await batch.commit();
    created += chunk.length;
  }
  console.log(`\nDone. ${created} products created, ${categoriesToCreate.length} categories + ${subcatsToCreate.length} subcategories created, ${brandsToCreate.length} brands created, ${brandsReused.length} brands reused.`);
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
