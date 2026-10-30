const { withStoreHours, storeStatus } = require('../config/storeHours');
const { withDeliveryArea } = require('../config/deliveryArea');
const express = require("express");
const { asyncHandler } = require("../middleware/error");
const { authenticate, requireRole } = require("../middleware/auth");
const { db } = require("../config/firebase");
const { ROLES, COLLECTIONS } = require("../config/constants");
const { configSchema } = require("../schemas/config.schema");

const router = express.Router();

// In-memory cache for config
let cache = null;
let cacheAt = 0;
const CACHE_TTL_MS = 30_000;

// GET /api/config — public; used by apps to get radius, slots, min order, etc.
router.get(
  "/",
  asyncHandler(async (req, res) => {
    if (cache && Date.now() - cacheAt < CACHE_TTL_MS) {
      return res.json({ ...cache, serverTime: Date.now(), storeStatus: storeStatus(Date.now(), cache) });
    }
    try {
      const snap = await db().collection(COLLECTIONS.CONFIG).doc("global").get();
      if (snap.exists) {
        cache = withStoreHours(withDeliveryArea({ id: snap.id, ...snap.data() }));
        cacheAt = Date.now();
        return res.json({ ...cache, serverTime: Date.now(), storeStatus: storeStatus(Date.now(), cache) });
      }
    } catch (err) {
      console.warn("Firestore error in /api/config:", err.message);
      if (cache) {
        return res.json({ ...cache, serverTime: Date.now(), storeStatus: storeStatus(Date.now(), cache) });
      }
    }

    // Fallback default config if Firestore is empty or quota is exhausted
    const fallback = withStoreHours(withDeliveryArea({
      id: "global",
      minOrderValue: 200,
      taxPercent: 0,
      slots: [],
      deliveryMode: 'ON_DEMAND',
      storeHours: { opensAt: '10:00', closesAt: '23:00', timeZone: 'Asia/Kolkata' },
      orderSeq: 1000,
      updatedAt: Date.now(),
    }));
    cache = fallback;
    cacheAt = Date.now();
    res.json({ ...cache, serverTime: Date.now(), storeStatus: storeStatus(Date.now(), cache) });
  })
);

// PUT /api/config — admin only; update any config fields
router.put(
  "/",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const snap = await db().collection(COLLECTIONS.CONFIG).doc("global").get();
    if (!snap.exists) {
      const e = new Error("Config not found. Run npm run seed first.");
      e.statusCode = 404;
      throw e;
    }
    const merged = withStoreHours({ ...withDeliveryArea(snap.data()), ...req.body, updatedAt: Date.now() });
    const { error, value } = configSchema.validate(merged, { abortEarly: false });
    if (error) {
      const e = new Error("Validation failed: " + error.details.map((d) => d.message).join("; "));
      e.statusCode = 422;
      throw e;
    }
    await db().collection(COLLECTIONS.CONFIG).doc("global").set(withStoreHours(withDeliveryArea(value)));
    cache = null; // invalidate cache
    res.json({ ...withStoreHours(withDeliveryArea(value)), serverTime: Date.now(), storeStatus: storeStatus(Date.now(), value) });
  })
);

module.exports = router;
