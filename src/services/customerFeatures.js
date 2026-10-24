const Joi = require('joi');
const listSchema = Joi.object({
  name: Joi.string().trim().min(1).max(80).required(),
  items: Joi.array().items(Joi.object({
    productId: Joi.string().max(200).pattern(/^[^/]+$/).required(),
    variantId: Joi.string().max(200).required(),
    qty: Joi.number().integer().min(1).max(999).required(),
  })).min(1).max(200).required(),
});
const ratingSchema = Joi.object({
  orderRating: Joi.number().integer().min(1).max(5).required(),
  review: Joi.string().trim().max(500).allow('').default(''),
  deliveryFeedback: Joi.string().valid('up', 'down').allow(null).default(null),
  productRatings: Joi.array().items(Joi.object({ productId: Joi.string().max(200).required(), rating: Joi.number().integer().min(1).max(5).required() })).max(200).default([]),
});
function validate(schema, input) {
  const { error, value } = schema.validate(input, { abortEarly: false, convert: false });
  if (error) throw Object.assign(new Error(error.details.map(d => d.message).join('; ')), { statusCode: 422 });
  return value;
}
function validateOrderRatings(order, userId, input) {
  if (!order) throw Object.assign(new Error('Order not found'), { statusCode: 404 });
  if (order.userId !== userId) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
  if (order.status !== 'DELIVERED') throw Object.assign(new Error('You can rate an order after delivery'), { statusCode: 409 });
  const value = validate(ratingSchema, input);
  const purchased = new Set(order.items.map(item => item.productId));
  const ids = value.productRatings.map(item => item.productId);
  if (new Set(ids).size !== ids.length || ids.some(id => !purchased.has(id))) {
    throw Object.assign(new Error('Rate each purchased product only once'), { statusCode: 422 });
  }
  return value;
}
function boughtProducts(orders) {
  const products = new Map();
  for (const order of [...orders].sort((a,b) => (b.createdAt || 0) - (a.createdAt || 0))) {
    if (order.status === 'CANCELLED' || order.status === 'PAYMENT_FAILED') continue;
    for (const item of order.items || []) {
      const key = `${item.productId}:${item.variantId}`;
      if (!products.has(key)) {
        products.set(key, {
          productId: item.productId,
          variantId: item.variantId,
          name: item.name || item.productName || '',
          variantLabel: item.variantLabel || '',
          images: item.images || (item.image ? [item.image] : []),
          categoryName: item.categoryName || item.category || '',
          purchaseCount: 1,
          lastPurchasedAt: order.createdAt || null,
          lastPrice: item.price ?? item.unitPrice ?? null,
        });
      } else {
        const existing = products.get(key);
        existing.purchaseCount = (existing.purchaseCount || 1) + 1;
      }
    }
  }
  return [...products.values()];
}
module.exports = { listSchema, ratingSchema, validate, validateOrderRatings, boughtProducts };
