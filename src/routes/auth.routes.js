const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const { issueCode, cancelCode, verifyCode, claimReset, fail } = require("../services/accountCodes");
const { asyncHandler } = require("../middleware/error");
const { authenticate } = require("../middleware/auth");
const { Users, DeliveryPartners } = require("../models");
const { db, authAdmin } = require("../config/firebase");
const { COLLECTIONS, ROLES } = require("../config/constants");
const { sendOTPEmail } = require("../services/emailService");
const { publicUser } = require("../utils/publicUser");

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error("JWT_SECRET is required");

const BCRYPT_ROUNDS = 10;

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function signCustomerToken(uid, email, role = ROLES.CUSTOMER) {
  return jwt.sign({ uid, role, email }, JWT_SECRET, { expiresIn: "30d" });
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

async function verifyWithFirebaseAuth(email, password) {
  const apiKey = process.env.FIREBASE_API_KEY || "AIzaSyDR-BltC2fuUfA76m29S-HXP6ZidlWrW34";
  try {
    const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
    const data = await res.json();
    if (data.error) {
      return { success: false, error: data.error.message };
    }
    return { success: true, user: data };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

let firestoreQuotaExhaustedUntil = 0;
function isFirestoreQuotaExhausted() {
  return Date.now() < firestoreQuotaExhaustedUntil;
}
function markFirestoreQuotaExhausted() {
  firestoreQuotaExhaustedUntil = Date.now() + 60_000;
}

async function findUserByEmail(email) {
  if (!isFirestoreQuotaExhausted()) {
    try {
      const snap = await db().collection(COLLECTIONS.USERS).where("email", "==", email).limit(1).get();
      if (!snap.empty) return { id: snap.docs[0].id, ...snap.docs[0].data() };
    } catch (err) {
      if (err.code === 8 || err.message?.includes("Quota exceeded")) {
        markFirestoreQuotaExhausted();
        console.warn("Firestore quota exceeded in findUserByEmail, falling back to authAdmin");
      } else {
        throw err;
      }
    }
  }
  try {
    const u = await authAdmin().getUserByEmail(email);
    return {
      id: u.uid,
      email: u.email,
      name: u.displayName || email.split("@")[0],
      role: u.customClaims?.role || ROLES.CUSTOMER,
      isAuthOnly: true,
    };
  } catch {
    return null;
  }
}

async function findUserByMobile(mobile) {
  if (!isFirestoreQuotaExhausted()) {
    try {
      const snap = await db().collection(COLLECTIONS.USERS).where("mobile", "==", mobile).limit(1).get();
      if (!snap.empty) return { id: snap.docs[0].id, ...snap.docs[0].data() };
    } catch (err) {
      if (err.code === 8 || err.message?.includes("Quota exceeded")) {
        markFirestoreQuotaExhausted();
        console.warn("Firestore quota exceeded in findUserByMobile, falling back to authAdmin");
      } else {
        throw err;
      }
    }
  }
  try {
    const u = await authAdmin().getUserByEmail(`${mobile}@ms-traders.in`);
    return {
      id: u.uid,
      email: u.email,
      mobile,
      name: u.displayName || "User",
      role: u.customClaims?.role || ROLES.CUSTOMER,
      isAuthOnly: true,
    };
  } catch {
    try {
      const u = await authAdmin().getUserByPhoneNumber(`+91${mobile}`);
      return {
        id: u.uid,
        email: u.email,
        mobile,
        name: u.displayName || "User",
        role: u.customClaims?.role || ROLES.CUSTOMER,
        isAuthOnly: true,
      };
    } catch {
      return null;
    }
  }
}

// POST /api/auth/register — new customer signs up with name, mobile, and optional email/password
router.post(
  "/register",
  asyncHandler(async (req, res) => {
    const { name, email, mobile, password } = req.body;
    if (!name || !mobile) {
      return res.status(422).json({ error: "name and mobile are required" });
    }
    const cleanMobile = String(mobile).trim().replace(/[^0-9]/g, "");
    if (!/^[0-9]{10}$/.test(cleanMobile)) {
      return res.status(422).json({ error: "Mobile number must be exactly 10 digits" });
    }

    const normalizedEmail = email ? normalizeEmail(email) : `${cleanMobile}@ms-traders.in`;
    const userPassword = password && String(password).length >= 8 ? password : `MST@${cleanMobile}`;

    const existingMobile = await findUserByMobile(cleanMobile);
    if (existingMobile) {
      return res.status(409).json({ error: "An account with this mobile number already exists. Please sign in instead." });
    }
    if (email) {
      const existingEmail = await findUserByEmail(normalizedEmail);
      if (existingEmail) {
        return res.status(409).json({ error: "An account with this email already exists. Please sign in instead." });
      }
    }

    const now = Date.now();
    const passwordHash = await bcrypt.hash(userPassword, BCRYPT_ROUNDS);
    const uid = db().collection(COLLECTIONS.USERS).doc().id;
    const user = await Users.create(uid, {
      name: String(name).trim(),
      email: normalizedEmail,
      passwordHash,
      mobile: cleanMobile,
      defaultAddressId: null,
      isGuest: false,
      createdAt: now,
      updatedAt: now,
    });

    const token = signCustomerToken(uid, normalizedEmail);
    mirrorToFirebaseAuth(uid, normalizedEmail, userPassword, name); // fire-and-forget
    res.status(201).json({ ...publicUser(user), token });
  })
);

// POST /api/auth/login — signs in with email/password or mobile number
router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { email, password, mobile } = req.body;
    if (!email && !mobile) {
      return res.status(422).json({ error: "Mobile number or email is required" });
    }
    if (!password) {
      return res.status(422).json({ error: "Email and password are required" });
    }

    let user = null;
    let role = ROLES.CUSTOMER;
    let normalizedEmail = email ? normalizeEmail(email) : null;

    if (mobile) {
      const cleanMobile = String(mobile).trim().replace(/[^0-9]/g, "");
      user = await findUserByMobile(cleanMobile);
      if (!user) {
        // Also check if delivery partner has this mobile
        try {
          const dpSnap = await db().collection(COLLECTIONS.DELIVERY_PARTNERS).where("mobile", "==", cleanMobile).limit(1).get();
          if (!dpSnap.empty) {
            user = { id: dpSnap.docs[0].id, ...dpSnap.docs[0].data() };
            role = ROLES.PARTNER;
          }
        } catch (_dpErr) {}
      }
      if (user) {
        normalizedEmail = user.email || `${cleanMobile}@ms-traders.in`;
      }
    } else if (email) {
      user = await findUserByEmail(normalizedEmail);
      if (!user) {
        try {
          const dpSnap = await db().collection(COLLECTIONS.DELIVERY_PARTNERS).where("email", "==", normalizedEmail).limit(1).get();
          if (!dpSnap.empty) {
            user = { id: dpSnap.docs[0].id, ...dpSnap.docs[0].data() };
            role = ROLES.PARTNER;
          }
        } catch (_dpErr) {}
      }
    }

    // If user is not yet resolved, verify directly with Firebase Auth (e.g. if Firestore quota is exceeded)
    if (!user) {
      const candidateEmail = normalizedEmail || (mobile ? `${String(mobile).trim().replace(/[^0-9]/g, "")}@ms-traders.in` : null);
      if (candidateEmail) {
        const fbAuth = await verifyWithFirebaseAuth(candidateEmail, password);
        if (fbAuth.success) {
          try {
            const authRecord = await authAdmin().getUser(fbAuth.user.localId);
            role = authRecord.customClaims?.role || ROLES.CUSTOMER;
            user = {
              id: authRecord.uid,
              name: authRecord.displayName || candidateEmail.split("@")[0],
              email: candidateEmail,
              mobile: (authRecord.phoneNumber || mobile || "").replace(/^\+91/, ""),
              isAuthOnly: true,
            };
            normalizedEmail = candidateEmail;
          } catch (_err) {}
        } else if (fbAuth.error === "INVALID_LOGIN_CREDENTIALS" || fbAuth.error === "INVALID_PASSWORD") {
          return res.status(401).json({ error: "Incorrect password" });
        }
      }
    }

    if (!user) {
      return res.status(404).json({
        notFound: true,
        error: "No account found. Please create an account to continue.",
      });
    }

    if (user.role) {
      role = user.role;
    }

    // If password was provided, verify it
    if (user.passwordHash) {
      const match = await bcrypt.compare(password, user.passwordHash);
      if (!match) {
        return res.status(401).json({ error: "Incorrect password" });
      }
    } else {
      const candidateEmail = normalizedEmail || user.email || (mobile ? `${mobile}@ms-traders.in` : null);
      if (candidateEmail) {
        const fbAuth = await verifyWithFirebaseAuth(candidateEmail, password);
        if (!fbAuth.success) {
          return res.status(401).json({ error: "Incorrect password" });
        }
      }
    }

    const token = signCustomerToken(user.id, normalizedEmail || user.email || "user@ms-traders.in", role);
    res.json({ ...publicUser(user), token, role });
  })
);

// Additional IP limit complements persistent per-account transactional limits.
const recoveryLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: "Too many recovery requests. Please try again later." } });
const validEmail = email => typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
router.post('/forgot-password', recoveryLimit, asyncHandler(async (req, res) => {
  if (!validEmail(req.body.email)) throw fail('Enter a valid email address.', 422);
  const email = normalizeEmail(req.body.email);
  const user = await findUserByEmail(email);
  if (!user) throw fail('Email does not exist. Please enter your registered email address.', 404);
  const issued = await issueCode('reset', email, user.id);
  const result = await sendOTPEmail(email, issued.otp);
  if (!result.delivered) {
    await cancelCode('reset', email, issued.generation);
    throw fail('Unable to send the code email. Please try again later.', 503);
  }
  res.json({ ok: true, message: 'A six-digit code has been sent to your registered email.', expiresIn: 900 });
}));
router.post('/verify-reset-otp', recoveryLimit, asyncHandler(async (req, res) => {
  if (!validEmail(req.body.email)) throw fail('Enter a valid email address.', 422);
  const result = await verifyCode('reset', normalizeEmail(req.body.email), req.body.otp);
  res.json({ ok: true, resetToken: result.token });
}));
router.post('/reset-password', recoveryLimit, asyncHandler(async (req, res) => {
  const { email, token, password, confirmPassword } = req.body;
  if (!validEmail(email) || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw fail('Invalid reset permission.', 422);
  if (typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) throw fail('Password must be at least 8 characters and at most 72 UTF-8 bytes.', 422);
  if (confirmPassword !== password) throw fail('Passwords do not match.', 422);
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const claim = await claimReset(normalizeEmail(email), token);
  try {
    // Await Firebase before reporting success: both login paths must accept the new password.
    try {
      await authAdmin().updateUser(claim.uid, { password });
    } catch (error) {
      if (error.code !== 'auth/user-not-found') throw error;
      await authAdmin().createUser({ uid: claim.uid, email: normalizeEmail(email), password });
    }
    await authAdmin().revokeRefreshTokens(claim.uid);
    await db().runTransaction(async tx => {
      const current = (await tx.get(claim.ref)).data();
      if (!current?.processing || current.tokenHash !== claim.tokenHash) throw fail('Reset state changed. Please request a new code.', 409);
      tx.update(db().collection(COLLECTIONS.USERS).doc(claim.uid), {
        passwordHash, firebaseAuthMirrored: true, resetPasswordOtp: null,
        resetPasswordTokenHash: null, resetPasswordExpires: null, updatedAt: Date.now(),
      });
      tx.update(claim.ref, { processing: false, tokenHash: null, codeHash: null });
    });
  } catch (error) {
    await claim.ref.update({ processing: false });
    console.error('Password reset could not complete:', error.code || error.name);
    throw fail('Password update could not complete. Please retry saving your password.', 503);
  }
  res.json({ ok: true, message: 'Password updated. Sign in with your new password.' });
}));

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
    let user = null;
    try {
      if (req.user.role === ROLES.PARTNER) {
        user = await DeliveryPartners.findById(req.user.uid);
      } else {
        user = await Users.findById(req.user.uid);
      }
    } catch (err) {
      if (err.code === 8 || err.message?.includes("Quota exceeded")) {
        console.warn("Firestore quota exceeded in /api/auth/me, falling back to authAdmin");
      } else {
        throw err;
      }
    }

    if (!user) {
      try {
        const authUser = await authAdmin().getUser(req.user.uid);
        user = {
          id: authUser.uid,
          name: authUser.displayName || req.user.email?.split("@")[0] || "User",
          email: authUser.email || req.user.email,
          mobile: (authUser.phoneNumber || req.user.phone || "").replace(/^\+91/, ""),
          role: req.user.role || ROLES.CUSTOMER,
          isGuest: false,
        };
      } catch (_authErr) {
        if (req.user.uid) {
          user = {
            id: req.user.uid,
            name: req.user.email?.split("@")[0] || "User",
            email: req.user.email,
            mobile: (req.user.phone || "").replace(/^\+91/, ""),
            role: req.user.role || ROLES.CUSTOMER,
            isGuest: false,
          };
        }
      }
    }

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
    const token = await authAdmin().createCustomToken(
      req.user.uid,
      req.user.role ? { role: req.user.role } : undefined
    );
    res.json({ token });
  })
);

// POST /api/auth/fcm-token — add / update FCM token for user
router.post(
  "/fcm-token",
  authenticate,
  asyncHandler(async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(422).json({ error: "Token is required" });
    const user = await Users.findById(req.user.uid);
    if (!user) return res.status(404).json({ error: "User not found" });
    let fcmTokens = user.fcmTokens || [];
    if (!fcmTokens.includes(token)) {
      fcmTokens = [...fcmTokens, token].slice(-5);
      await db()
        .collection(COLLECTIONS.USERS)
        .doc(req.user.uid)
        .update({ fcmTokens, updatedAt: Date.now() });
    }
    res.json({ ok: true, fcmTokens });
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
