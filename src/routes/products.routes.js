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

// Use unified in-memory catalog cache for hierarchy expansion (0 Firestore reads on cache hits)
const {
  getCatalog,
  getCachedProducts,
  getCachedCategories,
  invalidateCatalogCache,
} = require("../services/catalogCache");

async function getCategoryTree() {
  return getCachedCategories();
}

// In-memory cache for default home screen products (unfiltered first page)
let defaultProductsCache = null;
let defaultProductsCacheTime = 0;
const DEFAULT_PRODUCTS_TTL = 300_000; // 5 minutes

// GET /api/products — paginated; filter by categoryId, availability, featured, trending
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { categoryId, brandId, availability, featured, trending, bestseller, monthlyStockUp, limit = 20, cursor } = req.query;
    const isDefaultQuery = !categoryId && !brandId && !availability && !featured && !trending && !bestseller && !monthlyStockUp && !cursor && Number(limit) >= 20;

    if (isDefaultQuery && defaultProductsCache && Date.now() - defaultProductsCacheTime < DEFAULT_PRODUCTS_TTL) {
      return res.json(defaultProductsCache);
    }

    try {
      const allCached = await getCachedProducts();
      if (Array.isArray(allCached) && allCached.length > 0) {
        let filtered = [...allCached];

        if (categoryId) {
          const allCats = await getCategoryTree();
          const targetIds = [categoryId];
          for (let index = 0; index < targetIds.length; index += 1) {
            allCats
              .filter((category) => category.parentId === targetIds[index])
              .forEach((category) => {
                if (!targetIds.includes(category.id)) targetIds.push(category.id);
              });
          }
          const targetSet = new Set(targetIds);
          filtered = filtered.filter((p) => p.categoryId && targetSet.has(p.categoryId));
        }

        if (brandId) {
          filtered = filtered.filter((p) => p.brandId === brandId);
        }

        if (availability) {
          filtered = filtered.filter((p) => p.availability === availability);
        } else {
          filtered = filtered.filter(
            (p) => p.availability !== AVAILABILITY.UNAVAILABLE
          );
        }

        if (featured === "true") filtered = filtered.filter((p) => p.isFeatured === true);
        if (trending === "true") filtered = filtered.filter((p) => p.isTrending === true);
        if (bestseller === "true") filtered = filtered.filter((p) => p.isBestseller === true);
        if (monthlyStockUp === "true") filtered = filtered.filter((p) => p.isMonthlyStockUp === true);

        filtered.sort((a, b) => {
          const tA = typeof a.createdAt === 'number' ? a.createdAt : (a.createdAt?._seconds ? a.createdAt._seconds * 1000 : 0);
          const tB = typeof b.createdAt === 'number' ? b.createdAt : (b.createdAt?._seconds ? b.createdAt._seconds * 1000 : 0);
          return tB - tA;
        });

        const pageSize = Math.min(Number(limit) || 20, 100);
        let startIndex = 0;
        if (cursor) {
          const cursorIndex = filtered.findIndex((p) => p.id === cursor);
          if (cursorIndex !== -1) {
            startIndex = cursorIndex + 1;
          }
        }

        const pageItems = filtered.slice(startIndex, startIndex + pageSize);
        const nextCursor = (startIndex + pageSize < filtered.length) ? pageItems[pageItems.length - 1]?.id : null;

        const result = {
          items: pageItems,
          total: filtered.length,
          cursor: nextCursor,
        };

        if (isDefaultQuery) {
          defaultProductsCache = result;
          defaultProductsCacheTime = Date.now();
        }

        return res.json(result);
      }
    } catch (cacheErr) {
      console.warn("Cached products filter error, falling back to database query:", cacheErr.message);
    }

    const where = [];
    try {
      if (categoryId) {
        const allCats = await getCategoryTree();
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
        limit: Math.min(Number(limit), 100),
        startAfter: cursor || null,
      });

      if (!availability) {
        result.items = (result.items || []).filter(
          (p) => p.availability !== AVAILABILITY.UNAVAILABLE
        );
      }

      if (isDefaultQuery) {
        defaultProductsCache = result;
        defaultProductsCacheTime = Date.now();
      }

      res.json(result);
    } catch (err) {
      // Monthly stock-up is also queried directly by the customer app's live
      // Firestore listener. Keep the API's initial page working even when the
      // composite (monthly flag + createdAt) index has not finished deploying.
      if (monthlyStockUp === "true") {
        try {
          let query = db().collection(COLLECTIONS.PRODUCTS).where("isMonthlyStockUp", "==", true);
          if (brandId) query = query.where("brandId", "==", brandId);
          if (categoryId) query = query.where("categoryId", "==", categoryId);
          if (availability) query = query.where("availability", "==", availability);
          const snapshot = await query.limit(1000).get();
          let products = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
          if (!availability) products = products.filter((product) => product.availability !== AVAILABILITY.UNAVAILABLE);
          if (featured === "true") products = products.filter((product) => product.isFeatured === true);
          if (trending === "true") products = products.filter((product) => product.isTrending === true);
          if (bestseller === "true") products = products.filter((product) => product.isBestseller === true);
          products.sort((a, b) => {
            const createdAt = (value) => typeof value === "number" ? value : value?._seconds ? value._seconds * 1000 : 0;
            return createdAt(b.createdAt) - createdAt(a.createdAt);
          });
          const pageSize = Math.min(Number(limit) || 20, 100);
          const cursorIndex = cursor ? products.findIndex((product) => product.id === cursor) : -1;
          const startIndex = cursorIndex >= 0 ? cursorIndex + 1 : 0;
          const items = products.slice(startIndex, startIndex + pageSize);
          return res.json({
            items,
            total: products.length,
            cursor: startIndex + pageSize < products.length ? items[items.length - 1]?.id || null : null,
          });
        } catch (fallbackError) {
          console.error("Monthly stock-up product query failed:", fallbackError.message);
        }
      }
      if (err.code === 8 || err.message?.includes("Quota exceeded")) {
        console.warn("Firestore quota exceeded in GET /api/products");
        if (defaultProductsCache) return res.json(defaultProductsCache);
        return res.json({ items: [], total: 0, cursor: null });
      }
      throw err;
    }
  })
);

async function getSearchableProducts() {
  return getCachedProducts();
}

function invalidateProductsCache() {
  invalidateCatalogCache();
  defaultProductsCache = null;
  defaultProductsCacheTime = 0;
  try {
    const { invalidateReadsCache } = require("./reads.routes");
    invalidateReadsCache("products");
  } catch (_) {}
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
      if (prod.availability === AVAILABILITY.UNAVAILABLE) {
        continue;
      }
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
    try {
      const { invalidateReadsCache } = require("./reads.routes");
      invalidateReadsCache("products");
    } catch (_) {}
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
    try {
      const { invalidateLowStockCache } = require("./admin.routes");
      invalidateLowStockCache();
    } catch (_) {}
    try {
      const { invalidateReadsCache } = require("./reads.routes");
      invalidateReadsCache("products");
      invalidateReadsCache(req.params.id);
    } catch (_) {}

    if (variants && Array.isArray(variants)) {
      const thresh = Number(updated.lowStockThreshold) || 10;
      const lowVariants = variants.filter((v) => Number(v.stock) <= thresh);
      if (lowVariants.length > 0) {
        try {
          const { notifyAdminsLowStock } = require("../services/notificationService");
          const lowStockItems = lowVariants.map((v) => ({
            productId: updated.id,
            name: updated.name,
            variantId: v.id,
            variantLabel: v.label || v.size,
            stock: Number(v.stock),
            threshold: thresh,
            isOutOfStock: Number(v.stock) <= 0,
          }));
          notifyAdminsLowStock(lowStockItems).catch(() => {});
          const now = Date.now();
          for (const item of lowStockItems) {
            db().collection(COLLECTIONS.ADMIN_ALERTS || "adminAlerts").add({
              type: item.isOutOfStock ? "OUT_OF_STOCK" : "LOW_STOCK",
              productId: item.productId,
              productName: item.name,
              variantId: item.variantId,
              variantLabel: item.variantLabel,
              currentStock: Math.max(0, item.stock),
              threshold: item.threshold,
              isOutOfStock: item.isOutOfStock,
              createdAt: now,
              read: false,
            }).catch(() => {});
          }
        } catch (_) {}
      }
    }

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
    try {
      const { invalidateReadsCache } = require("./reads.routes");
      invalidateReadsCache("products");
      invalidateReadsCache(req.params.id);
    } catch (_) {}
    res.json({ id: req.params.id, deleted: true });
  })
);

// PATCH /api/products/:id/availability — admin: toggle availability / stock status
router.patch(
  "/:id/availability",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const {
      availability,
      isAvailableToday,
      onSale,
      isOnSale,
      showDiscountTag,
      offerPrice,
      discountPercent,
      variants,
    } = req.body;
    const update = { updatedAt: Date.now() };
    if (availability) update.availability = availability;
    if (typeof isAvailableToday === "boolean") update.isAvailableToday = isAvailableToday;
    if (typeof onSale === "boolean") update.onSale = onSale;
    if (typeof isOnSale === "boolean") update.isOnSale = isOnSale;
    if (typeof showDiscountTag === "boolean") update.showDiscountTag = showDiscountTag;
    if (offerPrice !== undefined) update.offerPrice = offerPrice;
    if (discountPercent !== undefined) update.discountPercent = discountPercent;
    if (variants) update.variants = variants;

    const previous = await Products.findById(req.params.id);
    const updated = await Products.update(req.params.id, update);
    await notifyRestockSubscribers(previous, updated);
    invalidateProductsCache();
    try {
      const { invalidateReadsCache } = require("./reads.routes");
      invalidateReadsCache("products");
      invalidateReadsCache(req.params.id);
    } catch (_) {}
    res.json(updated);
  })
);

router.invalidateProductsCache = invalidateProductsCache;
module.exports = router;
module.exports.invalidateProductsCache = invalidateProductsCache;
