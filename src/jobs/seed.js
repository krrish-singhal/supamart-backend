const { STORE_LOCATION, SERVICE_RADIUS_KM, DELIVERY_TIERS } = require('../config/deliveryArea');
require("dotenv").config();
const { db } = require("../config/firebase");
const { COLLECTIONS } = require("../config/constants");

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

// Bootstraps config/global and the category taxonomy so the app is functional from day 1.
// This is a full replace: existing categories (and their sub-categories) are deleted and
// recreated exactly from TOP_LEVEL_CATEGORIES/SUB_CATEGORIES below, since seedProducts.js
// re-derives categoryId links from these names on every run — a stale/duplicate category
// would silently orphan products. config/global itself is merged (never resets orderSeq).
async function seed() {
  const now = Date.now();
  const firestore = db();

  await firestore.collection(COLLECTIONS.CONFIG).doc("global").set(
    {
      storeAddress: STORE_LOCATION.address,
      storePlusCode: STORE_LOCATION.plusCode,
      storeMapsUrl: STORE_LOCATION.mapsUrl,
      distanceMethod: 'straight-line',
      storeLat: STORE_LOCATION.lat,
      storeLng: STORE_LOCATION.lng,
      serviceRadiusKm: SERVICE_RADIUS_KM,
      minOrderValue: 200,
      taxPercent: 0,
      deliveryTiers: DELIVERY_TIERS.map(tier => ({ ...tier })),
      slots: [],
      deliveryMode: 'ON_DEMAND',
      storeHours: { opensAt: '10:00', closesAt: '23:00', timeZone: 'Asia/Kolkata' },
      orderSeq: 1000,
      updatedAt: now,
    },
    { merge: true }
  );

  // Exact top-level categories — one per distinct `category` value in the product data.
  const TOP_LEVEL_CATEGORIES = [
    "Detergent", "Dishwash", "Hair Care", "Tea & Coffee", "Bathing Soap",
    "Sauces & Spreads", "Oral-Care", "Face Wash", "Talc & Grooming",
    "Breakfast", "Feminine Hygiene", "Health Food Drinks",
  ];

  // Sub-categories, keyed by parent top-level category name.
  // imageKey slugs map to customer/src/utils/subCategoryImages.js — local bundled
  // assets the user will drop into customer/assets/images/sub-categories/.
  const SUB_CATEGORIES = {
    Detergent: [
      { name: "Powder", imageKey: "detergent-powder" },
      { name: "Bars", imageKey: "detergent-bars" },
      { name: "Bleach", imageKey: "detergent-bleach" },
      { name: "Matic Liquid", imageKey: "detergent-matic-liquid" },
      { name: "Fabric Conditioner", imageKey: "detergent-fabric-conditioner" },
      { name: "Liquid", imageKey: "detergent-liquid" },
    ],
  };

  const deletedCategories = await deleteCollection(firestore, COLLECTIONS.CATEGORIES);
  console.log(`Deleted ${deletedCategories} existing categories`);

  let order = 0;
  const topLevelIds = {};
  for (const name of TOP_LEVEL_CATEGORIES) {
    const ref = await firestore.collection(COLLECTIONS.CATEGORIES).add({
      name, image: "", imageKey: null, order, parentId: null, isActive: true, createdAt: now, updatedAt: now,
    });
    topLevelIds[name] = ref.id;
    console.log(`created: ${name} -> ${ref.id}`);
    order++;
  }

  for (const [parentName, subs] of Object.entries(SUB_CATEGORIES)) {
    const parentId = topLevelIds[parentName];
    let subOrder = 0;
    for (const sub of subs) {
      const ref = await firestore.collection(COLLECTIONS.CATEGORIES).add({
        name: sub.name, image: "", imageKey: sub.imageKey, order: subOrder,
        parentId, isActive: true, createdAt: now, updatedAt: now,
      });
      console.log(`created sub-category: ${parentName} > ${sub.name} -> ${ref.id}`);
      subOrder++;
    }
  }

  console.log("Seed complete: config + categories");
  process.exit(0);
}

seed().catch((e) => {
  console.error(e);
  process.exit(1);
});
