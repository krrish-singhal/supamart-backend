require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { initFirebase, db } = require("../config/firebase");
const { COLLECTIONS } = require("../config/constants");
const { upload } = require("../services/storageService");

async function seedBanners() {
  initFirebase();
  const firestore = db();
  console.log("Starting banner seeding...");

  // 1. Fetch current banners to remove dummy ones
  const existingSnap = await firestore.collection(COLLECTIONS.BANNERS).get();
  console.log(`Found ${existingSnap.size} existing banners in collection '${COLLECTIONS.BANNERS}'.`);
  for (const doc of existingSnap.docs) {
    console.log(`Deleting old/dummy banner: ${doc.id}`);
    await firestore.collection(COLLECTIONS.BANNERS).doc(doc.id).delete();
  }

  // 2. Define the 3 canonical banners with exact styling & metadata
  const bannerDefinitions = [
    {
      fileName: "farm_fresh.png",
      data: {
        label: "Farm fresh",
        title: "Vegetables picked this morning",
        subtitle: "Starting at just ₹9",
        target: "Home",
        targetType: "Home",
        destination: "categories",
        background: "#E4F2E9",
        text: "#121712",
        secondary: "#3B5145",
        button: "#0A7C47",
        buttonText: "#FFFFFF",
        order: 0,
        isActive: true,
      },
    },
    {
      fileName: "monthly_ration.png",
      data: {
        label: "Monthly ration",
        title: "Wholesale prices, home delivered",
        subtitle: "Up to 20% off atta, rice & oil",
        target: "Home",
        targetType: "Home",
        destination: "offers",
        background: "#0A7C47",
        text: "#FFFFFF",
        secondary: "#D1FAE5",
        button: "#FFFFFF",
        buttonText: "#0A7C47",
        order: 1,
        isActive: true,
      },
    },
    {
      fileName: "tea_time.png",
      data: {
        label: "Tea time",
        title: "Tea, biscuits & snacks",
        subtitle: "Buy 2, get 10% extra off",
        target: "Home",
        targetType: "Home",
        destination: "categories",
        background: "#1E2B23",
        text: "#FFFFFF",
        secondary: "#CBD5E1",
        button: "#FFFFFF",
        buttonText: "#0A7C47",
        order: 2,
        isActive: true,
      },
    },
  ];

  const assetsDir = path.join(__dirname, "../../assets/banners");

  for (const item of bannerDefinitions) {
    const filePath = path.join(assetsDir, item.fileName);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Banner file not found: ${filePath}`);
    }

    console.log(`Uploading ${item.fileName} to Cloudinary...`);
    const buffer = fs.readFileSync(filePath);
    const uploadResult = await upload(buffer, "banners");
    console.log(`Uploaded ${item.fileName} -> ${uploadResult.url}`);

    const bannerDoc = {
      ...item.data,
      image: uploadResult.url,
      cloudinaryId: uploadResult.id || null,
      createdAt: Date.now(),
    };

    const docRef = await firestore.collection(COLLECTIONS.BANNERS).add(bannerDoc);
    console.log(`Saved banner '${item.data.label}' with doc ID: ${docRef.id}`);
  }

  console.log("Successfully seeded canonical banners!");
}

if (require.main === module) {
  seedBanners()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Seeding failed:", err);
      process.exit(1);
    });
}

module.exports = { seedBanners };
