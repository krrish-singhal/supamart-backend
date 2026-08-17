const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { asyncHandler } = require("../middleware/error");
const { authenticate } = require("../middleware/auth");
const { Users, DeliveryPartners } = require("../models");
const { db, authAdmin } = require("../config/firebase");
const { COLLECTIONS, ROLES } = require("../config/constants");
const { sendPasswordResetEmail } = require("../services/emailService");
const { publicUser } = require("../utils/publicUser");

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error("JWT_SECRET env var is required");

const PUBLIC_APP_URL = process.env.PUBLIC_APP_URL || "http://localhost:5000";
const BCRYPT_ROUNDS = 10;

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function signCustomerToken(uid, email) {
  return jwt.sign({ uid, role: ROLES.CUSTOMER, email }, JWT_SECRET, { expiresIn: "30d" });
}

// Mirrors a customer's email/password credentials into Firebase Auth, using the SAME uid
// as their existing users/{uid} Firestore doc. This is what lets the customer app sign in
// directly against Firebase Auth (fast, no dependency on this Render service waking up
// from a cold start) instead of this bcrypt-verified endpoint, while every existing route
// and the Firestore doc itself are completely unchanged — see customer/src/context/
// AuthContext.js for the client side of this.
//
// Called fire-and-forget (not awaited) from /register and /login so it never adds latency
// to those responses, and wrapped so it can never throw into the caller: a mirroring
// failure must never break registration or login, which both keep working exactly as
// before via this same endpoint regardless of whether the mirror succeeds.
async function mirrorToFirebaseAuth(uid, email, password, name) {
  // Written via a raw Firestore update (not Users.update()) deliberately: the Repository's
  // Joi schema strips any field it doesn't know about (stripUnknown: true), which would
  // silently discard firebaseAuthMirrored on every call and defeat the whole point of the
  // flag (skipping redundant mirror attempts on future logins). Same pattern the
  // DELETE /fcm-token route below already uses for the same reason.
  const markMirrored = () =>
    db().collection(COLLECTIONS.USERS).doc(uid).update({ firebaseAuthMirrored: true, updatedAt: Date.now() });

  try {
    await authAdmin().createUser({ uid, email, password, displayName: name || undefined });
    await markMirrored();
  } catch (err) {
    if (err.code === "auth/uid-already-exists" || err.code === "auth/email-already-exists") {
      // Already mirrored from a previous call — just make sure the flag reflects that so
      // future logins don't keep re-attempting this.
      await markMirrored().catch(() => {});
    } else {
      console.error(`mirrorToFirebaseAuth failed for uid=${uid}:`, err.message || err);
    }
  }
}

async function findUserByEmail(email) {
  const snap = await db().collection(COLLECTIONS.USERS).where("email", "==", email).limit(1).get();
  if (snap.empty) return null;
  return { id: snap.docs[0].id, ...snap.docs[0].data() };
}

async function findUserByMobile(mobile) {
  const snap = await db().collection(COLLECTIONS.USERS).where("mobile", "==", mobile).limit(1).get();
  if (snap.empty) return null;
  return { id: snap.docs[0].id, ...snap.docs[0].data() };
}

// POST /api/auth/register — new customer signs up with name, email, mobile, password
router.post(
  "/register",
  asyncHandler(async (req, res) => {
    const { name, email, mobile, password } = req.body;
    if (!name || !email || !mobile || !password) {
      return res.status(422).json({ error: "name, email, mobile and password are required" });
    }
    if (!/^[0-9]{10}$/.test(String(mobile))) {
      return res.status(422).json({ error: "Mobile number must be exactly 10 digits" });
    }
    if (String(password).length < 8) {
      return res.status(422).json({ error: "Password must be at least 8 characters" });
    }
    const normalizedEmail = normalizeEmail(email);
    const existingEmail = await findUserByEmail(normalizedEmail);
    if (existingEmail) {
      return res.status(409).json({ error: "An account with this email already exists. Please sign in instead." });
    }
    const existingMobile = await findUserByMobile(mobile);
    if (existingMobile) {
      return res.status(409).json({ error: "An account with this mobile number already exists. Please sign in instead." });
    }

    const now = Date.now();
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const uid = db().collection(COLLECTIONS.USERS).doc().id;
    const user = await Users.create(uid, {
      name,
      email: normalizedEmail,
      passwordHash,
      mobile,
      defaultAddressId: null,
      isGuest: false,
      createdAt: now,
      updatedAt: now,
    });

    const token = signCustomerToken(uid, normalizedEmail);
    mirrorToFirebaseAuth(uid, normalizedEmail, password, name); // fire-and-forget — see comment above
    res.status(201).json({ ...publicUser(user), token });
  })
);

// POST /api/auth/login — existing customer signs in with email + password
router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(422).json({ error: "email and password are required" });
    }
    const normalizedEmail = normalizeEmail(email);
    const user = await findUserByEmail(normalizedEmail);
    if (!user || !user.passwordHash) {
      return res.status(401).json({ error: "No account found with this email. Please register first." });
    }
    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      return res.status(401).json({ error: "Incorrect password" });
    }
    const token = signCustomerToken(user.id, normalizedEmail);
    // Lazy migration: the first time an existing (pre-migration) account logs in via this
    // slow bcrypt-verified path, mirror it into Firebase Auth in the background using the
    // plaintext password we just verified — every login after this one can then go
    // through the fast Firebase Auth path instead. Fire-and-forget, never blocks this response.
    if (!user.firebaseAuthMirrored) {
      mirrorToFirebaseAuth(user.id, normalizedEmail, password, user.name);
    }
    res.json({ ...publicUser(user), token });
  })
);

// POST /api/auth/forgot-password — emails a reset link (always 200, doesn't reveal if the email exists)
router.post(
  "/forgot-password",
  asyncHandler(async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(422).json({ error: "email is required" });
    const normalizedEmail = normalizeEmail(email);
    const user = await findUserByEmail(normalizedEmail);

    if (user) {
      const rawToken = crypto.randomBytes(32).toString("hex");
      const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
      const expires = Date.now() + 60 * 60 * 1000; // 1 hour
      await Users.update(user.id, { resetPasswordTokenHash: tokenHash, resetPasswordExpires: expires, updatedAt: Date.now() });

      const resetUrl = `${PUBLIC_APP_URL}/reset-password?token=${rawToken}`;
      await sendPasswordResetEmail(normalizedEmail, resetUrl);
    }

    // Same response whether or not the account exists, so we don't leak which emails are registered.
    res.json({ ok: true, message: "If an account exists for that email, a reset link has been sent." });
  })
);

// POST /api/auth/reset-password — sets a new password using the token from the email
router.post(
  "/reset-password",
  asyncHandler(async (req, res) => {
    const { token, password } = req.body;
    if (!token || !password) return res.status(422).json({ error: "token and password are required" });
    if (String(password).length < 8) {
      return res.status(422).json({ error: "Password must be at least 8 characters" });
    }

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const snap = await db()
      .collection(COLLECTIONS.USERS)
      .where("resetPasswordTokenHash", "==", tokenHash)
      .limit(1)
      .get();
    if (snap.empty) return res.status(400).json({ error: "This reset link is invalid. Please request a new one." });

    const doc = snap.docs[0];
    const user = doc.data();
    if (!user.resetPasswordExpires || user.resetPasswordExpires < Date.now()) {
      return res.status(400).json({ error: "This reset link has expired. Please request a new one." });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await Users.update(doc.id, {
      passwordHash,
      resetPasswordTokenHash: null,
      resetPasswordExpires: null,
      updatedAt: Date.now(),
    });
    res.json({ ok: true, message: "Password updated. You can now sign in." });
  })
);

// POST /api/auth/session
// Upserts user/partner profile and returns a signed JWT.
// Accepts: { firebaseToken } for real auth, or { devBypass: true, mobile: "1234567890" } for demo.
// For delivery app demo pass { devBypass: true, deliveryApp: true, mobile: "1234567890" }.
router.post(
  "/session",
  asyncHandler(async (req, res) => {
    const { name, fcmToken, firebaseToken, devBypass, mobile, deliveryApp } = req.body;
    let uid, phone, role;

    if (devBypass && mobile === "1234567890") {
      if (deliveryApp) {
        uid = "dev-partner-1234567890";
        phone = "+911234567890";
        role = ROLES.PARTNER;
      } else {
        uid = "dev-user-1234567890";
        phone = "+911234567890";
        role = ROLES.CUSTOMER;
      }
    } else {
      if (!firebaseToken) return res.status(401).json({ error: "Missing firebase token" });
      try {
        const decoded = await authAdmin().verifyIdToken(firebaseToken);
        uid = decoded.uid;
        phone = decoded.phone_number;
        role = decoded.role || ROLES.CUSTOMER;

        if (deliveryApp && role !== ROLES.PARTNER) {
          role = ROLES.PARTNER;
          await authAdmin().setCustomUserClaims(uid, { role: ROLES.PARTNER });
        }
      } catch {
        return res.status(401).json({ error: "Invalid firebase token" });
      }
    }

    const now = Date.now();
    const token = jwt.sign({ uid, role, phone }, JWT_SECRET, { expiresIn: "30d" });

    // ── Delivery partner path ──────────────────────────────────────────────────
    if (role === ROLES.PARTNER) {
      let partner = await DeliveryPartners.findById(uid);
      if (!partner) {
        // mobile from req.body is always 10 digits; phone from Firebase is +91XXXXXXXXXX
        const partnerMobile = mobile || (phone || "").replace(/^\+91/, "");
        partner = await DeliveryPartners.create(uid, {
          name: name || "Demo Partner",
          mobile: partnerMobile,
          isActive: true,
          fcmTokens: fcmToken ? [fcmToken] : [],
          currentOrders: [],
          createdAt: now,
        });
      } else if (fcmToken && !(partner.fcmTokens || []).includes(fcmToken)) {
        const fcmTokens = [...(partner.fcmTokens || []), fcmToken].slice(-5);
        await db().collection(COLLECTIONS.DELIVERY_PARTNERS).doc(uid).update({ fcmTokens, updatedAt: now });
        partner = { ...partner, fcmTokens };
      }
      return res.status(200).json({ ...partner, token });
    }

    // ── Customer path ──────────────────────────────────────────────────────────
    const existing = await Users.findById(uid);
    let userResult;

    // Normalize mobile: req.body.mobile is 10 digits; Firebase phone_number is +91XXXXXXXXXX
    const userMobile = mobile || (phone || "").replace(/^\+91/, "");

    if (!existing) {
      userResult = await Users.create(uid, {
        name: name || "User",
        mobile: userMobile,
        email: null,
        defaultAddressId: null,
        isGuest: false,
        fcmTokens: fcmToken ? [fcmToken] : [],
        totalOrders: 0,
        lifetimeSpending: 0,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      let fcmTokens = existing.fcmTokens || [];
      if (fcmToken && !fcmTokens.includes(fcmToken)) {
        fcmTokens = [...fcmTokens, fcmToken].slice(-5);
        await db().collection(COLLECTIONS.USERS).doc(uid).update({ fcmTokens, updatedAt: now });
      }
      userResult = { ...existing, fcmTokens };
    }

    res.status(existing ? 200 : 201).json({ ...userResult, token });
  })
);

// GET /api/auth/me — returns the current user's profile + role
router.get(
  "/me",
  authenticate,
  asyncHandler(async (req, res) => {
    const user = await Users.findById(req.user.uid);
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ ...publicUser(user), role: req.user.role });
  })
);

// GET /api/auth/firebase-token — mints a short-lived Firebase custom auth token for the
// current user (identified by whichever auth the `authenticate` middleware accepted —
// backend JWT for the customer/delivery apps, Firebase ID token for the admin portal).
// The customer app is backend-JWT-only against our own API (see services/firebase.js),
// which means the Firestore *client* SDK's `request.auth` is otherwise always null —
// fine for the public-read collections (categories/products/orders-by-id), but not for
// owner-restricted ones like users/{uid}/notifications. Signing into Firebase with this
// token (customer app: signInWithCustomToken) makes request.auth.uid match `uid`, so
// those rules resolve correctly for direct onSnapshot listeners.
router.get(
  "/firebase-token",
  authenticate,
  asyncHandler(async (req, res) => {
    const token = await authAdmin().createCustomToken(req.user.uid);
    res.json({ token });
  })
);

// DELETE /api/auth/fcm-token — remove a specific FCM token (on logout)
router.delete(
  "/fcm-token",
  authenticate,
  asyncHandler(async (req, res) => {
    const { token } = req.body;
    const user = await Users.findById(req.user.uid);
    if (!user) return res.status(404).json({ error: "User not found" });
    const fcmTokens = (user.fcmTokens || []).filter((t) => t !== token);
    await db()
      .collection(COLLECTIONS.USERS)
      .doc(req.user.uid)
      .update({ fcmTokens, updatedAt: Date.now() });
    res.json({ ok: true });
  })
);

module.exports = router;
