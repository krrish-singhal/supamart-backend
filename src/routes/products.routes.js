const express = require("express");
const multer = require("multer");
const { asyncHandler } = require("../middleware/error");
const { authenticate, requireRole } = require("../middleware/auth");
const { Products } = require("../models");
const { ROLES, COLLECTIONS } = require("../config/constants");
const { upload: uploadToCloud } = require("../services/storageService");
const { db } = require("../config/firebase");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// GET /api/products — paginated; filter by categoryId, availability, featured, trending
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { categoryId, availability, featured, trending, limit = 20, cursor } = req.query;
    const where = [];
    if (categoryId) where.push(["categoryId", "==", categoryId]);
    if (availability) where.push(["availability", "==", availability]);
    if (featured === "true") where.push(["isFeatured", "==", true]);
    if (trending === "true") where.push(["isTrending", "==", true]);

    const result = await Products.paginate({
      where,
      orderBy: { field: "createdAt", dir: "desc" },
      limit: Math.min(Number(limit), 50),
      startAfter: cursor || null,
    });
    res.json(result);
  })
);

// GET /api/products/search — search by name prefix (Firestore range query)
router.get(
  "/search",
  asyncHandler(async (req, res) => {
    const { q, limit = 20 } = req.query;
    if (!q || q.length < 2) return res.json({ items: [] });
    const end = q.slice(0, -1) + String.fromCharCode(q.charCodeAt(q.length - 1) + 1);
    const snap = await db()
      .collection(COLLECTIONS.PRODUCTS)
      .orderBy("name")
      .startAt(q)
      .endBefore(end)
      .limit(Number(limit))
      .get();
    const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json({ items });
  })
);

// GET /api/products/:id
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const product = await Products.findById(req.params.id);
    if (!product) return res.status(404).json({ error: "Product not found" });
    res.json(product);
  })
);

// POST /api/products — admin only, supports image upload
router.post(
  "/",
  authenticate,
  requireRole(ROLES.ADMIN),
  upload.array("images", 5),
  asyncHandler(async (req, res) => {
    const now = Date.now();
    let images = [];

    // Upload any attached image files
    if (req.files && req.files.length > 0) {
      const uploads = await Promise.all(req.files.map((f) => uploadToCloud(f.buffer, "products")));
      images = uploads.map((u) => u.url);
    }
    // Also accept pre-uploaded image URLs passed as JSON
    if (req.body.images) {
      const extra = Array.isArray(req.body.images) ? req.body.images : JSON.parse(req.body.images);
      images = [...images, ...extra];
    }

    const variants = typeof req.body.variants === "string"
      ? JSON.parse(req.body.variants)
      : req.body.variants;

    const tags = req.body.tags && typeof req.body.tags === "string"
      ? JSON.parse(req.body.tags)
      : req.body.tags;

    const product = await Products.create(null, {
      ...req.body,
      variants,
      images,
      tags: tags || [],
      createdAt: now,
      updatedAt: now,
    });
    res.status(201).json(product);
  })
);

// PUT /api/products/:id — admin only
router.put(
  "/:id",
  authenticate,
  requireRole(ROLES.ADMIN),
  upload.array("images", 5),
  asyncHandler(async (req, res) => {
    let images;

    if (req.files && req.files.length > 0) {
      const uploads = await Promise.all(req.files.map((f) => uploadToCloud(f.buffer, "products")));
      images = uploads.map((u) => u.url);
    }
    if (req.body.images) {
      const extra = Array.isArray(req.body.images) ? req.body.images : JSON.parse(req.body.images);
      images = [...(images || []), ...extra];
    }

    const variants = req.body.variants
      ? (typeof req.body.variants === "string" ? JSON.parse(req.body.variants) : req.body.variants)
      : undefined;

    const tags = req.body.tags
      ? (typeof req.body.tags === "string" ? JSON.parse(req.body.tags) : req.body.tags)
      : undefined;

    const update = { ...req.body, updatedAt: Date.now() };
    if (images) update.images = images;
    if (variants) update.variants = variants;
    if (tags) update.tags = tags;

    const updated = await Products.update(req.params.id, update);
    res.json(updated);
  })
);

// DELETE /api/products/:id — admin only
router.delete(
  "/:id",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    await Products.delete(req.params.id);
    res.json({ id: req.params.id, deleted: true });
  })
);

// PATCH /api/products/:id/availability — admin: toggle availability / stock status
router.patch(
  "/:id/availability",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const { availability, isAvailableToday } = req.body;
    const update = { updatedAt: Date.now() };
    if (availability) update.availability = availability;
    if (typeof isAvailableToday === "boolean") update.isAvailableToday = isAvailableToday;
    const updated = await Products.update(req.params.id, update);
    res.json(updated);
  })
);

module.exports = router;
