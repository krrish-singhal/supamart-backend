const express = require("express");
const { asyncHandler } = require("../middleware/error");
const { authenticate } = require("../middleware/auth");
const { Carts, Products } = require("../models");
const { db } = require("../config/firebase");
const { COLLECTIONS } = require("../config/constants");
const { priceCart, computeDiscount } = require("../services/pricingService");

const router = express.Router();

// GET /api/cart — get current user's cart with server-repriced totals
router.get(
  "/",
  authenticate,
  asyncHandler(async (req, res) => {
    const cart = await Carts.findById(req.user.uid);
    if (!cart || !cart.items.length) {
      return res.json({ items: [], subtotal: 0, discount: 0, total: 0 });
    }

    // Load products for repricing
    const productIds = [...new Set(cart.items.map((i) => i.productId))];
    const productDocs = await Promise.all(productIds.map((id) => Products.findById(id)));
    const productMap = new Map(
      productDocs.filter(Boolean).map((p) => [p.id, p])
    );

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
      const snap = await db()
        .collection(COLLECTIONS.OFFERS)
        .where("code", "==", cart.couponCode)
        .limit(1)
        .get();
      const offer = snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
      discount = computeDiscount(offer, subtotal, pricedItems, productMap);
      if (offer) {
        couponDetails = {
          kind: offer.kind,
          value: offer.value
        };
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

    await db().collection(COLLECTIONS.CARTS).doc(req.user.uid).set(
      { items, couponCode: couponCode || null, updatedAt: now },
      { merge: false }
    );
    res.json({ ok: true, itemCount: items.length });
  })
);

// PATCH /api/cart/coupon — apply or remove a coupon code
router.patch(
  "/coupon",
  authenticate,
  asyncHandler(async (req, res) => {
    const { code } = req.body; // null or empty to remove
    const now = Date.now();
    await db()
      .collection(COLLECTIONS.CARTS)
      .doc(req.user.uid)
      .set({ couponCode: code || null, updatedAt: now }, { merge: true });
    res.json({ couponCode: code || null });
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
