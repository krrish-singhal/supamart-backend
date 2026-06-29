const admin = require("firebase-admin");

let initialized = false;

function initFirebase() {
  if (initialized) return admin;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error("Missing Firebase service account env vars");
  }

  admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
  });

  initialized = true;
  return admin;
}

function db() {
  return initFirebase().firestore();
}

function authAdmin() {
  return initFirebase().auth();
}

function messaging() {
  return initFirebase().messaging();
}

module.exports = { admin, initFirebase, db, authAdmin, messaging };
