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

// PATCH /api/notifications/mark-all-read — customer marks their own notification
// inbox read. Firestore rules deny ALL client writes to users/{uid}/notifications
// (`allow write: if false` — see backend/firebase/firestore.rules) so the client
// can never do this write directly; this Admin-SDK route is the only way it happens.
router.patch(
  "/mark-all-read",
  authenticate,
  asyncHandler(async (req, res) => {
    const uid = req.user.uid;
    const unreadSnap = await db()
      .collection(COLLECTIONS.USERS)
      .doc(uid)
      .collection("notifications")
      .where("read", "==", false)
      .get();

    if (unreadSnap.empty) return res.json({ updated: 0 });

    // Firestore batch cap is 500 ops.
    const chunks = [];
    for (let i = 0; i < unreadSnap.docs.length; i += 450) chunks.push(unreadSnap.docs.slice(i, i + 450));
    for (const chunk of chunks) {
      const batch = db().batch();
      chunk.forEach((doc) => batch.update(doc.ref, { read: true }));
      await batch.commit();
    }

    res.json({ updated: unreadSnap.size });
  })
);

module.exports = router;
