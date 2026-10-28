const { db } = require("../config/firebase");
const { COLLECTIONS } = require("../config/constants");

// Cache storage
let cachedProducts = null;
let cachedCategories = null;
let cachedBrands = null;
let lastCacheTime = 0;
let inFlightCatalogPromise = null;

// 30 minutes TTL; invalidated immediately on any catalog or order mutation
const CATALOG_CACHE_TTL_MS = 30 * 60 * 1000;

async function getCatalog(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedProducts && (now - lastCacheTime < CATALOG_CACHE_TTL_MS)) {
    return {
      products: cachedProducts,
      categories: cachedCategories,
      brands: cachedBrands,
    };
  }

  if (inFlightCatalogPromise) {
    return inFlightCatalogPromise;
  }

  inFlightCatalogPromise = (async () => {
    try {
      const [prodSnap, catSnap, brandSnap] = await Promise.all([
        db().collection(COLLECTIONS.PRODUCTS).get(),
        db().collection(COLLECTIONS.CATEGORIES).get(),
        db().collection(COLLECTIONS.BRANDS).get(),
      ]);

      const catMap = new Map();
      const categories = catSnap.docs.map((d) => {
        const cat = { id: d.id, ...d.data() };
        catMap.set(d.id, cat);
        return cat;
      });

      const brandMap = new Map();
      const brands = brandSnap.docs.map((d) => {
        const brand = { id: d.id, ...d.data() };
        brandMap.set(d.id, brand);
        return brand;
      });

      const products = prodSnap.docs.map((d) => {
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

      cachedProducts = products;
      cachedCategories = categories;
      cachedBrands = brands;
      lastCacheTime = Date.now();

      return { products, categories, brands };
    } finally {
      inFlightCatalogPromise = null;
    }
  })();

  return inFlightCatalogPromise;
}

async function getCachedProducts(forceRefresh = false) {
  const { products } = await getCatalog(forceRefresh);
  return products;
}

async function getCachedCategories(forceRefresh = false) {
  const { categories } = await getCatalog(forceRefresh);
  return categories;
}

async function getCachedBrands(forceRefresh = false) {
  const { brands } = await getCatalog(forceRefresh);
  return brands;
}

async function getLowStockProducts(threshold = 10) {
  const { products } = await getCatalog();
  const low = [];
  products.forEach((p) => {
    const lowVariants = (p.variants || []).filter((v) => Number(v.stock) <= threshold);
    const isTopStockLow = p.stock !== undefined && Number(p.stock) <= threshold;
    if (lowVariants.length || isTopStockLow) {
      low.push({
        ...p,
        lowVariants: lowVariants.length ? lowVariants : [{ id: "default", stock: p.stock || 0 }],
      });
    }
  });
  return low;
}

function updateProductInCatalogCache(productId, updates = {}) {
  if (!cachedProducts) return;
  const index = cachedProducts.findIndex((p) => p.id === productId);
  if (index !== -1) {
    cachedProducts[index] = { ...cachedProducts[index], ...updates };
  }
}

function invalidateCatalogCache() {
  cachedProducts = null;
  cachedCategories = null;
  cachedBrands = null;
  lastCacheTime = 0;
  inFlightCatalogPromise = null;
}

module.exports = {
  getCatalog,
  getCachedProducts,
  getCachedCategories,
  getCachedBrands,
  getLowStockProducts,
  updateProductInCatalogCache,
  invalidateCatalogCache,
  CATALOG_CACHE_TTL_MS,
};
