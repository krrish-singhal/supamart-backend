const express = require("express");
const multer = require("multer");
const { asyncHandler } = require("../middleware/error");
const { authenticate, requireRole } = require("../middleware/auth");
const { Banners } = require("../models");
const { ROLES, COLLECTIONS } = require("../config/constants");
const { upload: uploadToCloud } = require("../services/storageService");
const { db } = require("../config/firebase");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// In-memory cache for active banners
let cache = null;
let cacheAt = 0;
const CACHE_TTL_MS = 60_000;
function invalidateCache() { cache = null; }

// GET /api/banners — public, cached, active only, ordered
router.get(
  "/",
  asyncHandler(async (req, res) => {
    if (cache && Date.now() - cacheAt < CACHE_TTL_MS) {
      return res.json({ items: cache });
    }
    const snap = await db()
      .collection(COLLECTIONS.BANNERS)
      .where("isActive", "==", true)
      .orderBy("order", "asc")
      .get();
    cache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    cacheAt = Date.now();
    res.json({ items: cache });
  })
);

// POST /api/banners — admin only
router.post(
  "/",
  authenticate,
  requireRole(ROLES.ADMIN),
  upload.single("image"),
  asyncHandler(async (req, res) => {
    let imageUrl = req.body.image || "";
    if (req.file) {
      const result = await uploadToCloud(req.file.buffer, "banners");
      imageUrl = result.url;
    }
    const banner = await Banners.create(null, {
      image: imageUrl,
      target: req.body.target || null,
      order: Number(req.body.order) || 0,
      isActive: req.body.isActive !== "false",
      createdAt: Date.now(),
    });
    invalidateCache();
    res.status(201).json(banner);
  })
);

// PUT /api/banners/:id — admin only
router.put(
  "/:id",
  authenticate,
  requireRole(ROLES.ADMIN),
  upload.single("image"),
  asyncHandler(async (req, res) => {
    let update = { ...req.body };
    if (req.file) {
      const result = await uploadToCloud(req.file.buffer, "banners");
      update.image = result.url;
    }
    const updated = await Banners.update(req.params.id, update);
    invalidateCache();
    res.json(updated);
  })
);

// DELETE /api/banners/:id — admin only
router.delete(
  "/:id",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    await Banners.delete(req.params.id);
    invalidateCache();
    res.json({ id: req.params.id, deleted: true });
  })
);

module.exports = router;
