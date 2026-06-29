const express = require("express");
const jwt = require("jsonwebtoken");
const { asyncHandler } = require("../middleware/error");
const { authenticate } = require("../middleware/auth");
const { Users, DeliveryPartners } = require("../models");
const { db, authAdmin } = require("../config/firebase");
const { COLLECTIONS, ROLES } = require("../config/constants");

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error("JWT_SECRET env var is required");

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
    res.json({ ...user, role: req.user.role });
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
