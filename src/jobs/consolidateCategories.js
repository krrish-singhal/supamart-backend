// Consolidates the 28 top-level categories (56 with subcategories) down to a clean,
// non-overlapping taxonomy. The old (119-product) and new (191-product) catalogs were
// seeded independently and never reconciled — Detergent/Dishwash/Household Cleaning &
// Laundry all hold the same kind of products (Vim, Rin, Surf Excel, Wheel...) split
// three ways; Bathing Soap/Hair Care/Oral-Care/Face Wash/Talc & Grooming/Personal Care
// are the same fragmentation for personal-care items; Snacks & Chips/Biscuits &
// Cookies/Chocolates & Confectionery for snacks; Tea & Coffee/Beverages & Health
// Drinks/Health Food Drinks for beverages; Sauces & Spreads/Pickles, Sauces &
// Condiments/Breakfast for condiments. This also fixes several individually-misplaced
// products found while auditing the overlap (Kellogg's cereals were sitting in
// "Chocolates & Confectionery", a biscuit was in "Snacks & Chips", Dabur Glucose was in
// "Personal Care", Devon Corn Starch was in "Household Cleaning & Laundry", Nescafe was
// separate from the rest of "Coffee").
//
// Strategy: reuse and rename an existing top-level doc for each merged group (keeps
// createdAt/id continuity, minimizes new docs) rather than creating a duplicate-looking
// fresh category, then move every affected product's categoryId onto the right
// subcategory (creating new subcategories, or reusing/renaming existing ones where a
// good match already exists), and delete the now-empty old category docs.
//
// Run with --dry to print the full plan (including validating every product name
// actually exists) without writing anything.
require("dotenv").config();
const { db } = require("../config/firebase");
const { COLLECTIONS } = require("../config/constants");

const DRY_RUN = process.argv.includes("--dry");

// ── Group 1: Household & Cleaning (reuse "Household Cleaning & Laundry", rename) ────
const HOUSEHOLD_SUBS = {
  "Detergent Powder": ["Rin Detergent Powder 1kg", "Wheel L&O Powder A+ 4kg Blue", "Surf Excel Detergent Powder Quick Wash 1kg", "Surf Excel Detergent Powder Easy Wash", "Wheel Detergent Powder Blue 1kg", "Sunlight Detergent Powder", "Sara Soap Podi (washing powder)"],
  "Detergent Bars": ["Surf Excel Detergent Bar 100g", "Rin Detergent Bar"],
  "Detergent Liquid": ["Surf Excel Detergent Liquid Easy Wash 500ml", "Surf Excel Detergent Liquid Matic Front Load Refill", "Surf Excel Detergent Liquid Matic Top Load Refill", "E-fee Washing Liquid"],
  "Fabric Conditioner": ["Comfort Fabric Conditioner Pink 220ml", "Comfort Fabric Conditioner Blue 220ml"],
  "Bleach": ["Rin Bleach Ala Bleach 200ml"],
  "Dishwash Bars": ["Vim Bar 3x190g MPO", "Vim Bar Tubs Anti-Smell 500g", "Vim Dishwash Bar 75g", "Vim Dishwash Bar Tub 500g", "Exo Dishwash Bar"],
  "Dishwash Liquid": ["Vim Dishwash Gel Liquid Lemon 250ml", "Vim Dishwash Gel Liquid Lemon 115ml", "Sunlight Dishwash Liquid"],
  "Fabric Whitener": ["Ujala Y&F Bliss/Aura Sachet", "Ujala Crystal White Liquid"],
  "Mosquito Repellent": ["Maxo Genius Combi", "Maxo Coil (Mosquito Repellent)"],
};

// ── Group 2: Personal Care (reuse existing "Personal Care" top-level as-is) ─────────
const PERSONAL_CARE_SUBS = {
  "Soaps": ["Liril Bathing Soap Lime 75g", "Lux Bathing Soap International Creamy Perfume", "Rexona Bathing Soap Coconut And Olive Oil", "Lux Bathing Soap Fresh Flash Water Lily & Cooling", "Pears Bathing Soap Soft & Fresh 100g", "Lifebuoy Ice Bath 65g x 4", "Dove Bathing Soap Cream Beauty 50g", "Lifebuoy Bathing Soap Care 100% Stronger Germ Protection", "Lifebuoy Bathing Soap Turmeric And Honey", "Lux Bathing Soap Velvet Touch Jasmine And Almond", "Lux Bathing Soap Soft Touch 4 x 60g", "Lux Sandal Rs10 MLP", "Lifebuoy Bathing Soap Lemon Fresh", "Lifebuoy Bathing Soap Total 10 4x65g", "Lux Glow Bar Collection", "Pears Bathing Soap Oil Clear & Glow 75g", "Pears Bathing Soap Pure & Gentle 60g"],
  "Hand Wash": ["Lifebuoy Hand Wash Powder to Liquid 10g"],
  "Shampoo": ["Clinic Plus Hair Shampoo Strong & Shine 6ml", "TRESemme Hair Shampoo Hair Fall Defense 6ml", "Dove Hair Shampoo & Conditioner Intense Repair", "Clinic Plus Hair Shampoo Straight & Shine 175ml", "Sunsilk Hair Shampoo Dream Soft & Smooth", "Dove Hair Shampoo Intense Repair", "Dove Men+ Care Ad 2In1 Shampoo+Conditioner", "Dove Hair Shampoo Daily Shine", "Dove Hair Shampoo Dandruff Care 80ml", "Clinic Plus Hair Shampoo", "Indulekha Hair Shampoo Bringha Hair Fall Cleanser", "Dove Hair Shampoo Dryness Care 80ml", "Clinic Plus Hair Shampoo Strong & Extra Thick 175ml", "Clinic Plus Hair Shampoo Strong Scalp", "TRESemme Hair Shampoo Keratin Smooth 6ml", "Dove Hair Shampoo Clean & Fresh 6ml", "Dove Hair Shampoo Healthy Ritual For Growing Hair", "Sunsilk Hair Shampoo Lusciously Thick & Long", "Sunsilk Hair Shampoo Stunning Black Shine", "Dove Hair Shampoo Anti Dandruff Therapy", "Dove Glycolic Hydration Mid Shampoo 180ml", "Dove Hair Shampoo Hair Fall Rescue 80ml", "Dove Daily Shine Shampoo & Conditioner Twin Sachet", "Dove Hair Shampoo & Conditioner Hair Fall Therapy", "Dove Hair Shampoo Hair Fall Therapy", "Sunsilk Thick & Long Twin (5.5+5.5)ml", "Clinic Plus Strong And Smooth 6ml"],
  "Hair Oil": ["Clear Hair Oil 75ml", "Dabur Amla Hair Oil", "Dabur Almond Hair Oil", "Dabur Vatika Hair Oil"],
  "Conditioner": ["Dove Hair Conditioner Dryness Care 80ml", "Sunsilk Hair Conditioner Smooth & Tangle Free 80ml", "Dove Hair Conditioner Daily Shine", "Dove Hair Conditioner Intense Damage Therapy", "TRESemme Hair Conditioner Smooth & Shine", "Dove Hair Conditioner Hair Fall Rescue", "TRESemme Hair Conditioner Keratin Smooth", "TRESemme Hair Conditioner Hair Fall Defense", "TRESemme Smooth & Shine LCS 6ml"],
  "Oral Care": ["Pepsodent Toothpaste Germi Check Cavity Protection", "Close Up Toothpaste Ever Fresh Red Hot Gel 40g", "Close Up Toothpaste Deep Action Red Hot Gel 26g", "Sensodyne Sensitive Toothbrush", "Dabur Red Toothpaste", "KP Herbal Paste", "Sensodyne Rapid Relief Paste", "Sensodyne Fresh Gel Paste"],
  "Face Wash Men": ["Pond's Facewash Men Energy Charge 50g"],
  "Face Wash Women": ["Glow & Lovely Facewash Fairness 50g", "Pond's Facewash Pure White Anti Pollution 50g", "Pond's Facewash White Beauty Spot Less Fairness"],
  "Talc": ["Pond's Talcum Powder Aloe 100g", "Ponds Aloe Cool 180g", "Pond's Talcum Powder Dreamflow 23g", "Pond's Talcum Powder Dreamflow Magic 20g", "Pond's Pink Glow Face Talc 30g", "Yardley Lavender Talc", "Yardley English Rose Talc", "Yardley Red Rose Talc"],
  "Feminine Hygiene": ["V Wash Plus 100ml"],
  // Existing "Personal Care" subs whose products stay as-is, just kept alive (not moved):
  // "Talc & Cosmetics" -> folded into "Talc" above; "Hair & Oral Care" -> split into
  // "Hair Oil" + "Oral Care" above; both retired (deleted) once empty.
};

// ── Group 3: Snacks & Confectionery (reuse "Snacks & Chips", rename) ────────────────
const SNACKS_SUBS = {
  "Chips": ["Pringles Desi Masala", "Pringles Sour & Cream", "Pringles Original"],
  "Noodles & Pasta": ["Maggi Pazzta", "Maggi 2-Minute Noodles", "Yippee Magic Masala Noodles", "True Blue Dragon Noodles"],
  "Biscuits & Cookies": ["Good Day Chocochip", "50-50 Biscuits", "Premium Bake Rusk", "Milk Bikis Milk Cream", "Good Day Butter", "Good Day Pista Badam", "Good Day Cashew", "Sunfeast Marie Glucose", "Marie Gold", "Milk Rusk Restage", "Dark Fantasy Vanilla", "Bourbon Neapolitan Cream (BNC) - Pineapple/Orange/Elaichi", "Tiger KR Coconut", "Sunfeast Golden Bakery", "Dark Fantasy Bourbon", "Tiger Krunch Choco", "Sunfeast Marie Light", "NC Cracker Lite", "Dream Cream Orange / Cashewnut", "NC Thin Arrowroot Biscuit", "Horlicks Plain Biscuits 45g", "Milk Rusk / Premium Bake Rusk"],
  "Chocolates & Confectionery": ["Kit Kat Miniatures", "Snickers", "Bounty (S.Bounty)", "Munch Chocolate Wafer"],
};

// ── Group 4: Beverages & Health Drinks (reuse existing top-level as-is) ─────────────
const BEVERAGES_SUBS = {
  "Tea": ["Lipton Green Tea Clear & Light 10s TB", "Lipton Green Tea Honey Lemon 100g", "Red Label Tea Natural Care A Blend 250g", "Taaza Tea 100g", "Taaza Elaichi 250g", "Taaza Tea Masala Chaska Elaichi 250g", "Red Label Tea Leaf Carton 250g", "Red Label Tea Leaf Poly 100g", "Taj Mahal Tea Leaf 100g", "Lipton Green Tea Bags Honey Lemon 10 Pcs", "Lipton Clear And Light J&A 100g", "AVT Premium Tea"],
  "Coffee": ["Bru Coffee Pure", "Bru Coffee Instant", "Nescafe Classic Jar", "Nescafe Sunrise"],
  "Health & Energy Drinks": ["Chocolate Horlicks Refill 1Kg", "Women's Horlicks Caramel Pet Jar 400g", "Horlicks Ready-to-Drink 125ml Chocolate", "Chocolate Horlicks Sachet 75g", "Boost 200 gm Pouch", "Boost 500 gm Jar", "Dabur Glucose"],
  "Fruit Drinks & Desserts": ["Pran Litchi Drink", "Pran Pudding Jar"],
};

// ── Group 5: Sauces, Pickles & Condiments (reuse "Pickles, Sauces & Condiments", rename) ──
const SAUCES_SUBS = {
  "Sauces & Ketchup": ["Hellmann's Sauce Mayonnaise Doy Pack 85g", "Kissan Ketchup Fresh Tomato Chotu 90g", "Hellmann's Mayo Smoky Tandoori 85g", "Anus Tomatto Sauce", "Anus Chilly Sauce", "Anus Soya Sauce", "Red Chilly Sauce"],
  "Soup": ["Knorr Cup A Soup Instant Manchow 12g", "Knorr Cup A Soup Instant Mix Vegetable 18g", "Knorr Cup A Soup Instant Hot & Sour 11g", "Knorr Cream of Broccoli Cup-A-Soup 12.5g", "Knorr Cup A Soup Instant Sweet Corn 10g", "Knorr Cup A Soup Instant Tomato Chatpata 16g"],
  "Pickles": ["Anus Lemon Pickle", "Anus Mango Pickle", "Anus Tender Mango Pickle", "Anus Dates Pickle", "Ginger Pickle"],
  "Chutneys & Jam": ["Kissan Hari Chutney 100g Doy", "Kissan Imli Khajoor Chutney 100g Doy", "Kissan Lehsun Mirch Chutney 100g Doy", "Kissan Jam Orange Marmalade 500g", "Kissan Jam Mixed Fruit 100g"],
};

// Products moving directly onto an existing, unchanged top-level category (no sub) —
// each was individually misplaced, found while auditing the overlap.
const DIRECT_MOVES = {
  "Devon Corn Starch (household/cooking use)": "Rice, Atta & Grains",
  "Kellogg's Chocos": "Instant / Ready-to-Cook Mixes",
  "Kellogg's Corn Flakes": "Instant / Ready-to-Cook Mixes",
  "Anus Chukku Kappi (Ginger Coffee Mix)": "Instant / Ready-to-Cook Mixes",
};

// Each merged group: which existing top-level doc to reuse+rename, its new subcategory
// map, and which OTHER top-level categories get fully absorbed (and later deleted).
const GROUPS = [
  { reuseTopLevel: "Household Cleaning & Laundry", renameTo: "Household & Cleaning", subs: HOUSEHOLD_SUBS, absorbs: ["Detergent", "Dishwash"] },
  { reuseTopLevel: "Personal Care", renameTo: "Personal Care", subs: PERSONAL_CARE_SUBS, absorbs: ["Bathing Soap", "Hair Care", "Oral-Care", "Face Wash", "Talc & Grooming", "Feminine Hygiene"], retireOwnSubs: ["Talc & Cosmetics", "Hair & Oral Care"] },
  { reuseTopLevel: "Snacks & Chips", renameTo: "Snacks & Confectionery", subs: SNACKS_SUBS, absorbs: ["Biscuits & Cookies", "Chocolates & Confectionery"] },
  { reuseTopLevel: "Beverages & Health Drinks", renameTo: "Beverages & Health Drinks", subs: BEVERAGES_SUBS, absorbs: ["Tea & Coffee", "Health Food Drinks"] },
  { reuseTopLevel: "Pickles, Sauces & Condiments", renameTo: "Sauces, Pickles & Condiments", subs: SAUCES_SUBS, absorbs: ["Sauces & Spreads", "Breakfast"] },
];

async function run() {
  const firestore = db();
  const now = Date.now();

  const catSnap = await firestore.collection(COLLECTIONS.CATEGORIES).get();
  const cats = catSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const topByName = {};
  cats.filter((c) => !c.parentId).forEach((c) => { topByName[c.name] = c; });
  const subByParentAndName = {};
  cats.filter((c) => c.parentId).forEach((c) => { subByParentAndName[`${c.parentId}::${c.name}`] = c; });

  const prodSnap = await firestore.collection(COLLECTIONS.PRODUCTS).get();
  const prodByName = {};
  const prodDupes = new Set();
  prodSnap.docs.forEach((d) => {
    const name = d.data().name;
    if (prodByName[name]) prodDupes.add(name);
    prodByName[name] = { id: d.id, ...d.data() };
  });

  // ── Validate every referenced product name actually exists (catches typos before
  //    anything is written) ────────────────────────────────────────────────────────
  const allReferencedNames = [
    ...Object.values(HOUSEHOLD_SUBS).flat(),
    ...Object.values(PERSONAL_CARE_SUBS).flat(),
    ...Object.values(SNACKS_SUBS).flat(),
    ...Object.values(BEVERAGES_SUBS).flat(),
    ...Object.values(SAUCES_SUBS).flat(),
    ...Object.keys(DIRECT_MOVES),
  ];
  const notFound = allReferencedNames.filter((n) => !prodByName[n]);
  const seen = new Set();
  const referencedDupes = allReferencedNames.filter((n) => (seen.has(n) ? true : (seen.add(n), false)));

  console.log("=".repeat(70));
  console.log("VALIDATION");
  console.log("=".repeat(70));
  console.log(`Products referenced in this plan: ${allReferencedNames.length} (${new Set(allReferencedNames).size} unique)`);
  console.log(`Not found in live Firestore: ${notFound.length}`);
  notFound.forEach((n) => console.log("  MISSING:", n));
  console.log(`Referenced more than once in this plan (would be double-assigned): ${referencedDupes.length}`);
  referencedDupes.forEach((n) => console.log("  DUPLICATE REFERENCE:", n));
  if (prodDupes.size) {
    console.log(`Product names that are ambiguous (multiple live docs share the name): ${prodDupes.size}`);
    prodDupes.forEach((n) => console.log("  AMBIGUOUS:", n));
  }

  if (notFound.length || referencedDupes.length) {
    console.log("\nAborting: fix the issues above before proceeding (dry or real run).");
    process.exit(1);
  }

  // Every live product accounted for by name, so we can catch anything the plan forgot.
  const allLiveNamesInOldCategories = new Set();
  const oldTopLevelNamesToDelete = new Set(GROUPS.flatMap((g) => g.absorbs));
  for (const p of prodSnap.docs.map((d) => ({ id: d.id, ...d.data() }))) {
    const cat = cats.find((c) => c.id === p.categoryId);
    if (!cat) continue;
    const topName = cat.parentId ? cats.find((c) => c.id === cat.parentId)?.name : cat.name;
    if (oldTopLevelNamesToDelete.has(topName)) allLiveNamesInOldCategories.add(p.name);
  }
  const forgotten = [...allLiveNamesInOldCategories].filter((n) => !allReferencedNames.includes(n));
  console.log(`\nProducts currently in a to-be-deleted category but NOT covered by this plan: ${forgotten.length}`);
  forgotten.forEach((n) => console.log("  FORGOTTEN:", n));
  if (forgotten.length) {
    console.log("\nAborting: every product in a category being deleted must be reassigned somewhere.");
    process.exit(1);
  }

  // ── Print the full plan ──────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(70));
  console.log("MIGRATION PLAN");
  console.log("=".repeat(70));
  for (const group of GROUPS) {
    const top = topByName[group.reuseTopLevel];
    console.log(`\n"${group.reuseTopLevel}"${group.renameTo !== group.reuseTopLevel ? ` -> renamed to "${group.renameTo}"` : ""} (reusing id ${top?.id || "MISSING"})`);
    for (const [subName, productNames] of Object.entries(group.subs)) {
      const existingSub = subByParentAndName[`${top?.id}::${subName}`];
      console.log(`  > ${subName}${existingSub ? " (reuse existing sub)" : " (new sub)"}: ${productNames.length} products`);
    }
    if (group.retireOwnSubs) {
      console.log(`  Retiring (deleting) own now-empty subs: ${group.retireOwnSubs.join(", ")}`);
    }
    console.log(`  Absorbing and deleting: ${group.absorbs.join(", ")}`);
  }
  console.log("\nDirect moves onto existing categories (individually misplaced products):");
  for (const [productName, targetTop] of Object.entries(DIRECT_MOVES)) {
    console.log(`  "${productName}" -> "${targetTop}"`);
  }

  const totalTopLevelBefore = cats.filter((c) => !c.parentId).length;
  const topLevelsDeleted = GROUPS.flatMap((g) => g.absorbs).length;
  console.log(`\nTop-level categories: ${totalTopLevelBefore} -> ${totalTopLevelBefore - topLevelsDeleted}`);

  if (DRY_RUN) {
    console.log("\nDry run — no writes performed.");
    process.exit(0);
  }

  // ── Execute ───────────────────────────────────────────────────────────────────────
  for (const group of GROUPS) {
    const top = topByName[group.reuseTopLevel];
    if (group.renameTo !== group.reuseTopLevel) {
      await firestore.collection(COLLECTIONS.CATEGORIES).doc(top.id).update({ name: group.renameTo, updatedAt: now });
      top.name = group.renameTo;
    }

    let subOrder = cats.filter((c) => c.parentId === top.id).length;
    for (const [subName, productNames] of Object.entries(group.subs)) {
      let sub = subByParentAndName[`${top.id}::${subName}`];
      if (!sub) {
        const ref = await firestore.collection(COLLECTIONS.CATEGORIES).add({
          name: subName, image: "", imageKey: null, order: subOrder++, parentId: top.id, isActive: true, createdAt: now, updatedAt: now,
        });
        sub = { id: ref.id, name: subName, parentId: top.id };
        subByParentAndName[`${top.id}::${subName}`] = sub;
        cats.push(sub);
      }
      for (const productName of productNames) {
        const product = prodByName[productName];
        await firestore.collection(COLLECTIONS.PRODUCTS).doc(product.id).update({ categoryId: sub.id, updatedAt: now });
      }
      console.log(`Moved ${productNames.length} products -> "${group.renameTo} > ${subName}"`);
    }
  }

  for (const [productName, targetTopName] of Object.entries(DIRECT_MOVES)) {
    const product = prodByName[productName];
    const targetTop = topByName[targetTopName];
    await firestore.collection(COLLECTIONS.PRODUCTS).doc(product.id).update({ categoryId: targetTop.id, updatedAt: now });
    console.log(`Moved "${productName}" -> "${targetTopName}"`);
  }

  // Retire now-empty subs that were folded into a renamed sub (e.g. old "Talc &
  // Cosmetics" / "Hair & Oral Care" under Personal Care, replaced by "Talc" / "Hair Oil"
  // + "Oral Care" above).
  for (const group of GROUPS) {
    if (!group.retireOwnSubs) continue;
    const top = topByName[group.reuseTopLevel];
    for (const subName of group.retireOwnSubs) {
      const sub = cats.find((c) => c.parentId === top.id && c.name === subName);
      if (sub) {
        await firestore.collection(COLLECTIONS.CATEGORIES).doc(sub.id).delete();
        console.log(`Deleted now-empty sub "${group.reuseTopLevel} > ${subName}"`);
      }
    }
  }

  // Delete the fully-absorbed old top-level categories and their subcategories.
  const freshCatSnap = await firestore.collection(COLLECTIONS.CATEGORIES).get();
  const freshCats = freshCatSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  for (const group of GROUPS) {
    for (const oldName of group.absorbs) {
      const oldTop = freshCats.find((c) => !c.parentId && c.name === oldName);
      if (!oldTop) continue;
      const oldSubs = freshCats.filter((c) => c.parentId === oldTop.id);
      for (const oldSub of oldSubs) {
        await firestore.collection(COLLECTIONS.CATEGORIES).doc(oldSub.id).delete();
      }
      await firestore.collection(COLLECTIONS.CATEGORIES).doc(oldTop.id).delete();
      console.log(`Deleted absorbed category "${oldName}" (+ ${oldSubs.length} subs)`);
    }
  }

  console.log("\nDone.");
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
