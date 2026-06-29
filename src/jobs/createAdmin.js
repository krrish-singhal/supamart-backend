/**
 * Run once after Firebase Auth is enabled:
 *   cd backend && node src/jobs/createAdmin.js
 *
 * Creates the admin portal user and sets ADMIN role claim.
 * Safe to re-run — won't duplicate if user already exists.
 */
require("dotenv").config();
const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY,
    }),
  });
}

const ADMIN_EMAIL    = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_NAME     = process.env.ADMIN_NAME || "SupaMart Admin";

if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error("Error: ADMIN_EMAIL and ADMIN_PASSWORD must be set in .env");
  process.exit(1);
}

async function main() {
  let user;
  try {
    user = await admin.auth().getUserByEmail(ADMIN_EMAIL);
    console.log("User already exists — uid:", user.uid);
  } catch {
    user = await admin.auth().createUser({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      displayName: ADMIN_NAME,
      emailVerified: true,
    });
    console.log("Admin user created — uid:", user.uid);
  }

  await admin.auth().setCustomUserClaims(user.uid, { role: "ADMIN" });
  console.log("ADMIN role claim set.\n");

  console.log("==============================================");
  console.log("  Admin Portal Login Credentials");
  console.log("==============================================");
  console.log("  URL      : http://localhost:5173");
  console.log("  Email    : " + ADMIN_EMAIL);
  console.log("==============================================\n");
  process.exit(0);
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
