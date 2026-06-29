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
    };
  });
  return { items, subtotal: Number(subtotal.toFixed(2)) };
}

function computeDiscount(offer, subtotal, items, products) {
  if (!offer || !offer.isActive) return 0;
  const now = Date.now();
  if (now < offer.validFrom || now > offer.validTo) return 0;
  if (subtotal < offer.minValue) return 0;

  // determine eligible base depending on scope
  let base = subtotal;
  if (offer.scope === OFFER_SCOPE.CATEGORY || offer.scope === OFFER_SCOPE.PRODUCT) {
    base = items.reduce((sum, it) => {
      const product = products.get(it.productId);
      const match =
        offer.scope === OFFER_SCOPE.PRODUCT
          ? it.productId === offer.scopeId
          : product && product.categoryId === offer.scopeId;
      return match ? sum + it.price * it.qty : sum;
    }, 0);
  }

  let discount = offer.kind === OFFER_KIND.PERCENT ? (base * offer.value) / 100 : offer.value;
  if (offer.maxDiscount != null) discount = Math.min(discount, offer.maxDiscount);
  return Number(Math.min(discount, subtotal).toFixed(2));
}

function applyTax(amount, taxPercent) {
  return Number(((amount * taxPercent) / 100).toFixed(2));
}

module.exports = { priceCart, computeDiscount, applyTax };
