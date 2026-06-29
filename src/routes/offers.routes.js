const express = require("express");
const { asyncHandler } = require("../middleware/error");
const { authenticate, requireRole } = require("../middleware/auth");
const { Offers } = require("../models");
const { ROLES, COLLECTIONS } = require("../config/constants");
const { db } = require("../config/firebase");
const multer = require("multer");
const { upload: uploadToCloud } = require("../services/storageService");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// GET /api/offers — admin: all offers paginated
router.get(
  "/",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const result = await Offers.paginate({
      orderBy: { field: "createdAt", dir: "desc" },
      limit: Number(req.query.limit) || 20,
      startAfter: req.query.cursor || null,
    });
    res.json(result);
  })
);

// GET /api/offers/active — public: list currently active offers
router.get(
  "/active",
  asyncHandler(async (req, res) => {
    const now = Date.now();
    const snap = await db()
      .collection(COLLECTIONS.OFFERS)
      .where("isActive", "==", true)
      .where("validTo", ">=", now)
      .get();
    const items = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((o) => o.validFrom <= now);
    res.json({ items });
  })
);

// POST /api/offers/validate — customer: validate a coupon code and return discount details
router.post(
  "/validate",
  authenticate,
  asyncHandler(async (req, res) => {
    const { code, subtotal, items } = req.body;
    if (!code) return res.status(422).json({ error: "coupon code required" });

    const snap = await db()
      .collection(COLLECTIONS.OFFERS)
      .where("code", "==", code.toUpperCase())
      .limit(1)
      .get();

    if (snap.empty || !snap.docs[0].data().isActive) {
      return res.status(422).json({ error: "Invalid or expired coupon" });
    }

    const offer = { id: snap.docs[0].id, ...snap.docs[0].data() };
    const now = Date.now();
    if (now < offer.validFrom || now > offer.validTo) {
      return res.status(422).json({ error: "Coupon has expired" });
    }
    if (subtotal < offer.minValue) {
      return res.status(422).json({
        error: `Minimum order value for this coupon is ₹${offer.minValue}`,
      });
    }

    const { computeDiscount } = require("../services/pricingService");
    // For validation we don't have full product maps — just return the offer details
    res.json({
      code: offer.code,
      kind: offer.kind,
      value: offer.value,
      scope: offer.scope,
      maxDiscount: offer.maxDiscount,
      minValue: offer.minValue,
    });
  })
);

// POST /api/offers — admin only
router.post(
  "/",
  authenticate,
  requireRole(ROLES.ADMIN),
  upload.single("image"),
  asyncHandler(async (req, res) => {
    let image = req.body.image || null;
    if (req.file) {
      const uploadRes = await uploadToCloud(req.file.buffer, "offers");
      image = uploadRes.url;
    }
    const offerData = { ...req.body };
    if (image) offerData.image = image;

    // Convert booleans and numbers properly
    offerData.isActive = req.body.isActive === 'true' || req.body.isActive === true;
    if (offerData.value) offerData.value = Number(offerData.value);
    if (offerData.maxDiscount) offerData.maxDiscount = Number(offerData.maxDiscount);
    else offerData.maxDiscount = null;
    
    if (offerData.minValue) offerData.minValue = Number(offerData.minValue);
    else offerData.minValue = 0;

    if (offerData.validFrom) offerData.validFrom = Number(offerData.validFrom);
    if (offerData.validTo) offerData.validTo = Number(offerData.validTo);
    offerData.createdAt = Date.now();
    offerData.updatedAt = Date.now();

    const offer = await Offers.create(null, offerData);
    res.status(201).json(offer);
  })
);

// PUT /api/offers/:id — admin only
router.put(
  "/:id",
  authenticate,
  requireRole(ROLES.ADMIN),
  upload.single("image"),
  asyncHandler(async (req, res) => {
    let image = req.body.image;
    if (req.file) {
      const uploadRes = await uploadToCloud(req.file.buffer, "offers");
      image = uploadRes.url;
    }
    const updateData = { ...req.body };
    if (image !== undefined) updateData.image = image;

    if (req.body.isActive !== undefined) {
      updateData.isActive = req.body.isActive === 'true' || req.body.isActive === true;
    }
    if (updateData.value) updateData.value = Number(updateData.value);
    if (updateData.maxDiscount !== undefined) {
      if (updateData.maxDiscount) updateData.maxDiscount = Number(updateData.maxDiscount);
      else updateData.maxDiscount = null;
    }
    if (updateData.minValue !== undefined) {
      if (updateData.minValue) updateData.minValue = Number(updateData.minValue);
      else updateData.minValue = 0;
    }
    if (updateData.validFrom) updateData.validFrom = Number(updateData.validFrom);
    if (updateData.validTo) updateData.validTo = Number(updateData.validTo);

    const updated = await Offers.update(req.params.id, updateData);
    res.json(updated);
  })
);

// DELETE /api/offers/:id — admin only
router.delete(
  "/:id",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    await Offers.delete(req.params.id);
    res.json({ id: req.params.id, deleted: true });
  })
);

module.exports = router;
