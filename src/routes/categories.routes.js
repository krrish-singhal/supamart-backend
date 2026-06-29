const express = require("express");
const { asyncHandler } = require("../middleware/error");
const { authenticate, requireRole } = require("../middleware/auth");
const { Categories } = require("../models");
const { ROLES } = require("../config/constants");
const { db } = require("../config/firebase");
const { COLLECTIONS } = require("../config/constants");
const multer = require("multer");
const { upload: uploadToCloud } = require("../services/storageService");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// In-memory cache for categories (invalidated on any write)
let cache = null;
let cacheAt = 0;
const CACHE_TTL_MS = 60_000;

function invalidateCache() {
  cache = null;
}

// GET /api/categories — public, cached
router.get(
  "/",
  asyncHandler(async (req, res) => {
    if (cache && Date.now() - cacheAt < CACHE_TTL_MS) {
      return res.json({ items: cache });
    }
    const snap = await db()
      .collection(COLLECTIONS.CATEGORIES)
      .where("isActive", "==", true)
      .orderBy("order", "asc")
      .get();
    cache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    cacheAt = Date.now();
    res.json({ items: cache });
  })
);

// GET /api/categories/:id
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const cat = await Categories.findById(req.params.id);
    if (!cat) return res.status(404).json({ error: "Category not found" });
    res.json(cat);
  })
);

// POST /api/categories — admin only
router.post(
  "/",
  authenticate,
  requireRole(ROLES.ADMIN),
  upload.single("image"),
  asyncHandler(async (req, res) => {
    const now = Date.now();
    let image = req.body.image || null;
    
    if (req.file) {
      const uploadRes = await uploadToCloud(req.file.buffer, "categories");
      image = uploadRes.url;
    }

    const catData = { ...req.body, isActive: req.body.isActive === 'true' || req.body.isActive === true };
    if (image) catData.image = image;

    const cat = await Categories.create(null, { ...catData, createdAt: now, updatedAt: now });
    invalidateCache();
    res.status(201).json(cat);
  })
);

// PUT /api/categories/:id — admin only
router.put(
  "/:id",
  authenticate,
  requireRole(ROLES.ADMIN),
  upload.single("image"),
  asyncHandler(async (req, res) => {
    let image = req.body.image;
    
    if (req.file) {
      const uploadRes = await uploadToCloud(req.file.buffer, "categories");
      image = uploadRes.url;
    }

    const updateData = { ...req.body, updatedAt: Date.now() };
    if (req.body.isActive !== undefined) {
      updateData.isActive = req.body.isActive === 'true' || req.body.isActive === true;
    }
    if (image !== undefined) updateData.image = image;

    const updated = await Categories.update(req.params.id, updateData);
    invalidateCache();
    res.json(updated);
  })
);

// DELETE /api/categories/:id — admin only
router.delete(
  "/:id",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    await Categories.delete(req.params.id);
    invalidateCache();
    res.json({ id: req.params.id, deleted: true });
  })
);

// PATCH /api/categories/reorder — admin: submit array of {id, order} to reorder
router.patch(
  "/reorder",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const { items } = req.body; // [{ id, order }]
    if (!Array.isArray(items)) {
      const e = new Error("items must be an array");
      e.statusCode = 422;
      throw e;
    }
    const batch = db().batch();
    const now = Date.now();
    items.forEach(({ id, order }) => {
      batch.update(db().collection(COLLECTIONS.CATEGORIES).doc(id), { order, updatedAt: now });
    });
    await batch.commit();
    invalidateCache();
    res.json({ ok: true });
  })
);

module.exports = router;
