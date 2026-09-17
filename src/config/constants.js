// Centralized enums & collection names — import these everywhere, never inline strings.

const COLLECTIONS = {
  USERS: "users",
  ADDRESSES: "addresses", // subcollection under users/{uid}
  CATEGORIES: "categories",
  PRODUCTS: "products",
  BANNERS: "banners",
  OFFERS: "offers",
  CARTS: "carts",
  ORDERS: "orders",
  DELIVERY_PARTNERS: "deliveryPartners",
  CONFIG: "config",
  METRICS: "metrics",
  BRANDS: "brands",
};

// Collapsed to a 4-step flow (+ CANCELLED, always reachable) for a one-shop/one-rider
// operation — PACKING and READY_FOR_DELIVERY used to sit between ACCEPTED and
// OUT_FOR_DELIVERY, but with a single shop and a single rider those were two extra
// manual clicks that never carried distinct real-world information. If PACKING/READY
// values still exist on old order docs (pre-migration), see
// backend/src/jobs/collapsePackingReadyStatus.js.
const ORDER_STATUS = {
  PLACED: "ORDER_PLACED",
  ACCEPTED: "ORDER_ACCEPTED",
  OUT_FOR_DELIVERY: "OUT_FOR_DELIVERY",
  PENDING_CONFIRMATION: "PENDING_CONFIRMATION",
  DELIVERY_DISPUTED: "DELIVERY_DISPUTED",
  DELIVERED: "DELIVERED",
  CANCELLED: "CANCELLED",
};

const ORDER_STATUS_FLOW = [
  ORDER_STATUS.PLACED,
  ORDER_STATUS.ACCEPTED,
  ORDER_STATUS.OUT_FOR_DELIVERY,
  ORDER_STATUS.PENDING_CONFIRMATION,
  ORDER_STATUS.DELIVERED,
];

// UPI_MANUAL = shop UPI ID / QR / GPay deep-link, confirmed manually by the shop (no gateway).
// RAZORPAY is reserved for a future gateway integration; no provider is wired for it yet.
const PAYMENT_METHOD = { COD: "COD", UPI_MANUAL: "UPI_MANUAL", RAZORPAY: "RAZORPAY" };
// AWAITING_CONFIRMATION = customer tapped "I've Paid"; shop/admin still needs to verify and mark PAID.
const PAYMENT_STATUS = { PENDING: "PENDING", AWAITING_CONFIRMATION: "AWAITING_CONFIRMATION", PAID: "PAID", FAILED: "FAILED" };

const AVAILABILITY = {
  AVAILABLE: "AVAILABLE",
  UNAVAILABLE_TODAY: "UNAVAILABLE_TODAY",
  OUT_OF_STOCK: "OUT_OF_STOCK",
};

const STOCK_LEVEL = { IN_STOCK: "IN_STOCK", LOW_STOCK: "LOW_STOCK", OUT_OF_STOCK: "OUT_OF_STOCK" };
const LOW_STOCK_THRESHOLD = 10;

// Orders with a cart subtotal at or above this get free delivery (Blinkit/Instamart-style).
const FREE_DELIVERY_THRESHOLD = 2500;

// Reasons an admin can give when rejecting a manually-claimed UPI payment.
const PAYMENT_REJECTION_REASON = {
  NOT_RECEIVED: "AMOUNT_NOT_RECEIVED",
  INCORRECT_AMOUNT: "AMOUNT_INCORRECT",
  OTHER: "OTHER",
};

const OFFER_KIND = { PERCENT: "PERCENT", FLAT: "FLAT" };
const OFFER_SCOPE = { CART: "CART", CATEGORY: "CATEGORY", PRODUCT: "PRODUCT" };

const ROLES = { CUSTOMER: "CUSTOMER", ADMIN: "ADMIN", PARTNER: "PARTNER" };

module.exports = {
  COLLECTIONS,
  ORDER_STATUS,
  ORDER_STATUS_FLOW,
  PAYMENT_METHOD,
  PAYMENT_STATUS,
  AVAILABILITY,
  STOCK_LEVEL,
  LOW_STOCK_THRESHOLD,
  FREE_DELIVERY_THRESHOLD,
  PAYMENT_REJECTION_REASON,
  OFFER_KIND,
  OFFER_SCOPE,
  ROLES,
};
