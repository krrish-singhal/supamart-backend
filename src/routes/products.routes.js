const express = require("express");
const multer = require("multer");
const { asyncHandler } = require("../middleware/error");
const { authenticate, requireRole } = require("../middleware/auth");
const { Products } = require("../models");
const { ROLES, COLLECTIONS, AVAILABILITY } = require("../config/constants");
const { upload: uploadToCloud } = require("../services/storageService");
const { notifyUser } = require("../services/notificationService");
const { db } = require("../config/firebase");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function isPurchasable(product) {
  return Boolean(
    product &&
    product.availability === AVAILABILITY.AVAILABLE &&
    product.isAvailableToday !== false &&
    (product.variants || []).some((variant) =>
      (!variant.availability || variant.availability === AVAILABILITY.AVAILABLE) && Number(variant.stock) > 0
    )
  );
}

async function notifyRestockSubscribers(previous, updated) {
  if (isPurchasable(previous) || !isPurchasable(updated)) return;
  try {
    const subscriptions = await db()
      .collection("restockSubscriptions")
      .where("productId", "==", updated.id)
      .get();
    await Promise.all(subscriptions.docs.map(async (subscription) => {
      const { userId } = subscription.data();
      if (userId) {
        await notifyUser(userId, "Back in stock", `${updated.name} is available again.`, {
          type: "RESTOCK",
          productId: updated.id,
        });
      }
      await subscription.ref.delete();
    }));
  } catch (err) {
    // Inventory updates must still succeed if a restock alert cannot be delivered.
    console.error("Failed to deliver restock alerts", err);
  }
}

// GET /api/products — paginated; filter by categoryId, availability, featured, trending
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { categoryId, brandId, availability, featured, trending, bestseller, monthlyStockUp, limit = 20, cursor } = req.query;
    const where = [];
    try {
      if (categoryId) {
        const catSnap = await db().collection(COLLECTIONS.CATEGORIES).get();
        const allCats = catSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
        const targetIds = [categoryId];
        // Include every descendant so products assigned to nested admin categories
        // also appear when a customer opens their parent category.
        for (let index = 0; index < targetIds.length; index += 1) {
          allCats
            .filter((category) => category.parentId === targetIds[index])
            .forEach((category) => {
              if (!targetIds.includes(category.id)) targetIds.push(category.id);
            });
        }
        if (targetIds.length === 1) {
          where.push(["categoryId", "==", categoryId]);
        } else {
          where.push(["categoryId", "in", targetIds.slice(0, 30)]);
        }
      }
      if (brandId) where.push(["brandId", "==", brandId]);
      if (availability) where.push(["availability", "==", availability]);
      if (featured === "true") where.push(["isFeatured", "==", true]);
      if (trending === "true") where.push(["isTrending", "==", true]);
      if (bestseller === "true") where.push(["isBestseller", "==", true]);
      if (monthlyStockUp === "true") where.push(["isMonthlyStockUp", "==", true]);

      const result = await Products.paginate({
        where,
        orderBy: { field: "createdAt", dir: "desc" },
        limit: Math.min(Number(limit), 50),
        startAfter: cursor || null,
      });
      res.json(result);
    } catch (err) {
      if (err.code === 8 || err.message?.includes("Quota exceeded")) {
        console.warn("Firestore quota exceeded in GET /api/products");
        return res.json({ items: [], total: 0, cursor: null });
      }
      throw err;
    }
  })
);

// In-memory products cache for fast, case-insensitive, multi-field search
let cachedProducts = null;
let lastCacheTime = 0;
let inFlightSearchPromise = null;
const CACHE_TTL_MS = 60 * 1000;

async function getSearchableProducts() {
  const now = Date.now();
  if (cachedProducts && now - lastCacheTime < CACHE_TTL_MS) {
    return cachedProducts;
  }
  if (inFlightSearchPromise) {
    return inFlightSearchPromise;
  }

  inFlightSearchPromise = (async () => {
    try {
      const [prodSnap, catSnap, brandSnap] = await Promise.all([
        db().collection(COLLECTIONS.PRODUCTS).get(),
        db().collection(COLLECTIONS.CATEGORIES).get(),
        db().collection(COLLECTIONS.BRANDS).get(),
      ]);

      const catMap = new Map();
      catSnap.docs.forEach((d) => catMap.set(d.id, { id: d.id, ...d.data() }));

      const brandMap = new Map();
      brandSnap.docs.forEach((d) => brandMap.set(d.id, { id: d.id, ...d.data() }));

      cachedProducts = prodSnap.docs.map((d) => {
        const data = d.data();
        const cat = data.categoryId ? catMap.get(data.categoryId) : null;
        const parentCat = cat?.parentId ? catMap.get(cat.parentId) : null;
        const brand = data.brandId ? brandMap.get(data.brandId) : null;

        return {
          id: d.id,
          ...data,
          categoryName: cat?.name || data.categoryName || data.category || "",
          parentCategoryName: parentCat?.name || "",
          brandName: brand?.name || data.brandName || data.brand || "",
        };
      });

      lastCacheTime = Date.now();
      return cachedProducts;
    } finally {
      inFlightSearchPromise = null;
    }
  })();

  return inFlightSearchPromise;
}

function invalidateProductsCache() {
  cachedProducts = null;
  lastCacheTime = 0;
  inFlightSearchPromise = null;
}

function stem(word) {
  if (!word || word.length <= 3) return word;
  const w = word.toLowerCase();
  if (w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.endsWith("toes")) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && w !== "gas") {
    return w.slice(0, -1);
  }
  return w;
}

function getTermAliases(term) {
  const t = stem(term);
  const aliases = new Set([term, t]);

  if (["atta", "flour", "maida", "rava", "wheat"].includes(t)) {
    ["atta", "flour", "maida", "rava", "wheat", "starch", "puttu podi", "appam podi", "chakki"].forEach((a) => aliases.add(a));
  }
  if (["milk", "dairy", "curd", "butter", "paneer"].includes(t)) {
    ["milk", "milma", "dairy", "butter", "paneer", "curd"].forEach((a) => aliases.add(a));
  }
  if (["oil", "ghee"].includes(t)) {
    ["oil", "ghee", "coconut", "palm", "gingelly", "sesame", "sunflower", "rice bran"].forEach((a) => aliases.add(a));
  }
  if (["rice"].includes(t)) {
    ["rice", "ponni", "kaima", "doppi", "pachari", "urutty", "jaya", "surekha", "matta"].forEach((a) => aliases.add(a));
  }
  if (["sugar", "salt", "jaggery", "sarkara"].includes(t)) {
    ["sugar", "salt", "sarkara", "jaggery", "sweetener"].forEach((a) => aliases.add(a));
  }
  if (["dal", "pulse", "dhall", "paruppu", "gram", "peas", "kadala"].includes(t)) {
    ["dal", "pulse", "dhall", "paruppu", "masoor", "chana", "urad", "toor", "moong", "kadala", "benny", "peas"].forEach((a) => aliases.add(a));
  }
  if (["tea", "chai"].includes(t)) {
    ["tea", "chai", "taaza", "red label", "taj mahal", "lipton", "3 roses"].forEach((a) => aliases.add(a));
  }
  if (["coffee"].includes(t)) {
    ["coffee", "bru", "nescafe", "sunrise"].forEach((a) => aliases.add(a));
  }
  if (["soap", "bath"].includes(t)) {
    ["soap", "bathing", "liril", "lifebuoy", "lux", "dove", "cinthol", "pears", "dettol", "body wash"].forEach((a) => aliases.add(a));
  }
  if (["detergent", "wash", "cleaner", "cleaning"].includes(t)) {
    ["detergent", "surf excel", "ariel", "tide", "wheel", "rin", "washing", "powder", "bar", "liquid", "dishwash", "vim", "bleach"].forEach((a) => aliases.add(a));
  }
  if (["biscuit", "cookie", "snack", "chip", "crisp", "rusk", "bakery", "bread", "cake", "toast", "brownie"].includes(t)) {
    ["biscuit", "cookie", "rusk", "snack", "chip", "crisp", "lays", "good day", "50-50", "bourbon", "marie", "parle", "chocochip", "crunch", "bakery", "bread", "cake", "toast", "bakes", "bun", "croissant", "brownie", "golden bakery"].forEach((a) => aliases.add(a));
  }
  if (["vegetable", "veggie"].includes(t)) {
    ["vegetable", "veggie", "potato", "onion", "tomato", "carrot", "beans", "brinjal", "chilli", "cucumber", "ginger"].forEach((a) => aliases.add(a));
  }
  if (["fruit"].includes(t)) {
    ["fruit", "mango", "lemon", "gooseberry", "banana", "apple", "orange"].forEach((a) => aliases.add(a));
  }
  if (["spice", "masala"].includes(t)) {
    ["spice", "masala", "chilli", "coriander", "turmeric", "pepper", "jeera", "cumin", "garam masala", "powder"].forEach((a) => aliases.add(a));
  }
  if (["potato"].includes(t)) {
    ["potato", "aloo", "urulaikizhangu"].forEach((a) => aliases.add(a));
  }
  if (["onion"].includes(t)) {
    ["onion", "savala", "vengayam"].forEach((a) => aliases.add(a));
  }

  return Array.from(aliases);
}

// GET /api/products/search — fast, case-insensitive, multi-field search with category & synonym support
router.get(
  "/search",
  asyncHandler(async (req, res) => {
    const { q, limit = 30 } = req.query;
    if (!q || !q.trim() || q.trim().length < 1) return res.json({ items: [] });

    const rawTerm = q.trim().toLowerCase();
    const allProducts = await getSearchableProducts();

    const hasConjunction = /[&/+,]|\b(?:and|or)\b/i.test(rawTerm);
    const segments = rawTerm.split(/[&/+,]|\b(?:and|or)\b/i).map((s) => (s || "").trim()).filter(Boolean);
    const stopWords = new Set(["&", "and", "or", "in", "of", "the", "a", "an", "to", "for", "with"]);
    const words = rawTerm.replace(/[&/+,._-]/g, " ").split(/\s+/).filter((w) => w && (rawTerm.length <= 2 || !stopWords.has(w)));

    const scored = [];

    for (const prod of allProducts) {
      const name = (prod.name || "").toLowerCase();
      const catName = (prod.categoryName || "").toLowerCase();
      const parentCatName = (prod.parentCategoryName || "").toLowerCase();
      const brand = (prod.brandName || "").toLowerCase();
      const tags = (Array.isArray(prod.tags) ? prod.tags : []).join(" ").toLowerCase();
      const desc = (prod.description || "").toLowerCase();

      let score = 0;

      if (hasConjunction) {
        let matchedAnySegment = false;
        for (const seg of segments) {
          const segClean = seg.replace(/[&/+,._-]/g, " ").trim();
          const segStem = stem(segClean);
          const aliases = getTermAliases(segClean);

          const inName = aliases.some((a) => name.includes(a)) || name.includes(segStem);
          const inCat = aliases.some((a) => catName.includes(a)) || catName.includes(segStem);
          const inBrand = aliases.some((a) => brand.includes(a));
          const inTags = aliases.some((a) => tags.includes(a) || desc.includes(a));
          const inParent = !parentCatName && catName.includes(segStem);

          if (inName || inCat || inBrand || inTags || inParent) {
            matchedAnySegment = true;
            score += 50;
            if (inCat) score += 50;
            if (inName) score += 40;
            if (inBrand) score += 20;
          }
        }
        if (!matchedAnySegment) continue;
      } else {
        const fullText = `${name} ${catName} ${parentCatName} ${brand} ${tags} ${desc}`;
        let matchedWordCount = 0;
        for (const word of words) {
          const wordStem = stem(word);
          const aliases = getTermAliases(word);

          const wordMatches =
            aliases.some((a) => fullText.includes(a)) ||
            fullText.includes(word) ||
            fullText.includes(wordStem);

          if (wordMatches) {
            matchedWordCount++;
            score += 20;
            if (name.includes(word) || name.includes(wordStem)) score += 35;
            if (catName.includes(word) || catName.includes(wordStem)) score += 25;
            if (parentCatName.includes(word) || parentCatName.includes(wordStem)) score += 15;
            if (brand.includes(word)) score += 25;
          }
        }

        if (matchedWordCount === 0) continue;
        if (words.length > 1 && matchedWordCount === words.length) {
          score += 80;
        } else if (words.length > 1 && matchedWordCount < words.length) {
          score -= 20;
        }

        if (name === rawTerm) score += 100;
        else if (name.startsWith(rawTerm)) score += 60;
        else if (name.includes(rawTerm)) score += 40;
      }

      scored.push({ score, product: prod });
    }

    scored.sort((a, b) => b.score - a.score);
    const items = scored.slice(0, Math.max(1, Math.min(200, Number(limit) || 30))).map((s) => s.product);

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
    invalidateProductsCache();
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

    const { images: _submittedImages, ...fields } = req.body;
    const update = { ...fields, updatedAt: Date.now() };
    // An empty list from older admin forms means "no image change", not "remove all
    // images". Preserve the existing URLs when a product only has a bundled fallback.
    if (images && images.length > 0) update.images = images;
    if (variants) update.variants = variants;
    if (tags) update.tags = tags;

    const previous = await Products.findById(req.params.id);
    const updated = await Products.update(req.params.id, update);
    await notifyRestockSubscribers(previous, updated);
    invalidateProductsCache();
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
    invalidateProductsCache();
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
    const previous = await Products.findById(req.params.id);
    const updated = await Products.update(req.params.id, update);
    await notifyRestockSubscribers(previous, updated);
    invalidateProductsCache();
    res.json(updated);
  })
);

module.exports = router;
