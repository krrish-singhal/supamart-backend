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
  lat: Joi.number().min(-90).max(90).required(),
  lng: Joi.number().min(-180).max(180).required(),
});

const statusEventSchema = Joi.object({
  status: Joi.string().valid(...Object.values(ORDER_STATUS), "PACKING", "PENDING", "READY_FOR_DELIVERY").required(),
  at: Joi.number().required(),
});

const orderSchema = Joi.object({
  orderNo: Joi.number().integer().required(), // human friendly #1001
  userId: Joi.string().required(),
  userName: Joi.string().allow("", null),
  userEmail: Joi.string().allow("", null),
  userPhone: Joi.string().allow("", null),
  items: Joi.array().items(orderItemSchema).min(1).required(),
  addressSnapshot: addressSnapshotSchema.required(),
  // Historical orders can keep their old slot; new on-demand orders omit it.
  slot: Joi.object({ label: Joi.string().required(), from: Joi.string().allow(""), to: Joi.string().allow("") }).allow(null).optional(),
  deliveryMode: Joi.string().valid("ON_DEMAND"),
  notes: Joi.string().max(500).allow("", null),
  paymentMethod: Joi.string().valid(...Object.values(PAYMENT_METHOD)).required(),
  paymentStatus: Joi.string().valid(...Object.values(PAYMENT_STATUS)).default(PAYMENT_STATUS.PENDING),
  subtotal: Joi.number().min(0).required(),
  tax: Joi.number().min(0).default(0),
  deliveryCharge: Joi.number().min(0).default(0),
  discount: Joi.number().min(0).default(0),
  total: Joi.number().min(0).required(),
  distanceKm: Joi.number().min(0).required(),
  status: Joi.string().valid(...Object.values(ORDER_STATUS), "PACKING", "PENDING", "READY_FOR_DELIVERY").default(ORDER_STATUS.PLACED),
  statusHistory: Joi.array().items(statusEventSchema).default([]),
  paymentRejectionReason: Joi.string().allow("", null),
  // Customer-only "remove from my order history" — never shown to admin/partner, and
  // never actually deletes the order doc (it's still a real business/accounting record).
  hiddenFromUser: Joi.boolean().default(false),
  assignedPartnerId: Joi.string().allow("", null),
  deliveryPartner: Joi.object({
    id: Joi.string().allow("", null),
    name: Joi.string().allow("", null),
    phone: Joi.string().allow("", null),
    mobile: Joi.string().allow("", null),
  }).unknown(true).allow(null),
  deliveryBoyName: Joi.string().allow("", null),
  deliveryBoyPhone: Joi.string().allow("", null),
  partnerLocation: Joi.object({
    lat: Joi.number().allow(null),
    lng: Joi.number().allow(null),
    updatedAt: Joi.number().allow(null),
  }).unknown(true).allow(null),
  estimatedDeliveryAt: Joi.number(),
  ratings: Joi.object({
    orderRating: Joi.number().integer().min(1).max(5),
    review: Joi.string().allow(""),
    deliveryFeedback: Joi.string().valid("up", "down").allow(null),
    productRatings: Joi.array().items(Joi.object({ productId: Joi.string(), rating: Joi.number().integer().min(1).max(5) })),
    ratedAt: Joi.number(),
  }),
  deliveryInstructions: Joi.any().allow(null),
  deliveryRating: Joi.number().min(1).max(5).allow(null),
  deliveryReview: Joi.string().allow("", null),
  deliveryAcceptanceStatus: Joi.string().valid("PENDING", "ACCEPTED", "REJECTED").allow(null),
  delayReason: Joi.string().allow("", null),
  delayReportedAt: Joi.number().allow(null),
  deliveryDelay: Joi.object({
    newEstimatedTime: Joi.any().allow(null),
    delayReason: Joi.string().allow("", null),
    reportedAt: Joi.number().allow(null),
  }).unknown(true).allow(null),
  lastSyncedAt: Joi.number().allow(null),
  confirmedAt: Joi.number().allow(null),
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
  name: Joi.string().allow("", null).optional(),
  email: Joi.string().email().allow("", null).optional(),
  mobile: Joi.string().allow("", null).optional(),
  isActive: Joi.boolean().default(true),
  isOnDuty: Joi.boolean().default(true),
  dutyStatus: Joi.string().allow("", null),
  fcmTokens: Joi.array().items(Joi.string()).default([]),
  currentOrders: Joi.array().items(Joi.string()).default([]),
  currentLocation: Joi.object({
    lat: Joi.number().required(),
    lng: Joi.number().required(),
    updatedAt: Joi.number().required(),
  }).allow(null).default(null),
  lastSyncedAt: Joi.number().allow(null),
  updatedAt: Joi.number().allow(null),
  createdAt: Joi.number().allow(null).optional(),
});

module.exports = {
  cartItemSchema,
  cartSchema,
  orderItemSchema,
  orderSchema,
  offerSchema,
  deliveryPartnerSchema,
};
