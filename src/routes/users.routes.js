const express = require("express");
const multer = require("multer");
const { asyncHandler } = require("../middleware/error");
const { authenticate, requireRole } = require("../middleware/auth");
const { Users } = require("../models");
const { ROLES } = require("../config/constants");
const { upload: uploadToCloud } = require("../services/storageService");
const { publicUser } = require("../utils/publicUser");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// GET /api/users/:uid — admin can get any user; user can get their own
router.get(
  "/:uid",
  authenticate,
  asyncHandler(async (req, res) => {
    if (req.user.uid !== req.params.uid && req.user.role !== ROLES.ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const user = await Users.findById(req.params.uid);
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(publicUser(user));
  })
);

// PUT /api/users/:uid — update profile fields
router.put(
  "/:uid",
  authenticate,
  asyncHandler(async (req, res) => {
    if (req.user.uid !== req.params.uid && req.user.role !== ROLES.ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const allowed = ["name", "mobile", "defaultAddressId", "gender", "dateOfBirth", "profileImage"];
    const update = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );
    const updated = await Users.update(req.params.uid, { ...update, updatedAt: Date.now() });
    res.json(publicUser(updated));
  })
);

// PATCH /api/users/:uid/avatar — upload profile photo to Cloudinary
router.patch(
  "/:uid/avatar",
  authenticate,
  upload.single("avatar"),
  asyncHandler(async (req, res) => {
    if (req.user.uid !== req.params.uid && req.user.role !== ROLES.ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (!req.file) return res.status(422).json({ error: "No image file provided" });
    const { url } = await uploadToCloud(req.file.buffer, "avatars");
    const updated = await Users.update(req.params.uid, { profileImage: url, updatedAt: Date.now() });
    res.json(publicUser(updated));
  })
);

// PATCH /api/users/:uid/favorites — toggle a product in/out of the user's favorites
router.patch(
  "/:uid/favorites",
  authenticate,
  asyncHandler(async (req, res) => {
    if (req.user.uid !== req.params.uid && req.user.role !== ROLES.ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const { productId, action } = req.body;
    if (!productId || !["add", "remove"].includes(action)) {
      return res.status(422).json({ error: "productId and action ('add'|'remove') are required" });
    }
    const user = await Users.findById(req.params.uid);
    if (!user) return res.status(404).json({ error: "User not found" });
    const current = user.favoriteProductIds || [];
    const favoriteProductIds =
      action === "add"
        ? Array.from(new Set([...current, productId]))
        : current.filter((id) => id !== productId);
    const updated = await Users.update(req.params.uid, { favoriteProductIds, updatedAt: Date.now() });
    res.json({ favoriteProductIds: updated.favoriteProductIds });
  })
);

// GET /api/users — admin: list all users (paginated)
router.get(
  "/",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const result = await Users.paginate({
      orderBy: { field: "createdAt", dir: "desc" },
      limit: Number(req.query.limit) || 20,
      startAfter: req.query.cursor || null,
    });
    res.json({ ...result, items: result.items.map(publicUser) });
  })
);

module.exports = router;
