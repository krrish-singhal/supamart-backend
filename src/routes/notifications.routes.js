const express = require("express");
const { asyncHandler } = require("../middleware/error");
const { authenticate } = require("../middleware/auth");
const { db } = require("../config/firebase");
const { COLLECTIONS } = require("../config/constants");
const { Products } = require("../models");

const router = express.Router();

// POST /api/notifications/restock-subscriptions — save a customer's request for
// an alert when an unavailable product becomes purchasable again.
router.post(
  "/restock-subscriptions",
  authenticate,
  asyncHandler(async (req, res) => {
    const { productId } = req.body;
    if (typeof productId !== "string" || !productId.trim()) {
      return res.status(422).json({ error: "productId is required" });
    }

    const product = await Products.findById(productId);
    if (!product) return res.status(404).json({ error: "Product not found" });
    const available = product.availability === "AVAILABLE" && product.isAvailableToday !== false &&
      (product.variants || []).some((variant) => (!variant.availability || variant.availability === "AVAILABLE") && Number(variant.stock) > 0);
    if (available) return res.status(409).json({ error: "This product is already available" });

    const ref = db().collection("restockSubscriptions").doc(`${req.user.uid}_${productId}`);
    const existing = await ref.get();
    await ref.set({
      userId: req.user.uid,
      productId,
      productName: product.name,
      createdAt: existing.exists ? existing.data().createdAt : Date.now(),
    });
    res.status(existing.exists ? 200 : 201).json({ subscribed: true, alreadySubscribed: existing.exists });
  })
);

// PATCH /api/notifications/mark-all-read — customer marks their own notification inbox read
router.patch(
  "/mark-all-read",
  authenticate,
  asyncHandler(async (req, res) => {
    const uid = req.user.uid;
    const snap = await db()
      .collection(COLLECTIONS.USERS)
      .doc(uid)
      .collection("notifications")
      .get();

    const unreadDocs = snap.docs.filter((d) => !d.data().read);
    if (unreadDocs.length === 0) return res.json({ updated: 0 });

    const now = Date.now();
    const chunks = [];
    for (let i = 0; i < unreadDocs.length; i += 450) {
      chunks.push(unreadDocs.slice(i, i + 450));
    }
    for (const chunk of chunks) {
      const batch = db().batch();
      chunk.forEach((doc) => batch.update(doc.ref, { read: true, readAt: now }));
      await batch.commit();
    }

    try {
      const { invalidateReadsCache } = require("./reads.routes");
      invalidateReadsCache(`users/${uid}/notifications`);
    } catch (_) {}

    res.json({ updated: unreadDocs.length });
  })
);

// PATCH /api/notifications/:id/read — customer marks a single notification read
router.patch(
  "/:id/read",
  authenticate,
  asyncHandler(async (req, res) => {
    const uid = req.user.uid;
    const notifId = req.params.id;
    const docRef = db()
      .collection(COLLECTIONS.USERS)
      .doc(uid)
      .collection("notifications")
      .doc(notifId);

    const docSnap = await docRef.get();
    if (!docSnap.exists) {
      return res.status(404).json({ error: "Notification not found" });
    }

    await docRef.update({ read: true, readAt: Date.now() });

    try {
      const { invalidateReadsCache } = require("./reads.routes");
      invalidateReadsCache(`users/${uid}/notifications`);
    } catch (_) {}

    res.json({ success: true, id: notifId });
  })
);

module.exports = router;
