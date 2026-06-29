const Joi = require("joi");
const {
  ORDER_STATUS,
  PAYMENT_METHOD,
  PAYMENT_STATUS,
  OFFER_KIND,
  OFFER_SCOPE,
} = require("../config/constants");

// carts/{uid}
const cartItemSchema = Joi.object({
  productId: Joi.string().required(),
  variantId: Joi.string().required(),
  qty: Joi.number().integer().min(1).required(),
});

const cartSchema = Joi.object({
  items: Joi.array().items(cartItemSchema).default([]),
  couponCode: Joi.string().allow("", null),
  updatedAt: Joi.number().required(),
});

// orders/{orderId}
const orderItemSchema = Joi.object({
  productId: Joi.string().required(),
  variantId: Joi.string().required(),
  name: Joi.string().required(),
  variantLabel: Joi.string().required(),
  qty: Joi.number().integer().min(1).required(),
  price: Joi.number().min(0).required(), // unit price charged
});

const addressSnapshotSchema = Joi.object({
  houseNo: Joi.string().required(),
  street: Joi.string().required(),
  landmark: Joi.string().allow("", null),
  pincode: Joi.string().required(),
  lat: Joi.number().required(),
  lng: Joi.number().required(),
});

const statusEventSchema = Joi.object({
  status: Joi.string().valid(...Object.values(ORDER_STATUS)).required(),
  at: Joi.number().required(),
});

const orderSchema = Joi.object({
  orderNo: Joi.number().integer().required(), // human friendly #1001
  userId: Joi.string().required(),
  items: Joi.array().items(orderItemSchema).min(1).required(),
  addressSnapshot: addressSnapshotSchema.required(),
  slot: Joi.object({ label: Joi.string().required(), from: Joi.string(), to: Joi.string() }).required(),
  notes: Joi.string().max(500).allow("", null),
  paymentMethod: Joi.string().valid(...Object.values(PAYMENT_METHOD)).required(),
  paymentStatus: Joi.string().valid(...Object.values(PAYMENT_STATUS)).default(PAYMENT_STATUS.PENDING),
  subtotal: Joi.number().min(0).required(),
  tax: Joi.number().min(0).default(0),
  deliveryCharge: Joi.number().min(0).default(0),
  discount: Joi.number().min(0).default(0),
  total: Joi.number().min(0).required(),
  distanceKm: Joi.number().min(0).required(),
  status: Joi.string().valid(...Object.values(ORDER_STATUS)).default(ORDER_STATUS.PLACED),
  statusHistory: Joi.array().items(statusEventSchema).default([]),
  assignedPartnerId: Joi.string().allow(null),
  createdAt: Joi.number().required(),
  updatedAt: Joi.number().required(),
});

// offers/{offerId}
const offerSchema = Joi.object({
  code: Joi.string().uppercase().required(),
  title: Joi.string().allow("", null),
  description: Joi.string().allow("", null),
  image: Joi.string().uri().allow("", null),
  kind: Joi.string().valid(...Object.values(OFFER_KIND)).required(),
  value: Joi.number().min(0).required(), // percent or flat amount
  scope: Joi.string().valid(...Object.values(OFFER_SCOPE)).required(),
  scopeId: Joi.string().allow(null), // categoryId / productId when scoped
  minValue: Joi.number().min(0).default(0),
  maxDiscount: Joi.number().min(0).allow(null),
  validFrom: Joi.number().required(),
  validTo: Joi.number().required(),
  isActive: Joi.boolean().default(true),
  createdAt: Joi.number().required(),
  updatedAt: Joi.number().required(),
});

// deliveryPartners/{uid}
const deliveryPartnerSchema = Joi.object({
  name: Joi.string().required(),
  mobile: Joi.string().pattern(/^[0-9]{10}$/).required(),
  isActive: Joi.boolean().default(true),
  fcmTokens: Joi.array().items(Joi.string()).default([]),
  currentOrders: Joi.array().items(Joi.string()).default([]),
  createdAt: Joi.number().required(),
});

module.exports = {
  cartItemSchema,
  cartSchema,
  orderItemSchema,
  orderSchema,
  offerSchema,
  deliveryPartnerSchema,
};
