const express = require("express");
const { asyncHandler } = require("../middleware/error");
const { authenticate, requireRole } = require("../middleware/auth");
const { Brands } = require("../models");
const { ROLES, COLLECTIONS } = require("../config/constants");
const { db } = require("../config/firebase");
const multer = require("multer");
const { upload: uploadToCloud } = require("../services/storageService");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// In-memory cache for brands (invalidated on any write)
let cache = null;
let cacheAt = 0;
const CACHE_TTL_MS = 60_000;

function invalidateCache() {
  cache = null;
}

// GET /api/brands — public, cached
router.get(
  "/",
  asyncHandler(async (req, res) => {
    if (cache && Date.now() - cacheAt < CACHE_TTL_MS) {
      return res.json({ items: cache });
    }
    const snap = await db()
      .collection(COLLECTIONS.BRANDS)
      .where("isActive", "==", true)
      .orderBy("order", "asc")
      .get();
    cache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    cacheAt = Date.now();
    res.json({ items: cache });
  })
);

// GET /api/brands/:id
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const brand = await Brands.findById(req.params.id);
    if (!brand) return res.status(404).json({ error: "Brand not found" });
    res.json(brand);
  })
);

// POST /api/brands — admin only
router.post(
  "/",
  authenticate,
  requireRole(ROLES.ADMIN),
  upload.single("logo"),
  asyncHandler(async (req, res) => {
    const now = Date.now();
    let logoUrl = req.body.logoUrl || null;

    if (req.file) {
      const uploadRes = await uploadToCloud(req.file.buffer, "brands");
      logoUrl = uploadRes.url;
    }

    const brandData = { ...req.body, isActive: req.body.isActive === "true" || req.body.isActive === true };
    if (logoUrl) brandData.logoUrl = logoUrl;

    const brand = await Brands.create(null, { ...brandData, createdAt: now, updatedAt: now });
    invalidateCache();
    res.status(201).json(brand);
  })
);

// PUT /api/brands/:id — admin only
router.put(
  "/:id",
  authenticate,
  requireRole(ROLES.ADMIN),
  upload.single("logo"),
  asyncHandler(async (req, res) => {
    let logoUrl = req.body.logoUrl;

    if (req.file) {
      const uploadRes = await uploadToCloud(req.file.buffer, "brands");
      logoUrl = uploadRes.url;
    }

    const updateData = { ...req.body, updatedAt: Date.now() };
    if (req.body.isActive !== undefined) {
      updateData.isActive = req.body.isActive === "true" || req.body.isActive === true;
    }
    if (logoUrl !== undefined) updateData.logoUrl = logoUrl;

    const updated = await Brands.update(req.params.id, updateData);
    invalidateCache();
    res.json(updated);
  })
);

// DELETE /api/brands/:id — admin only
router.delete(
  "/:id",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    await Brands.delete(req.params.id);
    invalidateCache();
    res.json({ id: req.params.id, deleted: true });
  })
);

module.exports = router;
