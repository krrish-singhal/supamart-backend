const express = require("express");
const { asyncHandler } = require("../middleware/error");
const { authenticate, optionalAuthenticate, requireRole } = require("../middleware/auth");
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

// GET /api/offers/active — public: list currently active offers (annotated with user usage if logged in)
router.get(
  "/active",
  optionalAuthenticate,
  asyncHandler(async (req, res) => {
    const now = Date.now();
    const snap = await db()
      .collection(COLLECTIONS.OFFERS)
      .where("isActive", "==", true)
      .get();

    let usedCouponsSet = new Set();
    if (req.user && req.user.uid) {
      const { getUserUsedCoupons } = require("../services/couponService");
      usedCouponsSet = await getUserUsedCoupons(req.user.uid);
    }

    const items = snap.docs
      .map((d) => {
        const data = d.data();
        const code = (data.code || "").toUpperCase();
        const isUsed = usedCouponsSet.has(code);
        return {
          id: d.id,
          ...data,
          code,
          isUsed,
          alreadyUsed: isUsed,
        };
      })
      .filter((o) => {
        if (o.isActive === false) return false;
        if (o.validFrom && now < o.validFrom) return false;
        if (o.validTo && now > o.validTo) return false;
        return true;
      });

    // Priority order matching reference design, then sortOrder, then newest
    const priority = ["WELCOME50", "MSCLUB10", "FRESH20", "BULK100"];
    items.sort((a, b) => {
      const orderA = a.sortOrder != null ? a.sortOrder : (priority.indexOf(a.code) !== -1 ? priority.indexOf(a.code) + 1 : 999);
      const orderB = b.sortOrder != null ? b.sortOrder : (priority.indexOf(b.code) !== -1 ? priority.indexOf(b.code) + 1 : 999);
      if (orderA !== orderB) return orderA - orderB;
      const createdA = Number(a.createdAt || 0);
      const createdB = Number(b.createdAt || 0);
      if (createdA !== createdB) return createdB - createdA;
      return (Number(b.value) || 0) - (Number(a.value) || 0);
    });

    res.json({ items, usedCoupons: Array.from(usedCouponsSet) });
  })
);

// POST /api/offers/validate — customer: validate a coupon code and return discount details
router.post(
  "/validate",
  optionalAuthenticate,
  asyncHandler(async (req, res) => {
    const { code, subtotal, items } = req.body;
    if (!code) return res.status(422).json({ error: "coupon code required" });
    const cleanCode = String(code).trim().toUpperCase();

    // Check if user has already used this coupon
    if (req.user && req.user.uid) {
      const { hasUserUsedCoupon } = require("../services/couponService");
      const alreadyUsed = await hasUserUsedCoupon(req.user.uid, cleanCode);
      if (alreadyUsed) {
        return res.status(422).json({
          error: "You have already used this coupon code. Each coupon can only be used once.",
          code: "COUPON_ALREADY_USED",
        });
      }
    }

    const snap = await db()
      .collection(COLLECTIONS.OFFERS)
      .where("code", "==", cleanCode)
      .limit(1)
      .get();

    if (snap.empty || snap.docs[0].data().isActive === false) {
      return res.status(422).json({ error: "Invalid or expired coupon" });
    }

    const offer = { id: snap.docs[0].id, ...snap.docs[0].data() };
    const now = Date.now();
    if (offer.validFrom && now < offer.validFrom) {
      return res.status(422).json({ error: "Coupon is not yet active" });
    }
    if (offer.validTo && now > offer.validTo) {
      return res.status(422).json({ error: "Coupon has expired" });
    }
    if (offer.minValue && subtotal < offer.minValue) {
      return res.status(422).json({
        error: `Minimum order value for this coupon is ₹${offer.minValue}`,
      });
    }

    const { computeDiscount } = require("../services/pricingService");
    
    let productMap = new Map();
    if (items && items.length > 0) {
      const productRefs = [...new Set(items.map(i => i.productId).filter(Boolean))].map(id => db().collection(COLLECTIONS.PRODUCTS).doc(id));
      const productSnaps = await Promise.all(productRefs.map(r => r.get()));
      productSnaps.forEach(s => {
        if (s.exists) productMap.set(s.id, { id: s.id, ...s.data() });
      });
    }

    const discount = computeDiscount(offer, subtotal, items || [], productMap);
    if (discount <= 0) {
      return res.status(422).json({ error: "Coupon is not applicable to any items in your cart." });
    }

    res.json({
      id: offer.id,
      code: offer.code,
      title: offer.title || '',
      description: offer.description || '',
      tag: offer.tag || null,
      tagColor: offer.tagColor || null,
      sortOrder: offer.sortOrder || null,
      kind: offer.kind,
      value: offer.value,
      scope: offer.scope,
      scopeId: offer.scopeId || null,
      maxDiscount: offer.maxDiscount,
      minValue: offer.minValue || 0,
      evaluatedDiscount: discount
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
    if (offerData.code) offerData.code = String(offerData.code).trim().toUpperCase();

    // Convert booleans and numbers properly
    offerData.isActive = req.body.isActive === 'true' || req.body.isActive === true;
    if (offerData.value) offerData.value = Number(offerData.value);
    if (offerData.maxDiscount) offerData.maxDiscount = Number(offerData.maxDiscount);
    else offerData.maxDiscount = null;
    
    if (offerData.minValue) offerData.minValue = Number(offerData.minValue);
    else offerData.minValue = 0;

    if (offerData.sortOrder !== undefined) {
      offerData.sortOrder = offerData.sortOrder != null && offerData.sortOrder !== '' ? Number(offerData.sortOrder) : null;
    }
    if (offerData.tag !== undefined) {
      offerData.tag = offerData.tag ? String(offerData.tag).trim().toUpperCase() : null;
    }
    if (offerData.tagColor !== undefined) {
      offerData.tagColor = offerData.tagColor ? String(offerData.tagColor).trim() : null;
    }

    if (offerData.validFrom) offerData.validFrom = Number(offerData.validFrom);
    if (offerData.validTo) offerData.validTo = Number(offerData.validTo);
    if (offerData.scope === "CART" || !offerData.scopeId) {
      offerData.scopeId = null;
    }
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
    if (updateData.code) updateData.code = String(updateData.code).trim().toUpperCase();

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
    if (updateData.sortOrder !== undefined) {
      updateData.sortOrder = updateData.sortOrder != null && updateData.sortOrder !== '' ? Number(updateData.sortOrder) : null;
    }
    if (updateData.tag !== undefined) {
      updateData.tag = updateData.tag ? String(updateData.tag).trim().toUpperCase() : null;
    }
    if (updateData.tagColor !== undefined) {
      updateData.tagColor = updateData.tagColor ? String(updateData.tagColor).trim() : null;
    }
    if (updateData.validFrom) updateData.validFrom = Number(updateData.validFrom);
    if (updateData.validTo) updateData.validTo = Number(updateData.validTo);
    if (updateData.scope === "CART" || !updateData.scopeId) {
      updateData.scopeId = null;
    }
    updateData.updatedAt = Date.now();

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
