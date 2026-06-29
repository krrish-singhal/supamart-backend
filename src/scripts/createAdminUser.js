/**
 * One-time script: creates admin@supamart.in in Firebase Auth,
 * sets role: ADMIN custom claim, and upserts a Firestore profile.
 *
 * Run: node src/scripts/createAdminUser.js
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env") });

const { authAdmin, db } = require("../config/firebase");
const { ROLES, COLLECTIONS } = require("../config/constants");

const ADMIN_EMAIL    = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_NAME     = process.env.ADMIN_NAME || "SupaMart Admin";

if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error("Error: ADMIN_EMAIL and ADMIN_PASSWORD must be set in .env");
  process.exit(1);
}

async function run() {
  console.log("Connecting to Firebase project:", process.env.FIREBASE_PROJECT_ID);
  const auth = authAdmin();
  const firestore = db();

  let user;
  try {
    user = await auth.getUserByEmail(ADMIN_EMAIL);
    console.log("User already exists, uid:", user.uid);
  } catch (e) {
    if (e.code === "auth/user-not-found") {
      user = await auth.createUser({
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
        displayName: ADMIN_NAME,
        emailVerified: true,
      });
      console.log("Created user, uid:", user.uid);
    } else {
      throw e;
    }
  }

  // Set custom claim so every Firebase ID token carries role: ADMIN
  await auth.setCustomUserClaims(user.uid, { role: ROLES.ADMIN });
  console.log("Set custom claim role=ADMIN");

  // Upsert Firestore profile (admin portal reads/writes as admin)
  const ref = firestore.collection(COLLECTIONS.USERS).doc(user.uid);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({
      name: ADMIN_NAME,
      email: ADMIN_EMAIL,
      mobile: null,
      role: ROLES.ADMIN,
      isGuest: false,
      fcmTokens: [],
      totalOrders: 0,
      lifetimeSpending: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    console.log("Created Firestore profile");
  } else {
    await ref.update({ role: ROLES.ADMIN, updatedAt: Date.now() });
    console.log("Updated Firestore profile with role=ADMIN");
  }

  console.log("Done. Admin user ready:", ADMIN_EMAIL);
  process.exit(0);
}

run().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
