const express = require("express");
const { asyncHandler } = require("../middleware/error");
const { authenticate } = require("../middleware/auth");
const { Carts, Products } = require("../models");
const { db } = require("../config/firebase");
const { priceCart, computeDiscount } = require("../services/pricingService");
const { COLLECTIONS, AVAILABILITY } = require("../config/constants");
const { getCachedProducts } = require("../services/catalogCache");

const router = express.Router();

async function resolveProductMap(productIds) {
  const cached = await getCachedProducts().catch(() => []);
  const cachedMap = new Map((cached || []).map((p) => [p.id, p]));
  const docs = await Promise.all(
    productIds.map(async (id) => {
      if (cachedMap.has(id)) return cachedMap.get(id);
      return Products.findById(id);
    })
  );
  return new Map(docs.filter(Boolean).map((p) => [p.id, p]));
}

// GET /api/cart — get current user's cart with server-repriced totals
router.get(
  "/",
  authenticate,
  asyncHandler(async (req, res) => {
    const cart = await Carts.findById(req.user.uid);
    if (!cart || !cart.items.length) {
      return res.json({ items: [], subtotal: 0, discount: 0, total: 0 });
    }

    // Load products for repricing (leverages in-memory catalog to eliminate Firestore reads)
    const productIds = [...new Set(cart.items.map((i) => i.productId))];
    const productMap = await resolveProductMap(productIds);

    // Items whose product was deleted entirely (e.g. a catalog reseed) can never be
    // priced — drop them and persist the cleanup so the cart self-heals instead of
    // permanently 500-ing (or falling back to unpriced raw items the client can't render).
    const staleItems = cart.items.filter((i) => !productMap.has(i.productId));
    const liveItems = cart.items.filter((i) => productMap.has(i.productId));
    if (staleItems.length > 0) {
      await db().collection(COLLECTIONS.CARTS).doc(req.user.uid).set(
        { items: liveItems, updatedAt: Date.now() },
        { merge: true }
      );
    }

    if (!liveItems.length) {
      return res.json({ items: [], subtotal: 0, discount: 0, total: 0, removedCount: staleItems.length });
    }

    let pricedItems, subtotal;
    try {
      ({ items: pricedItems, subtotal } = priceCart(liveItems, productMap));
    } catch {
      // A remaining item has a stock/variant problem (not a missing product, already
      // handled above) — fail closed rather than show prices we can't stand behind.
      return res.json({ items: [], subtotal: 0, discount: 0, total: 0, removedCount: staleItems.length });
    }

    let discount = 0;
    let couponDetails = null;
    if (cart.couponCode) {
      const cleanCode = String(cart.couponCode).trim().toUpperCase();
      const { hasUserUsedCoupon } = require("../services/couponService");
      const alreadyUsed = await hasUserUsedCoupon(req.user.uid, cleanCode);
      if (alreadyUsed) {
        // Clear used coupon from user cart (self-heal)
        await db().collection(COLLECTIONS.CARTS).doc(req.user.uid).set(
          { couponCode: null, updatedAt: Date.now() },
          { merge: true }
        );
        cart.couponCode = null;
      } else {
        const snap = await db()
          .collection(COLLECTIONS.OFFERS)
          .where("code", "==", cleanCode)
          .limit(1)
          .get();
        const offer = snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
        const now = Date.now();
        const isOfferActive = offer && offer.isActive !== false &&
          (!offer.validFrom || now >= offer.validFrom) &&
          (!offer.validTo || now <= offer.validTo);

        if (!isOfferActive || (offer && offer.minValue && subtotal < offer.minValue)) {
          await db().collection(COLLECTIONS.CARTS).doc(req.user.uid).set(
            { couponCode: null, updatedAt: Date.now() },
            { merge: true }
          );
          cart.couponCode = null;
          couponDetails = null;
          discount = 0;
        } else {
          discount = computeDiscount(offer, subtotal, pricedItems, productMap);
          if (offer) {
            couponDetails = {
              code: offer.code,
              kind: offer.kind,
              value: offer.value,
              minValue: offer.minValue || 0,
              maxDiscount: offer.maxDiscount || null,
            };
          }
        }
      }
    }

    res.json({
      items: pricedItems,
      couponCode: cart.couponCode || null,
      couponDetails,
      subtotal,
      discount,
      total: Number((subtotal - discount).toFixed(2)),
      removedCount: staleItems.length,
    });
  })
);

// PUT /api/cart — replace the entire cart items list
router.put(
  "/",
  authenticate,
  asyncHandler(async (req, res) => {
    const { items } = req.body;
    if (!Array.isArray(items)) {
      const e = new Error("items must be an array");
      e.statusCode = 422;
      throw e;
    }
    const now = Date.now();
    const existing = await Carts.findById(req.user.uid);
    const couponCode = existing ? existing.couponCode : null;

    // Only block new quantities for unavailable items. Customers must still be
    // able to reduce or remove an item that became unavailable after being added.
    const existingQtyByKey = new Map(
      (existing?.items || []).map((item) => [`${item.productId}:${item.variantId}`, Number(item.qty) || 0])
    );
    for (const item of items) {
      const key = `${item.productId}:${item.variantId || "default"}`;
      const previousQty = existingQtyByKey.get(key) || 0;
      const requestedQty = Number(item.qty);
      if (requestedQty <= previousQty) continue;

      const product = (await resolveProductMap([item.productId])).get(item.productId);
      const variant = product?.variants?.find((candidate) => candidate.id === (item.variantId || "default"));
      const unavailable =
        !product ||
        product.availability !== AVAILABILITY.AVAILABLE ||
        product.isAvailableToday === false ||
        !variant ||
        (variant.availability && variant.availability !== AVAILABILITY.AVAILABLE) ||
        Number(variant.stock) < requestedQty;
      if (unavailable) {
        const error = new Error(`${product?.name || "This item"} is unavailable or has insufficient stock`);
        error.statusCode = 409;
        throw error;
      }
    }

    let finalCouponCode = couponCode;
    if (finalCouponCode && items.length > 0) {
      try {
        const productIds = [...new Set(items.map((i) => i.productId))];
        const productMap = await resolveProductMap(productIds);
        const { subtotal } = priceCart(items, productMap);
        const snap = await db()
          .collection(COLLECTIONS.OFFERS)
          .where("code", "==", finalCouponCode)
          .limit(1)
          .get();
        if (!snap.empty) {
          const offer = snap.docs[0].data();
          if (offer.minValue && subtotal < offer.minValue) {
            finalCouponCode = null;
          }
        }
      } catch (_) {}
    } else if (items.length === 0) {
      finalCouponCode = null;
    }

    await db().collection(COLLECTIONS.CARTS).doc(req.user.uid).set(
      { items, couponCode: finalCouponCode || null, updatedAt: now },
      { merge: false }
    );
    res.json({ ok: true, itemCount: items.length, couponCode: finalCouponCode });
  })
);

// PATCH /api/cart/coupon — apply or remove a coupon code
router.patch(
  "/coupon",
  authenticate,
  asyncHandler(async (req, res) => {
    const { code } = req.body;
    const now = Date.now();
    const cleanCode = code ? String(code).trim().toUpperCase() : null;

    if (cleanCode) {
      const { hasUserUsedCoupon } = require("../services/couponService");
      const alreadyUsed = await hasUserUsedCoupon(req.user.uid, cleanCode);
      if (alreadyUsed) {
        return res.status(422).json({
          error: "You have already used this coupon code. Each coupon can only be used once.",
          code: "COUPON_ALREADY_USED",
        });
      }

      const snap = await db()
        .collection(COLLECTIONS.OFFERS)
        .where("code", "==", cleanCode)
        .limit(1)
        .get();
      if (snap.empty || snap.docs[0].data().isActive === false) {
        return res.status(422).json({ error: "Invalid or expired coupon" });
      }
      const offerData = snap.docs[0].data();
      if (offerData.validFrom && now < offerData.validFrom) {
        return res.status(422).json({ error: "Coupon is not yet active" });
      }
      if (offerData.validTo && now > offerData.validTo) {
        return res.status(422).json({ error: "Coupon has expired" });
      }
    }

    await db()
      .collection(COLLECTIONS.CARTS)
      .doc(req.user.uid)
      .set({ couponCode: cleanCode, updatedAt: now }, { merge: true });
    res.json({ couponCode: cleanCode });
  })
);

// DELETE /api/cart — clear the cart
router.delete(
  "/",
  authenticate,
  asyncHandler(async (req, res) => {
    await db()
      .collection(COLLECTIONS.CARTS)
      .doc(req.user.uid)
      .set({ items: [], couponCode: null, updatedAt: Date.now() });
    res.json({ ok: true });
  })
);

module.exports = router;
