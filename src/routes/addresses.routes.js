const express = require("express");
const { asyncHandler } = require("../middleware/error");
const { authenticate } = require("../middleware/auth");
const { db } = require("../config/firebase");
const { COLLECTIONS } = require("../config/constants");
const { addressSchema } = require("../schemas/user.schema");

const router = express.Router({ mergeParams: true }); // mergeParams to get :uid from parent

function addrCol(uid) {
  return db().collection(COLLECTIONS.USERS).doc(uid).collection("addresses");
}

// GET /api/users/:uid/addresses
router.get(
  "/",
  authenticate,
  asyncHandler(async (req, res) => {
    if (req.user.uid !== req.params.uid) return res.status(403).json({ error: "Forbidden" });
    const snap = await addrCol(req.params.uid).orderBy("createdAt", "asc").get();
    const addresses = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json({ items: addresses });
  })
);

// POST /api/users/:uid/addresses
router.post(
  "/",
  authenticate,
  asyncHandler(async (req, res) => {
    if (req.user.uid !== req.params.uid) return res.status(403).json({ error: "Forbidden" });
    const { error, value } = addressSchema.validate(
      { ...req.body, createdAt: Date.now() },
      { abortEarly: false }
    );
    if (error) {
      const e = new Error("Validation failed: " + error.details.map((d) => d.message).join("; "));
      e.statusCode = 422;
      throw e;
    }
    const ref = await addrCol(req.params.uid).add(value);
    res.status(201).json({ id: ref.id, ...value });
  })
);

// PUT /api/users/:uid/addresses/:addressId
router.put(
  "/:addressId",
  authenticate,
  asyncHandler(async (req, res) => {
    if (req.user.uid !== req.params.uid) return res.status(403).json({ error: "Forbidden" });
    const docRef = addrCol(req.params.uid).doc(req.params.addressId);
    const snap = await docRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Address not found" });
    const merged = { ...snap.data(), ...req.body };
    const { error, value } = addressSchema.validate(merged, { abortEarly: false });
    if (error) {
      const e = new Error("Validation failed: " + error.details.map((d) => d.message).join("; "));
      e.statusCode = 422;
      throw e;
    }
    await docRef.set(value, { merge: true });
    res.json({ id: req.params.addressId, ...value });
  })
);

// DELETE /api/users/:uid/addresses/:addressId
router.delete(
  "/:addressId",
  authenticate,
  asyncHandler(async (req, res) => {
    if (req.user.uid !== req.params.uid) return res.status(403).json({ error: "Forbidden" });
    await addrCol(req.params.uid).doc(req.params.addressId).delete();
    res.json({ id: req.params.addressId, deleted: true });
  })
);

// PATCH /api/users/:uid/addresses/:addressId/set-default
router.patch(
  "/:addressId/set-default",
  authenticate,
  asyncHandler(async (req, res) => {
    if (req.user.uid !== req.params.uid) return res.status(403).json({ error: "Forbidden" });
    const col = addrCol(req.params.uid);
    const snap = await col.get();
    const batch = db().batch();
    snap.docs.forEach((d) => {
      batch.update(d.ref, { isDefault: d.id === req.params.addressId });
    });
    await batch.commit();
    // Update user.defaultAddressId
    await db()
      .collection(COLLECTIONS.USERS)
      .doc(req.params.uid)
      .update({ defaultAddressId: req.params.addressId, updatedAt: Date.now() });
    res.json({ defaultAddressId: req.params.addressId });
  })
);

module.exports = router;
