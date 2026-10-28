const { OFFER_KIND, OFFER_SCOPE } = require("../config/constants");

// Re-prices the cart on the server so the client can never tamper with totals.
// products: Map<productId, productDoc>
function priceCart(cartItems, products) {
  let subtotal = 0;
  const items = cartItems.map((ci) => {
    const product = products.get(ci.productId);
    if (!product) {
      const e = new Error(`Product ${ci.productId} not found`);
      e.statusCode = 422;
      throw e;
    }
    const variant = product.variants.find((v) => v.id === ci.variantId);
    if (!variant) {
      const e = new Error(`Variant ${ci.variantId} not found`);
      e.statusCode = 422;
      throw e;
    }
    if (variant.stock < ci.qty) {
      const e = new Error(`Insufficient stock for ${product.name}`);
      e.statusCode = 409;
      throw e;
    }
    const unit = variant.offerPrice != null ? variant.offerPrice : variant.price;
    subtotal += unit * ci.qty;
    return {
      productId: ci.productId,
      variantId: ci.variantId,
      name: product.name,
      variantLabel: variant.label,
      qty: ci.qty,
      price: unit,
      images: product.images || [],
      image: (product.images && product.images[0]) || "",
      availability: product.availability || "AVAILABLE",
      isAvailableToday: product.isAvailableToday !== false,
      variantAvailability: variant.availability || "AVAILABLE",
      stock: variant.stock,
    };
  });
  return { items, subtotal: Number(subtotal.toFixed(2)) };
}

function computeDiscount(offer, subtotal, items, products) {
  if (!offer || offer.isActive === false) return 0;
  const now = Date.now();
  if ((offer.validFrom && now < offer.validFrom) || (offer.validTo && now > offer.validTo)) return 0;
  if (offer.minValue && subtotal < offer.minValue) return 0;

  // determine eligible base depending on scope
  let base = subtotal;
  if (offer.scope === OFFER_SCOPE.CATEGORY || offer.scope === OFFER_SCOPE.PRODUCT) {
    base = (items || []).reduce((sum, it) => {
      const product = products?.get ? products.get(it.productId) : null;
      const match =
        offer.scope === OFFER_SCOPE.PRODUCT
          ? it.productId === offer.scopeId
          : product && product.categoryId === offer.scopeId;
      const unitPrice = Number(it.price ?? it.unitPrice ?? product?.variants?.find(v => v.id === it.variantId)?.price ?? 0);
      const qty = Number(it.qty) || 1;
      return match ? sum + unitPrice * qty : sum;
    }, 0);
  }

  let discount = 0;
  
  if (offer.scope === OFFER_SCOPE.CATEGORY || offer.scope === OFFER_SCOPE.PRODUCT) {
    if (base <= 0) return 0; // No matching items for this scoped offer
  }

  discount = offer.kind === OFFER_KIND.PERCENT ? (base * offer.value) / 100 : offer.value;
  if (offer.maxDiscount != null && Number(offer.maxDiscount) > 0) {
    discount = Math.min(discount, Number(offer.maxDiscount));
  }
  return Number(Math.min(discount, subtotal).toFixed(2));
}

function applyTax(amount, taxPercent) {
  return Number(((amount * taxPercent) / 100).toFixed(2));
}

module.exports = { priceCart, computeDiscount, applyTax };
