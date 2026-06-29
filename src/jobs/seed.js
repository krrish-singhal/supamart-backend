require("dotenv").config();
const { db } = require("../config/firebase");
const { COLLECTIONS } = require("../config/constants");

// Bootstraps config/global and a few categories so the app is functional from day 1.
async function seed() {
  const now = Date.now();

  await db().collection(COLLECTIONS.CONFIG).doc("global").set({
    storeLat: Number(process.env.STORE_LATITUDE) || 28.6139,
    storeLng: Number(process.env.STORE_LONGITUDE) || 77.209,
    serviceRadiusKm: Number(process.env.SERVICE_RADIUS_KM) || 5,
    minOrderValue: 200,
    taxPercent: 0,
    deliveryTiers: [
      { maxKm: 2, charge: 20 },
      { maxKm: 5, charge: 40 },
    ],
    slots: [
      { label: "9AM - 11AM", from: "09:00", to: "11:00", active: true },
      { label: "11AM - 1PM", from: "11:00", to: "13:00", active: true },
      { label: "4PM - 6PM", from: "16:00", to: "18:00", active: true },
      { label: "6PM - 8PM", from: "18:00", to: "20:00", active: true },
    ],
    orderSeq: 1000,
    updatedAt: now,
  });

  const categories = [
    "Vegetables", "Fruits", "Groceries", "Beverages", "Snacks",
    "Dairy", "Household", "Frozen Foods", "Bakery", "Personal Care",
  ];
  let order = 0;
  for (const name of categories) {
    await db().collection(COLLECTIONS.CATEGORIES).add({
      name, image: "", order: order++, isActive: true, createdAt: now, updatedAt: now,
    });
  }

  console.log("Seed complete: config + categories");
  process.exit(0);
}

seed().catch((e) => {
  console.error(e);
  process.exit(1);
});
