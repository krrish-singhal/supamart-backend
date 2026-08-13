require("dotenv").config();
const { db } = require("../config/firebase");
const { COLLECTIONS, AVAILABILITY, OFFER_KIND, OFFER_SCOPE } = require("../config/constants");

// ---------------------------------------------------------------------------
// Cloudinary demo image URLs — placeholder imagery until the user supplies real
// product photography (per instruction, using stock/demo images "for now").
// ---------------------------------------------------------------------------
const IMG = {
  spices: "https://res.cloudinary.com/demo/image/upload/w_400,h_400,c_fill/samples/food/spices.jpg",
  mussels: "https://res.cloudinary.com/demo/image/upload/w_400,h_400,c_fill/samples/food/pot-mussels.jpg",
  fishVeg: "https://res.cloudinary.com/demo/image/upload/w_400,h_400,c_fill/samples/food/fish-vegetables.jpg",
  bag: "https://res.cloudinary.com/demo/image/upload/w_400,h_400,c_fill/samples/ecommerce/accessories-bag.jpg",
};

const CATEGORY_IMAGE = {
  "Detergent": "mussels",
  "Dishwash": "mussels",
  "Hair Care": "bag",
  "Tea & Coffee": "spices",
  "Bathing Soap": "bag",
  "Sauces & Spreads": "spices",
  "Oral-Care": "bag",
  "Face Wash": "bag",
  "Talc & Grooming": "bag",
  "Breakfast": "spices",
  "Feminine Hygiene": "bag",
  "Health Food Drinks": "fishVeg",
};

// Brand name spellings in the product data that differ from the seeded brand doc name
// (backend/src/jobs/seedBrands.js) but refer to the same real-world brand.
const BRAND_ALIASES = {
  "TRESemme": "TRESemmé",
  "Close Up": "Closeup",
};

function imgs(base, count = 2) {
  return Array.from({ length: count }, (_, i) => `${base}?v=${i + 1}`);
}

function variantId(label) {
  return label.toLowerCase().replace(/[^a-z0-9]/g, "_");
}

// No size/weight is given separately in the source data — it's sometimes embedded at
// the end of the product name (e.g. "...1kg", "...220ml", "...6ml"). Pull it out for the
// variant label/unit; fall back to a generic pack when the name doesn't end with one.
function parseSize(name) {
  const m = name.match(/(\d+(?:\.\d+)?)\)?\s?(kg|g|ml|l|pcs)\b(?!.*\d)/i);
  if (!m) return { label: "Standard Pack", unit: "pack" };
  const unit = m[2].toLowerCase();
  return { label: `${m[1]}${m[2]}`, unit };
}

// ---------------------------------------------------------------------------
// Exact product data as supplied by the user: { category, brand, name, mrp }.
// `subCategory` is added only for Detergent items (inferred from the name) so the
// existing Detergent accordion (Powder/Bars/Bleach/Matic Liquid/Fabric Conditioner/
// Liquid) stays populated — no other field was invented.
// ---------------------------------------------------------------------------
const PRODUCTS_DATA = [
  { category: "Detergent", brand: "Surf Excel", name: "Surf Excel Detergent Powder Easy Wash", mrp: 10, subCategory: "Powder" },
  { category: "Detergent", brand: "Rin", name: "Rin Detergent Bar", mrp: 10, subCategory: "Bars" },
  { category: "Detergent", brand: "Wheel", name: "Wheel Detergent Powder Blue 1kg", mrp: 84, subCategory: "Powder" },
  { category: "Detergent", brand: "Surf Excel", name: "Surf Excel Detergent Bar 100g", mrp: 10, subCategory: "Bars" },
  { category: "Detergent", brand: "Rin", name: "Rin Bleach Ala Bleach 200ml", mrp: 45, subCategory: "Bleach" },
  { category: "Detergent", brand: "Wheel", name: "Wheel L&O Powder A+ 4kg Blue", mrp: 260, subCategory: "Powder" },
  { category: "Detergent", brand: "Surf Excel", name: "Surf Excel Detergent Liquid Matic Top Load Refill", mrp: 149, subCategory: "Matic Liquid" },
  { category: "Detergent", brand: "Comfort", name: "Comfort Fabric Conditioner Pink 220ml", mrp: 58, subCategory: "Fabric Conditioner" },
  { category: "Detergent", brand: "Surf Excel", name: "Surf Excel Detergent Liquid Matic Front Load Refill", mrp: 169, subCategory: "Matic Liquid" },
  { category: "Detergent", brand: "Surf Excel", name: "Surf Excel Detergent Powder Quick Wash 1kg", mrp: 230, subCategory: "Powder" },
  { category: "Detergent", brand: "Rin", name: "Rin Detergent Powder 1kg", mrp: 108, subCategory: "Powder" },
  { category: "Detergent", brand: "Comfort", name: "Comfort Fabric Conditioner Blue 220ml", mrp: 58, subCategory: "Fabric Conditioner" },
  { category: "Detergent", brand: "Surf Excel", name: "Surf Excel Detergent Liquid Easy Wash 500ml", mrp: 105, subCategory: "Liquid" },

  { category: "Dishwash", brand: "Vim", name: "Vim Dishwash Bar 75g", mrp: 5 },
  { category: "Dishwash", brand: "Vim", name: "Vim Dishwash Gel Liquid Lemon 115ml", mrp: 15 },
  { category: "Dishwash", brand: "Vim", name: "Vim Dishwash Bar Tub 500g", mrp: 55 },
  { category: "Dishwash", brand: "Vim", name: "Vim Dishwash Gel Liquid Lemon 250ml", mrp: 60 },
  { category: "Dishwash", brand: "Vim", name: "Vim Bar Tubs Anti-Smell 500g", mrp: 65 },
  { category: "Dishwash", brand: "Vim", name: "Vim Bar 3x190g MPO", mrp: 65 },

  { category: "Hair Care", brand: "Sunsilk", name: "Sunsilk Hair Shampoo Lusciously Thick & Long", mrp: 1 },
  { category: "Hair Care", brand: "Clinic Plus", name: "Clinic Plus Hair Shampoo", mrp: 1 },
  { category: "Hair Care", brand: "Clinic Plus", name: "Clinic Plus Hair Shampoo Strong & Shine 6ml", mrp: 1 },
  { category: "Hair Care", brand: "Dove", name: "Dove Hair Shampoo Hair Fall Therapy", mrp: 2 },
  { category: "Hair Care", brand: "Sunsilk", name: "Sunsilk Hair Shampoo Stunning Black Shine", mrp: 1 },
  { category: "Hair Care", brand: "Dove", name: "Dove Hair Shampoo Daily Shine", mrp: 2 },
  { category: "Hair Care", brand: "Dove", name: "Dove Hair Shampoo Intense Repair", mrp: 2 },
  { category: "Hair Care", brand: "TRESemme", name: "TRESemme Hair Shampoo Keratin Smooth 6ml", mrp: 2 },
  { category: "Hair Care", brand: "Dove", name: "Dove Hair Shampoo Anti Dandruff Therapy", mrp: 2 },
  { category: "Hair Care", brand: "Dove", name: "Dove Hair Conditioner Hair Fall Rescue", mrp: 4 },
  { category: "Hair Care", brand: "Dove", name: "Dove Hair Shampoo & Conditioner Hair Fall Therapy", mrp: 5 },
  { category: "Hair Care", brand: "Clinic Plus", name: "Clinic Plus Strong And Smooth 6ml", mrp: 1 },
  { category: "Hair Care", brand: "Dove", name: "Dove Hair Conditioner Intense Damage Therapy", mrp: 4 },
  { category: "Hair Care", brand: "Indulekha", name: "Indulekha Hair Shampoo Bringha Hair Fall Cleanser", mrp: 2 },
  { category: "Hair Care", brand: "Dove", name: "Dove Hair Conditioner Daily Shine", mrp: 4 },
  { category: "Hair Care", brand: "Dove", name: "Dove Hair Shampoo & Conditioner Intense Repair", mrp: 5 },
  { category: "Hair Care", brand: "TRESemme", name: "TRESemme Smooth & Shine LCS 6ml", mrp: 2 },
  { category: "Hair Care", brand: "TRESemme", name: "TRESemme Hair Conditioner Keratin Smooth", mrp: 123 },
  { category: "Hair Care", brand: "Clear", name: "Clear Hair Oil 75ml", mrp: 65 },
  { category: "Hair Care", brand: "Dove", name: "Dove Men+ Care Ad 2In1 Shampoo+Conditioner", mrp: 2 },
  { category: "Hair Care", brand: "Dove", name: "Dove Daily Shine Shampoo & Conditioner Twin Sachet", mrp: 5 },
  { category: "Hair Care", brand: "Dove", name: "Dove Hair Shampoo Hair Fall Rescue 80ml", mrp: 60 },
  { category: "Hair Care", brand: "Dove", name: "Dove Hair Shampoo Clean & Fresh 6ml", mrp: 2 },
  { category: "Hair Care", brand: "Sunsilk", name: "Sunsilk Hair Shampoo Dream Soft & Smooth", mrp: 1 },
  { category: "Hair Care", brand: "Dove", name: "Dove Hair Shampoo Healthy Ritual For Growing Hair", mrp: 2 },
  { category: "Hair Care", brand: "Sunsilk", name: "Sunsilk Thick & Long Twin (5.5+5.5)ml", mrp: 3 },
  { category: "Hair Care", brand: "TRESemme", name: "TRESemme Hair Conditioner Hair Fall Defense", mrp: 131 },
  { category: "Hair Care", brand: "Dove", name: "Dove Hair Shampoo Dryness Care 80ml", mrp: 60 },
  { category: "Hair Care", brand: "Clinic Plus", name: "Clinic Plus Hair Shampoo Straight & Shine 175ml", mrp: 154 },
  { category: "Hair Care", brand: "Dove", name: "Dove Hair Shampoo Dandruff Care 80ml", mrp: 60 },
  { category: "Hair Care", brand: "Sunsilk", name: "Sunsilk Hair Conditioner Smooth & Tangle Free 80ml", mrp: 106 },
  { category: "Hair Care", brand: "Dove", name: "Dove Hair Conditioner Dryness Care 80ml", mrp: 120 },
  { category: "Hair Care", brand: "Clinic Plus", name: "Clinic Plus Hair Shampoo Strong & Extra Thick 175ml", mrp: 154 },
  { category: "Hair Care", brand: "Clinic Plus", name: "Clinic Plus Hair Shampoo Strong Scalp", mrp: 55 },
  { category: "Hair Care", brand: "Dove", name: "Dove Glycolic Hydration Mid Shampoo 180ml", mrp: 189 },
  { category: "Hair Care", brand: "TRESemme", name: "TRESemme Hair Conditioner Smooth & Shine", mrp: 4 },
  { category: "Hair Care", brand: "TRESemme", name: "TRESemme Hair Shampoo Hair Fall Defense 6ml", mrp: 2 },

  { category: "Tea & Coffee", brand: "Taaza", name: "Taaza Tea 100g", mrp: 25 },
  { category: "Tea & Coffee", brand: "Taj Mahal", name: "Taj Mahal Tea Leaf 100g", mrp: 50 },
  { category: "Tea & Coffee", brand: "Taaza", name: "Taaza Tea Masala Chaska Elaichi 250g", mrp: 65 },
  { category: "Tea & Coffee", brand: "Taaza", name: "Taaza Elaichi 250g", mrp: 75 },
  { category: "Tea & Coffee", brand: "Bru", name: "Bru Coffee Pure", mrp: 2 },
  { category: "Tea & Coffee", brand: "Red Label", name: "Red Label Tea Leaf Carton 250g", mrp: 120 },
  { category: "Tea & Coffee", brand: "Red Label", name: "Red Label Tea Leaf Poly 100g", mrp: 45 },
  { category: "Tea & Coffee", brand: "Lipton", name: "Lipton Green Tea Bags Honey Lemon 10 Pcs", mrp: 75 },
  { category: "Tea & Coffee", brand: "Lipton", name: "Lipton Green Tea Honey Lemon 100g", mrp: 170 },
  { category: "Tea & Coffee", brand: "Red Label", name: "Red Label Tea Natural Care A Blend 250g", mrp: 145 },
  { category: "Tea & Coffee", brand: "Lipton", name: "Lipton Green Tea Clear & Light 10s TB", mrp: 75 },
  { category: "Tea & Coffee", brand: "Bru", name: "Bru Coffee Instant", mrp: 10 },
  { category: "Tea & Coffee", brand: "Lipton", name: "Lipton Clear And Light J&A 100g", mrp: 170 },

  { category: "Bathing Soap", brand: "Lux", name: "Lux Bathing Soap Velvet Touch Jasmine And Almond", mrp: 40 },
  { category: "Bathing Soap", brand: "Lifebuoy", name: "Lifebuoy Bathing Soap Total 10 4x65g", mrp: 40 },
  { category: "Bathing Soap", brand: "Pears", name: "Pears Bathing Soap Pure & Gentle 60g", mrp: 20 },
  { category: "Bathing Soap", brand: "Dove", name: "Dove Bathing Soap Cream Beauty 50g", mrp: 23 },
  { category: "Bathing Soap", brand: "Lux", name: "Lux Bathing Soap Soft Touch 4 x 60g", mrp: 40 },
  { category: "Bathing Soap", brand: "Pears", name: "Pears Bathing Soap Soft & Fresh 100g", mrp: 52 },
  { category: "Bathing Soap", brand: "Lux", name: "Lux Sandal Rs10 MLP", mrp: 40 },
  { category: "Bathing Soap", brand: "Liril", name: "Liril Bathing Soap Lime 75g", mrp: 27 },
  { category: "Bathing Soap", brand: "Lifebuoy", name: "Lifebuoy Ice Bath 65g x 4", mrp: 60 },
  { category: "Bathing Soap", brand: "Lifebuoy", name: "Lifebuoy Bathing Soap Lemon Fresh", mrp: 10 },
  { category: "Bathing Soap", brand: "Lux", name: "Lux Bathing Soap Fresh Flash Water Lily & Cooling", mrp: 10 },
  { category: "Bathing Soap", brand: "Lux", name: "Lux Bathing Soap International Creamy Perfume", mrp: 43 },
  { category: "Bathing Soap", brand: "Rexona", name: "Rexona Bathing Soap Coconut And Olive Oil", mrp: 172 },
  { category: "Bathing Soap", brand: "Lifebuoy", name: "Lifebuoy Hand Wash Powder to Liquid 10g", mrp: 10 },
  { category: "Bathing Soap", brand: "Lifebuoy", name: "Lifebuoy Bathing Soap Care 100% Stronger Germ Protection", mrp: 137 },
  { category: "Bathing Soap", brand: "Lux", name: "Lux Glow Bar Collection", mrp: 350 },
  { category: "Bathing Soap", brand: "Lifebuoy", name: "Lifebuoy Bathing Soap Turmeric And Honey", mrp: 132 },
  { category: "Bathing Soap", brand: "Pears", name: "Pears Bathing Soap Oil Clear & Glow 75g", mrp: 55 },

  { category: "Sauces & Spreads", brand: "Kissan", name: "Kissan Ketchup Fresh Tomato Chotu 90g", mrp: 10 },
  { category: "Sauces & Spreads", brand: "Knorr", name: "Knorr Cup A Soup Instant Tomato Chatpata 16g", mrp: 10 },
  { category: "Sauces & Spreads", brand: "Hellmann's", name: "Hellmann's Sauce Mayonnaise Doy Pack 85g", mrp: 38 },
  { category: "Sauces & Spreads", brand: "Knorr", name: "Knorr Cup A Soup Instant Hot & Sour 11g", mrp: 10 },
  { category: "Sauces & Spreads", brand: "Knorr", name: "Knorr Cup A Soup Instant Mix Vegetable 18g", mrp: 10 },
  { category: "Sauces & Spreads", brand: "Knorr", name: "Knorr Cup A Soup Instant Manchow 12g", mrp: 10 },
  { category: "Sauces & Spreads", brand: "Knorr", name: "Knorr Cup A Soup Instant Sweet Corn 10g", mrp: 10 },
  { category: "Sauces & Spreads", brand: "Hellmann's", name: "Hellmann's Mayo Smoky Tandoori 85g", mrp: 46 },
  { category: "Sauces & Spreads", brand: "Knorr", name: "Knorr Cream of Broccoli Cup-A-Soup 12.5g", mrp: 20 },

  { category: "Oral-Care", brand: "Close Up", name: "Close Up Toothpaste Ever Fresh Red Hot Gel 40g", mrp: 20 },
  { category: "Oral-Care", brand: "Close Up", name: "Close Up Toothpaste Deep Action Red Hot Gel 26g", mrp: 10 },
  { category: "Oral-Care", brand: "Pepsodent", name: "Pepsodent Toothpaste Germi Check Cavity Protection", mrp: 70 },

  { category: "Face Wash", brand: "Pond's", name: "Pond's Facewash White Beauty Spot Less Fairness", mrp: 115 },
  { category: "Face Wash", brand: "Pond's", name: "Pond's Facewash Pure White Anti Pollution 50g", mrp: 138 },
  { category: "Face Wash", brand: "Glow & Lovely", name: "Glow & Lovely Facewash Fairness 50g", mrp: 97 },
  { category: "Face Wash", brand: "Pond's", name: "Pond's Facewash Men Energy Charge 50g", mrp: 119 },

  { category: "Talc & Grooming", brand: "Pond's", name: "Pond's Talcum Powder Dreamflow 23g", mrp: 10 },
  { category: "Talc & Grooming", brand: "Pond's", name: "Pond's Talcum Powder Dreamflow Magic 20g", mrp: 10 },
  { category: "Talc & Grooming", brand: "Pond's", name: "Pond's Talcum Powder Aloe 100g", mrp: 70 },
  { category: "Talc & Grooming", brand: "Pond's", name: "Ponds Aloe Cool 180g", mrp: 150 },
  { category: "Talc & Grooming", brand: "Pond's", name: "Pond's Pink Glow Face Talc 30g", mrp: 140 },

  { category: "Breakfast", brand: "Kissan", name: "Kissan Jam Mixed Fruit 100g", mrp: 25 },
  { category: "Breakfast", brand: "Horlicks", name: "Horlicks Plain Biscuits 45g", mrp: 5 },
  { category: "Breakfast", brand: "Kissan", name: "Kissan Jam Orange Marmalade 500g", mrp: 220 },
  { category: "Breakfast", brand: "Kissan", name: "Kissan Imli Khajoor Chutney 100g Doy", mrp: 49 },
  { category: "Breakfast", brand: "Kissan", name: "Kissan Lehsun Mirch Chutney 100g Doy", mrp: 49 },
  { category: "Breakfast", brand: "Kissan", name: "Kissan Hari Chutney 100g Doy", mrp: 49 },

  { category: "Feminine Hygiene", brand: "VWash", name: "V Wash Plus 100ml", mrp: 215 },

  { category: "Health Food Drinks", brand: "Horlicks", name: "Chocolate Horlicks Sachet 75g", mrp: 25 },
  { category: "Health Food Drinks", brand: "Horlicks", name: "Horlicks Ready-to-Drink 125ml Chocolate", mrp: 20 },
  { category: "Health Food Drinks", brand: "Horlicks", name: "Women's Horlicks Caramel Pet Jar 400g", mrp: 339 },
  { category: "Health Food Drinks", brand: "Horlicks", name: "Chocolate Horlicks Refill 1Kg", mrp: 450 },
];

const DEFAULT_STOCK = 100;

// ---------------------------------------------------------------------------
// Banners
// ---------------------------------------------------------------------------
const BANNERS = [
  { image: "https://res.cloudinary.com/demo/image/upload/w_800,h_300,c_fill/samples/food/pot-mussels.jpg?v=banner1", target: null, order: 0, isActive: true },
  { image: "https://res.cloudinary.com/demo/image/upload/w_800,h_300,c_fill/samples/food/spices.jpg?v=banner2", target: null, order: 1, isActive: true },
  { image: "https://res.cloudinary.com/demo/image/upload/w_800,h_300,c_fill/samples/food/fish-vegetables.jpg?v=banner3", target: null, order: 2, isActive: true },
  { image: "https://res.cloudinary.com/demo/image/upload/w_800,h_300,c_fill/samples/ecommerce/accessories-bag.jpg?v=banner4", target: null, order: 3, isActive: true },
];

// ---------------------------------------------------------------------------
// Offers (built after categories are fetched so we can fill scopeId). Category-scoped
// offers target categories that actually exist in the current taxonomy.
// ---------------------------------------------------------------------------
function buildOffers(categoryMap) {
  const now = Date.now();
  const sixMonths = 6 * 30 * 24 * 60 * 60 * 1000;
  return [
    { code: "FLAT10OFF", kind: OFFER_KIND.FLAT, value: 10, scope: OFFER_SCOPE.CART, scopeId: null,
      minValue: 100, maxDiscount: null, validFrom: now, validTo: now + sixMonths, isActive: true, createdAt: now, updatedAt: now },
    { code: "DETERGENT20", kind: OFFER_KIND.PERCENT, value: 20, scope: OFFER_SCOPE.CATEGORY,
      scopeId: categoryMap["Detergent"] || null, minValue: 0, maxDiscount: 100,
      validFrom: now, validTo: now + sixMonths, isActive: true, createdAt: now, updatedAt: now },
    { code: "WELCOME50", kind: OFFER_KIND.FLAT, value: 50, scope: OFFER_SCOPE.CART, scopeId: null,
      minValue: 300, maxDiscount: null, validFrom: now, validTo: now + sixMonths, isActive: true, createdAt: now, updatedAt: now },
    { code: "TEA15", kind: OFFER_KIND.PERCENT, value: 15, scope: OFFER_SCOPE.CATEGORY,
      scopeId: categoryMap["Tea & Coffee"] || null, minValue: 0, maxDiscount: 80,
      validFrom: now, validTo: now + sixMonths, isActive: true, createdAt: now, updatedAt: now },
    { code: "FIRSTORDER", kind: OFFER_KIND.FLAT, value: 100, scope: OFFER_SCOPE.CART, scopeId: null,
      minValue: 500, maxDiscount: null, validFrom: now, validTo: now + sixMonths, isActive: true, createdAt: now, updatedAt: now },
  ];
}

// ---------------------------------------------------------------------------
// Delivery Partners
// ---------------------------------------------------------------------------
const DELIVERY_PARTNERS = [
  { name: "Ravi Kumar", mobile: "9876543210", isActive: true, fcmTokens: [], currentOrders: [] },
  { name: "Suresh Yadav", mobile: "9123456780", isActive: true, fcmTokens: [], currentOrders: [] },
];

// Deletes every doc in a collection, batched (Firestore batch cap is 500 ops).
async function deleteCollection(firestore, collectionName) {
  const snap = await firestore.collection(collectionName).get();
  if (snap.empty) return 0;
  const chunks = [];
  for (let i = 0; i < snap.docs.length; i += 450) chunks.push(snap.docs.slice(i, i + 450));
  for (const chunk of chunks) {
    const batch = firestore.batch();
    chunk.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }
  return snap.size;
}

// ---------------------------------------------------------------------------
// Main seeding function
// ---------------------------------------------------------------------------
async function seedProducts() {
  const firestore = db();
  const now = Date.now();

  // ── 1. Fetch categories (must already be seeded by `npm run seed`) ────────
  console.log("Fetching categories...");
  const catSnap = await firestore.collection(COLLECTIONS.CATEGORIES).get();
  if (catSnap.empty) {
    console.error("✗ No categories found. Run `npm run seed` first to create categories.");
    process.exit(1);
  }
  const categoryMap = {};
  catSnap.docs.forEach((doc) => { categoryMap[doc.data().name] = doc.id; });

  const requiredCategories = [...new Set(PRODUCTS_DATA.map((p) => p.subCategory || p.category))];
  const missingCategories = requiredCategories.filter((c) => !categoryMap[c]);
  if (missingCategories.length > 0) {
    console.error(`✗ Missing categories in Firestore: ${missingCategories.join(", ")}`);
    console.error("  Run `npm run seed` first.");
    process.exit(1);
  }

  // ── 2. Fetch brands, auto-create any referenced by the product data that don't exist yet ──
  console.log("Fetching brands...");
  const brandSnap = await firestore.collection(COLLECTIONS.BRANDS).get();
  const brandMap = {};
  let brandOrder = brandSnap.size;
  brandSnap.docs.forEach((doc) => { brandMap[doc.data().name] = doc.id; });

  const requiredBrands = [...new Set(PRODUCTS_DATA.map((p) => BRAND_ALIASES[p.brand] || p.brand))];
  for (const name of requiredBrands) {
    if (brandMap[name]) continue;
    const ref = await firestore.collection(COLLECTIONS.BRANDS).add({
      name, logoUrl: "", order: brandOrder++, isActive: true, createdAt: now, updatedAt: now,
    });
    brandMap[name] = ref.id;
    console.log(`  created brand (no local logo yet — falls back to online lookup): ${name} -> ${ref.id}`);
  }

  // ── 3. Wipe existing products so the catalogue matches PRODUCTS_DATA exactly ──
  const deletedProducts = await deleteCollection(firestore, COLLECTIONS.PRODUCTS);
  console.log(`Deleted ${deletedProducts} existing products`);

  // ── 4. Seed products ───────────────────────────────────────────────────────
  console.log(`\nSeeding ${PRODUCTS_DATA.length} products...`);
  const chunks = [];
  for (let i = 0; i < PRODUCTS_DATA.length; i += 450) chunks.push(PRODUCTS_DATA.slice(i, i + 450));

  let seeded = 0;
  for (const chunk of chunks) {
    const batch = firestore.batch();
    chunk.forEach((product, idx) => {
      const categoryId = categoryMap[product.subCategory || product.category];
      const brandId = brandMap[BRAND_ALIASES[product.brand] || product.brand] || null;
      const { label, unit } = parseSize(product.name);
      const imageKey = CATEGORY_IMAGE[product.category] || "bag";
      const docRef = firestore.collection(COLLECTIONS.PRODUCTS).doc();
      batch.set(docRef, {
        name: product.name,
        description: "",
        categoryId,
        brandId,
        unit,
        images: imgs(IMG[imageKey], 2),
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
    seeded += chunk.length;
  }
  console.log(`✓ ${seeded} products written`);

  // ── 5. Seed banners (idempotent — only if none exist) ─────────────────────
  console.log("\nSeeding banners...");
  const bannerCountSnap = await firestore.collection(COLLECTIONS.BANNERS).limit(1).get();
  if (!bannerCountSnap.empty) {
    console.log("  [SKIP] Banners already exist");
  } else {
    const bannerBatch = firestore.batch();
    BANNERS.forEach((banner) => {
      const docRef = firestore.collection(COLLECTIONS.BANNERS).doc();
      bannerBatch.set(docRef, { ...banner, createdAt: now });
    });
    await bannerBatch.commit();
    console.log(`  ✓ ${BANNERS.length} banners seeded`);
  }

  // ── 6. Seed offers — wipe and recreate so category-scoped coupons always point at
  //      categories that currently exist (a stale scopeId just silently matches nothing).
  console.log("\nSeeding offers...");
  const deletedOffers = await deleteCollection(firestore, COLLECTIONS.OFFERS);
  console.log(`  Deleted ${deletedOffers} existing offers`);
  const offers = buildOffers(categoryMap);
  const offerBatch = firestore.batch();
  offers.forEach((offer) => {
    const docRef = firestore.collection(COLLECTIONS.OFFERS).doc();
    offerBatch.set(docRef, offer);
  });
  await offerBatch.commit();
  console.log(`  ✓ ${offers.length} offers seeded`);

  // ── 7. Seed delivery partners (idempotent) ─────────────────────────────────
  console.log("\nSeeding delivery partners...");
  const partnerCountSnap = await firestore.collection(COLLECTIONS.DELIVERY_PARTNERS).limit(1).get();
  if (!partnerCountSnap.empty) {
    console.log("  [SKIP] Delivery partners already exist");
  } else {
    const partnerBatch = firestore.batch();
    DELIVERY_PARTNERS.forEach((partner) => {
      const docRef = firestore.collection(COLLECTIONS.DELIVERY_PARTNERS).doc();
      partnerBatch.set(docRef, { ...partner, createdAt: now });
    });
    await partnerBatch.commit();
    console.log(`  ✓ ${DELIVERY_PARTNERS.length} delivery partners seeded`);
  }

  await firestore.collection(COLLECTIONS.CONFIG).doc("global").set(
    { productsSeeded: true, productsSeededAt: now },
    { merge: true }
  );

  console.log("\n============================================================");
  console.log("  MS Traders product seed complete!");
  console.log(`  Products : ${seeded}`);
  console.log(`  Brands   : ${requiredBrands.length} referenced (${Object.keys(brandMap).length} total in DB)`);
  console.log(`  Banners  : ${BANNERS.length}`);
  console.log(`  Offers   : ${offers.length}`);
  console.log(`  Partners : ${DELIVERY_PARTNERS.length}`);
  console.log("============================================================\n");

  process.exit(0);
}

seedProducts().catch((err) => {
  console.error("\n✗ Seed failed:", err.message || err);
  console.error(err.stack);
  process.exit(1);
});
