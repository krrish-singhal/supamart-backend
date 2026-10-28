const express = require("express");
const multer = require("multer");
const { asyncHandler } = require("../middleware/error");
const { authenticate, requireRole } = require("../middleware/auth");
const { Banners } = require("../models");
const { ROLES, COLLECTIONS } = require("../config/constants");
const { upload: uploadToCloud } = require("../services/storageService");
const { db } = require("../config/firebase");
const { invalidateReadsCache } = require("./reads.routes");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// In-memory cache for active banners
let cache = null;
let cacheAt = 0;
const CACHE_TTL_MS = 30 * 1000; // 30 seconds
function invalidateCache() {
  cache = null;
  cacheAt = 0;
  try {
    invalidateReadsCache("banners");
  } catch (_e) {}
}

const CANONICAL_BANNERS = [
  {
    id: "canonical-farm-fresh",
    label: "Farm fresh",
    title: "Vegetables picked this morning",
    subtitle: "Starting at just ₹9",
    target: "Home",
    targetType: "Home",
    destination: "categories",
    background: "#E4F2E9",
    text: "#121712",
    secondary: "#3B5145",
    button: "#0A7C47",
    buttonText: "Shop now",
    buttonTextColor: "#FFFFFF",
    mode: "composite",
    order: 0,
    isActive: true,
    image: "https://res.cloudinary.com/dutkczsbx/image/upload/v1793132306/banners/bteamttrme9ml4jnogxh.png",
  },
  {
    id: "canonical-monthly-ration",
    label: "Monthly ration",
    title: "Wholesale prices, home delivered",
    subtitle: "Up to 20% off atta, rice & oil",
    target: "Home",
    targetType: "Home",
    destination: "offers",
    background: "#0A7C47",
    text: "#FFFFFF",
    secondary: "#D1FAE5",
    button: "#FFFFFF",
    buttonText: "Shop now",
    buttonTextColor: "#0A7C47",
    mode: "composite",
    order: 1,
    isActive: true,
    image: "https://res.cloudinary.com/dutkczsbx/image/upload/v1793132312/banners/nyskwtfc5ntynxjlk1kn.png",
  },
  {
    id: "canonical-tea-time",
    label: "Tea time",
    title: "Tea, biscuits & snacks",
    subtitle: "Buy 2, get 10% extra off",
    target: "Home",
    targetType: "Home",
    destination: "categories",
    background: "#1E2B23",
    text: "#FFFFFF",
    secondary: "#CBD5E1",
    button: "#FFFFFF",
    buttonText: "Shop now",
    buttonTextColor: "#0A7C47",
    mode: "composite",
    order: 2,
    isActive: true,
    image: "https://res.cloudinary.com/dutkczsbx/image/upload/v1793132318/banners/ytspnwwljgmzwglejvgw.png",
  },
];

// GET /api/banners — public/admin, cached for public, ordered with graceful fallback
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const includeAll = req.query.all === "true";
    if (!includeAll && cache && Date.now() - cacheAt < CACHE_TTL_MS) {
      return res.json({ items: cache });
    }

    try {
      let queryRef = db().collection(COLLECTIONS.BANNERS);
      if (!includeAll) {
        queryRef = queryRef.where("isActive", "==", true);
      }
      const snap = await queryRef.get();
      const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const sanitizedItems = items.map((item) => {
        if (typeof item.image === "string" && item.image.startsWith("data:")) {
          const canonical = CANONICAL_BANNERS.find(
            (c) => c.label?.toLowerCase() === item.label?.toLowerCase()
          );
          return canonical ? { ...item, image: canonical.image } : item;
        }
        return item;
      });
      const finalItems = sanitizedItems.length >= 3 ? sanitizedItems : CANONICAL_BANNERS;
      if (!includeAll && finalItems.length > 0) {
        cache = finalItems;
        cacheAt = Date.now();
      }
      res.json({ items: finalItems });
    } catch (err) {
      console.warn("Firestore banners query fallback:", err?.message || err);
      if (cache && cache.length > 0) {
        return res.json({ items: cache });
      }
      res.json({ items: CANONICAL_BANNERS });
    }
  })
);

// POST /api/banners — admin only
router.post(
  "/",
  authenticate,
  requireRole(ROLES.ADMIN),
  upload.single("image"),
  asyncHandler(async (req, res) => {
    let imageUrl = req.body.image || "";
    if (req.file) {
      const result = await uploadToCloud(req.file.buffer, "banners");
      imageUrl = result.url;
    }

    const bannerPayload = {
      image: imageUrl,
      target: req.body.target || req.body.targetType || "Home",
      targetType: req.body.targetType || "Home",
      targetId: req.body.targetId || null,
      title: req.body.title || null,
      subtitle: req.body.subtitle || null,
      label: req.body.label || null,
      destination: req.body.destination || (req.body.target ? req.body.target.toLowerCase() : "categories"),
      order: req.body.order !== undefined && req.body.order !== null && req.body.order !== "" ? Number(req.body.order) : 0,
      isActive: req.body.isActive !== false && req.body.isActive !== "false",
      createdAt: Date.now(),
    };

    if (req.body.background) bannerPayload.background = req.body.background;
    if (req.body.text) bannerPayload.text = req.body.text;
    if (req.body.secondary) bannerPayload.secondary = req.body.secondary;
    if (req.body.button) bannerPayload.button = req.body.button;
    if (req.body.buttonText) bannerPayload.buttonText = req.body.buttonText;
    if (req.body.buttonTextColor) bannerPayload.buttonTextColor = req.body.buttonTextColor;
    if (req.body.mode) bannerPayload.mode = req.body.mode;
    if (req.body.type) bannerPayload.type = req.body.type;
    if (req.body.sideImage) bannerPayload.sideImage = req.body.sideImage;

    const banner = await Banners.create(null, bannerPayload);
    invalidateCache();
    res.status(201).json(banner);
  })
);

// PUT /api/banners/:id — admin only
router.put(
  "/:id",
  authenticate,
  requireRole(ROLES.ADMIN),
  upload.single("image"),
  asyncHandler(async (req, res) => {
    let update = { ...req.body };
    if (req.file) {
      const result = await uploadToCloud(req.file.buffer, "banners");
      update.image = result.url;
    }
    if (update.order !== undefined && update.order !== null && update.order !== "") {
      update.order = Number(update.order);
    }
    if (update.isActive !== undefined) {
      update.isActive = update.isActive === true || update.isActive === "true";
    }
    const updated = await Banners.update(req.params.id, update);
    invalidateCache();
    res.json(updated);
  })
);

// DELETE /api/banners/:id — admin only
router.delete(
  "/:id",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    await Banners.delete(req.params.id);
    invalidateCache();
    res.json({ id: req.params.id, deleted: true });
  })
);

module.exports = router;
