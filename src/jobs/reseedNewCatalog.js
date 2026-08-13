// One-off catalog replacement job. Run with `node src/jobs/reseedNewCatalog.js --dry`
// to print the full plan without writing anything; drop --dry to execute for real.
//
// Replaces the ENTIRE existing products/categories/brands collections with the new
// catalog the client supplied (backend/src/jobs/data/newCatalogData.json) — this is a
// full destructive replacement, not a merge (confirmed: zero product-name overlap
// between the two catalogs). 70 of the 196 source items have mrp: null (mostly bulk
// rice/dal/jaggery bags and a few multi-item/assorted lines) — per explicit client
// instruction these are seeded anyway at a ₹0 placeholder price rather than being
// dropped; see the printed "₹0 PLACEHOLDER PRICE" section for the exact list that needs
// a real price entered in the admin portal.
require("dotenv").config();
const { db } = require("../config/firebase");
const { COLLECTIONS, AVAILABILITY } = require("../config/constants");
const RAW_DATA = require("./data/newCatalogData.json");

const DRY_RUN = process.argv.includes("--dry");
const DEFAULT_STOCK = 50;

// "Personal Care - Soaps" -> parent "Personal Care", subcategory "Soaps". Every other
// category string in the source data is flat (no " - " split) and becomes a plain
// top-level category.
function splitCategory(raw) {
  const parts = raw.split(" - ");
  if (parts.length === 2) return { top: parts[0].trim(), sub: parts[1].trim() };
  return { top: raw.trim(), sub: null };
}

// Hand-curated from the 121 distinct priced product names — a generic regex guess would
// mis-split names like "R.G. Palm Oil" or "50-50 Biscuits". Names with no discernible
// brand (loose spices, plain commodities like jaggery/dal/rice varieties without a
// consumer-facing brand on them) map to null, which the schema allows.
const BRAND_MAP = {
  "Prakrithi Coconut Oil": "Prakrithi",
  "Pavithram Gingelly (Sesame) Oil": "Pavithram",
  "Pulari Rice Bran Oil": "Pulari",
  "Ruchi Gold Palm Oil": "Ruchi Gold",
  "R.G. Palm Oil": "R.G.",
  "Milma Ghee": "Milma",
  "Milma Ghee Cake": "Milma",
  "Milma Butter": "Milma",
  "Milma Paneer": "Milma",
  "Milma Ghee Cake / Choco Brownie": "Milma",
  "Chicken Masala Powder": null,
  "Garam Masala Powder": null,
  "Black Pepper Powder": null,
  "Cumin (Jeera) Powder": null,
  "Kashmiri Chilli Powder": null,
  "Turmeric Powder": null,
  "Coriander Powder": null,
  "Chilli Powder": null,
  "Devon Chilly Powder": "Devon",
  "TT Asafoetida (Kayam)": "TT",
  "TT Asafoetida Cake": "TT",
  "Ginger Garlic Paste": null,
  "Bakers Kasuri Methi": "Bakers",
  "Elite Atta": "Elite",
  "Elite Maida": "Elite",
  "Elite Rava": "Elite",
  "DH Corn Flour": "DH",
  "UT Puttu Podi": "UT",
  "UT Appam Podi": "UT",
  "UT Uppuma Rava": "UT",
  "Idiyappam Podi (steamed)": null,
  "DH Idiyappam / Appam Podi": "DH",
  "DH White Puttu Podi": "DH",
  "DH Roast Ragi Powder": "DH",
  "DH Macroni": "DH",
  "DH Vermicelli Mix": "DH",
  "DH Palada Payasam Mix": "DH",
  "DH Easy Idiyappam": "DH",
  "DH Chicken Masala Idiyappam Mix": "DH",
  "DH Turmeric Powder": "DH",
  "Quaker Oats": "Quaker",
  "QK Multigrain Oats": "Quaker",
  "Pringles Sour & Cream": "Pringles",
  "Pringles Original": "Pringles",
  "Pringles Desi Masala": "Pringles",
  "NC Thin Arrowroot Biscuit": "Britannia",
  "50-50 Biscuits": "Britannia",
  "Good Day Chocochip": "Britannia",
  "Good Day Pista Badam": "Britannia",
  "Good Day Cashew": "Britannia",
  "Good Day Butter": "Britannia",
  "Marie Gold": "Britannia",
  "Milk Bikis Milk Cream": "Britannia",
  "NC Cracker Lite": "Britannia",
  "Tiger Krunch Choco": "Britannia",
  "Tiger KR Coconut": "Britannia",
  "Milk Rusk Restage": "Britannia",
  "Premium Bake Rusk": "Britannia",
  "Snickers": "Snickers",
  "Kellogg's Chocos": "Kellogg's",
  "Kellogg's Corn Flakes": "Kellogg's",
  "Horlicks Women 400 gm Jar": "Horlicks",
  "Horlicks Women 200 gm Pouch": "Horlicks",
  "Boost 500 gm Jar": "Boost",
  "Boost 200 gm Pouch": "Boost",
  "Horlicks Biscuit": "Horlicks",
  "Pran Litchi Drink": "Pran",
  "Pran Pudding Jar": "Pran",
  "Medimix Soap": "Medimix",
  "Santoor Soap (White/Set)": "Santoor",
  "Power Soap": "Power",
  "Hamam Soap": "Hamam",
  "Lux Advanced Bright Glow": "Lux",
  "Pears Glycerin Soap (Pure & Gentle)": "Pears",
  "Lifebuoy Total Protect": "Lifebuoy",
  "Lifebuoy Neem & Aloe Soap": "Lifebuoy",
  "Dove Pink Serum Beauty Bar": "Dove",
  "Dove Cream Beauty Bar": "Dove",
  "Dabur Vatika Hair Oil": "Dabur",
  "Dabur Amla Hair Oil": "Dabur",
  "Dabur Almond Hair Oil": "Dabur",
  "Dabur Red Toothpaste": "Dabur",
  "KP Herbal Paste": "KP",
  "Dabur Glucose": "Dabur",
  "Sensodyne Rapid Relief Paste": "Sensodyne",
  "Sensodyne Fresh Gel Paste": "Sensodyne",
  "Sensodyne Sensitive Toothbrush": "Sensodyne",
  "Yardley Red Rose Talc": "Yardley",
  "Yardley Lavender Talc": "Yardley",
  "Yardley English Rose Talc": "Yardley",
  "Vim Dishwash Liquid / Gel": "Vim",
  "Vim Bar / Tub": "Vim",
  "Surf Excel Easy Wash Detergent Liquid": "Surf Excel",
  "Surf Excel Detergent Powder": "Surf Excel",
  "Sunlight Detergent Powder": "Sunlight",
  "Sunlight Dishwash Liquid": "Sunlight",
  "Comfort Fabric Conditioner": "Comfort",
  "Wheel Detergent Bar / Powder": "Wheel",
  "Ujala Y&F Bliss/Aura Sachet": "Ujala",
  "Maxo Coil (Mosquito Repellent)": "Maxo",
  "Maxo Genius Combi": "Maxo",
  "Exo Dishwash Bar": "Exo",
  "E-fee Washing Liquid": "E-fee",
  "Devon Corn Starch (household/cooking use)": "Devon",
  "Anus Lemon Pickle": "Anus",
  "Anus Mango Pickle": "Anus",
  "Anus Tender Mango Pickle": "Anus",
  "Anus Chilly Sauce": "Anus",
  "Anus Soya Sauce": "Anus",
  "Anus Tomatto Sauce": "Anus",
  "Anus Dates Pickle": "Anus",
  "Anus Chukku Kappi (Ginger Coffee Mix)": "Anus",
  "Ginger Pickle": null,
  "Red Chilly Sauce": null,
  "Milk Rusk / Premium Bake Rusk": "Britannia",
  "Cycle 3-in-1 Agarbathi": "Cycle",
  "Lia Agarbathy (Apple/Rose/Lavender/Jasmine)": "Lia",
  "Gold Walnut": null,
  "Dates Syrup": null,
  "Dry Grapes Seedless (HD)": null,
  "Kadala Mavu (Chickpea Flour)": null,

  // Originally-unpriced items (now seeded at a ₹0 placeholder per client instruction).
  "Mutton Masala Powder": null,
  "Egg Masala Powder": null,
  "Meat Masala Powder": null,
  "Sambar Powder": null,
  "Devon Coriander Powder": "Devon",
  "Elite Rice Puttu Podi": "Elite",
  "Pulari Rice Bran (rice)": "Pulari",
  "Rose Kaima Rice": null,
  "Sarkara (Jaggery)": null,
  "Kadala Paruppu (Chana Dal)": null,
  "Cheru Paruppu (Moong Dal)": null,
  "Green Peas 1st": null,
  "White Kadala / Black Benny": null,
  "Red Masoor Dal": null,
  "Vada Paruppu (Urad Dal)": null,
  "Maharaja Orid Dhall": "Maharaja",
  "SSK Ponni Rice 1st": "SSK",
  "S S K Doppi Rice 1st": "SSK",
  "Nirmal Urutty Rose Rice": "Nirmal",
  "Kitchen King BT Rice": "Kitchen King",
  "Dolphin IR8 Pachari Rice": "Dolphin",
  "KPR Jaya Rice": "KPR",
  "786 Surekha Rice": "786",
  "Bharath Doppi Rice": "Bharath",
  "True Blue Dragon Noodles": "True Blue",
  "Maggi 2-Minute Noodles": "Maggi",
  "Maggi Pazzta": "Maggi",
  "Munch Chocolate Wafer": "Munch",
  "Yippee Magic Masala Noodles": "Yippee",
  "Sunfeast Marie Light": "Sunfeast",
  "Sunfeast Marie Glucose": "Sunfeast",
  "Sunfeast Golden Bakery": "Sunfeast",
  "Bourbon Neapolitan Cream (BNC) - Pineapple/Orange/Elaichi": "Britannia",
  "Dark Fantasy Bourbon": "Sunfeast",
  "Dark Fantasy Vanilla": "Sunfeast",
  "Dream Cream Orange / Cashewnut": "Britannia",
  "Bounty (S.Bounty)": "Bounty",
  "Kit Kat Miniatures": "Kit Kat",
  "AVT Premium Tea": "AVT",
  "Nescafe Classic Jar": "Nescafe",
  "Nescafe Sunrise": "Nescafe",
  "Vivel / Fiama products (assorted)": null,
  "Ujala Crystal White Liquid": "Ujala",
  "Sara Soap Podi (washing powder)": "Sara",
  "Cashew Split": null,
  "Kismiss Medium (Raisins Seedless)": null,
  "Cucumber": null,
  "Capsicum (Green)": null,
  "Lemon": null,
  "Green Chilly": null,
  "Mint Leaves (Puthina)": null,
  "Curry Leaves (K. Leaves)": null,
  "Coriander Leaves (Malli)": null,
  "Ladies Finger": null,
  "Mango": null,
  "Long Beans (Payeru)": null,
  "Brinjal": null,
  "Carrot": null,
  "Beet Root": null,
  "Potato": null,
  "Ginger": null,
  "Gooseberry (Nelli Kai)": null,
  "Local Greens (Bal Chambu)": null,
  "Yam (Senai Kilangu)": null,
  "Raw Mango (Amrai)": null,
  "Banana Flower (Ullie Poo)": null,
  "Flowers (assorted, for pooja)": null,
  "Ivy Gourd (Kovai Kai)": null,
  "Drumstick (Salladu)": null,
  "Beans": null,
};

function variantId(label) {
  return label.toLowerCase().replace(/[^a-z0-9]/g, "_").replace(/^_+|_+$/g, "");
}

// unit is a single required string per product (not per variant) — derived from the
// first variant's pack size using simple keyword matching. Falls back to "pack" when the
// pack size doesn't mention a recognizable measure (e.g. "Piece", "Pack").
function deriveUnit(packSize) {
  const s = packSize.toLowerCase();
  if (/\bkg\b/.test(s)) return "kg";
  if (/\bgm?\b/.test(s)) return "g";
  if (/\bltr|liter|litre|\bl\b/.test(s)) return "L";
  if (/\bml\b/.test(s)) return "ml";
  if (/\bpiece\b/.test(s)) return "pcs";
  return "pack";
}

async function deleteCollection(firestore, collectionName) {
  const snap = await firestore.collection(collectionName).get();
  const docs = snap.docs;
  const chunks = [];
  for (let i = 0; i < docs.length; i += 450) chunks.push(docs.slice(i, i + 450));
  for (const chunk of chunks) {
    const batch = firestore.batch();
    chunk.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }
  return docs.length;
}

async function run() {
  const firestore = db();
  const now = Date.now();

  const wasUnpriced = RAW_DATA.filter((d) => d.mrp === null);
  // Every item is seeded — null mrp becomes an explicit ₹0 placeholder rather than being
  // dropped, per client instruction.
  const allItems = RAW_DATA.map((d) => ({ ...d, mrp: d.mrp === null ? 0 : d.mrp }));

  // ── Build category plan ──────────────────────────────────────────────────
  const topCategoryNames = new Set();
  const subCategoriesByParent = {}; // parentName -> Set(subName)
  for (const raw of new Set(RAW_DATA.map((d) => d.category))) {
    const { top, sub } = splitCategory(raw);
    topCategoryNames.add(top);
    if (sub) {
      subCategoriesByParent[top] = subCategoriesByParent[top] || new Set();
      subCategoriesByParent[top].add(sub);
    }
  }

  // ── Build product plan: group priced line-items by product_name into one doc
  //    per name, each pack_size becoming a separate variant ───────────────────
  const productsByName = {};
  for (const item of allItems) {
    if (!productsByName[item.product_name]) {
      productsByName[item.product_name] = { category: item.category, name: item.product_name, variants: [] };
    }
    productsByName[item.product_name].variants.push({ packSize: item.pack_size, mrp: item.mrp });
  }
  const productPlans = Object.values(productsByName);

  const requiredBrands = [...new Set(productPlans.map((p) => BRAND_MAP[p.name]).filter(Boolean))];

  // ── Print plan ────────────────────────────────────────────────────────────
  console.log("=".repeat(70));
  console.log("RESEED PLAN");
  console.log("=".repeat(70));
  console.log(`\nCategories: ${topCategoryNames.size} top-level`);
  for (const top of topCategoryNames) {
    const subs = subCategoriesByParent[top];
    console.log(`  - ${top}${subs ? ` (${subs.size} sub: ${[...subs].join(", ")})` : ""}`);
  }
  console.log(`\nBrands to ensure exist: ${requiredBrands.length}`);
  console.log(`  ${requiredBrands.join(", ")}`);
  console.log(`\nProducts to create: ${productPlans.length} (from ${allItems.length} line-items)`);
  for (const p of productPlans) {
    const brand = BRAND_MAP[p.name] || "(no brand)";
    console.log(`  - [${p.category}] ${p.name} — ${brand} — ${p.variants.length} variant(s): ${p.variants.map((v) => `${v.packSize}=₹${v.mrp}`).join(", ")}`);
  }
  console.log(`\n₹0 PLACEHOLDER PRICE — needs a real price entered in the admin portal (${wasUnpriced.length} of ${RAW_DATA.length} total items):`);
  for (const s of wasUnpriced) {
    console.log(`  - [${s.category}] ${s.product_name} (${s.pack_size})`);
  }

  const existingProdSnap = await firestore.collection(COLLECTIONS.PRODUCTS).get();
  const existingCatSnap = await firestore.collection(COLLECTIONS.CATEGORIES).get();
  const existingBrandSnap = await firestore.collection(COLLECTIONS.BRANDS).get();
  console.log(`\nWill DELETE: ${existingProdSnap.size} existing products, ${existingCatSnap.size} existing categories, ${existingBrandSnap.size} existing brands (all replaced by the plan above).`);

  if (DRY_RUN) {
    console.log("\nDry run — no writes performed.");
    process.exit(0);
  }

  // ── Execute ───────────────────────────────────────────────────────────────
  console.log("\nDeleting existing catalog...");
  await deleteCollection(firestore, COLLECTIONS.PRODUCTS);
  await deleteCollection(firestore, COLLECTIONS.CATEGORIES);
  await deleteCollection(firestore, COLLECTIONS.BRANDS);

  console.log("Creating categories...");
  const categoryIdByKey = {}; // "Top" or "Top::Sub" -> id
  let catOrder = 0;
  for (const top of topCategoryNames) {
    const ref = await firestore.collection(COLLECTIONS.CATEGORIES).add({
      name: top, image: "", imageKey: null, order: catOrder++, parentId: null, isActive: true, createdAt: now, updatedAt: now,
    });
    categoryIdByKey[top] = ref.id;
    const subs = subCategoriesByParent[top];
    if (subs) {
      let subOrder = 0;
      for (const sub of subs) {
        const subRef = await firestore.collection(COLLECTIONS.CATEGORIES).add({
          name: sub, image: "", imageKey: null, order: subOrder++, parentId: ref.id, isActive: true, createdAt: now, updatedAt: now,
        });
        categoryIdByKey[`${top}::${sub}`] = subRef.id;
      }
    }
  }

  console.log("Creating brands...");
  const brandIdByName = {};
  let brandOrder = 0;
  for (const name of requiredBrands) {
    const ref = await firestore.collection(COLLECTIONS.BRANDS).add({
      name, logoUrl: "", order: brandOrder++, isActive: true, createdAt: now, updatedAt: now,
    });
    brandIdByName[name] = ref.id;
  }

  console.log("Creating products...");
  const chunks = [];
  for (let i = 0; i < productPlans.length; i += 450) chunks.push(productPlans.slice(i, i + 450));
  let created = 0;
  for (const chunk of chunks) {
    const batch = firestore.batch();
    chunk.forEach((p, idx) => {
      const { top, sub } = splitCategory(p.category);
      const categoryId = sub ? categoryIdByKey[`${top}::${sub}`] : categoryIdByKey[top];
      const brandName = BRAND_MAP[p.name];
      const brandId = brandName ? brandIdByName[brandName] : null;
      const unit = deriveUnit(p.variants[0].packSize);
      const variants = p.variants.map((v) => ({
        id: variantId(v.packSize),
        label: v.packSize,
        price: v.mrp,
        offerPrice: null,
        stock: DEFAULT_STOCK,
      }));
      const docRef = firestore.collection(COLLECTIONS.PRODUCTS).doc();
      batch.set(docRef, {
        name: p.name,
        description: "",
        categoryId,
        brandId,
        unit,
        images: [], // no bundled/uploaded photo yet — frontend falls back to a live Open Food Facts lookup
        variants,
        availability: AVAILABILITY.AVAILABLE,
        isAvailableToday: true,
        isFeatured: idx % 30 === 0,
        isTrending: false,
        soldCount: 0,
        createdAt: now,
        updatedAt: now,
      });
    });
    await batch.commit();
    created += chunk.length;
  }
  console.log(`\nDone. ${created} products, ${Object.keys(categoryIdByKey).length} categories, ${requiredBrands.length} brands created.`);
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
