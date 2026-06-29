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
      return res.json(cache);
    }
    const snap = await db().collection(COLLECTIONS.CONFIG).doc("global").get();
    if (!snap.exists) return res.status(503).json({ error: "Config not initialized. Run npm run seed." });
    cache = { id: snap.id, ...snap.data() };
    cacheAt = Date.now();
    res.json(cache);
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
    const merged = { ...snap.data(), ...req.body, updatedAt: Date.now() };
    const { error, value } = configSchema.validate(merged, { abortEarly: false });
    if (error) {
      const e = new Error("Validation failed: " + error.details.map((d) => d.message).join("; "));
      e.statusCode = 422;
      throw e;
    }
    await db().collection(COLLECTIONS.CONFIG).doc("global").set(value);
    cache = null; // invalidate cache
    res.json(value);
  })
);

module.exports = router;
