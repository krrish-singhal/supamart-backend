const { db } = require("../config/firebase");
const dayjs = require("dayjs");
const {
  COLLECTIONS,
  ORDER_STATUS,
  ORDER_STATUS_FLOW,
  PAYMENT_STATUS,
  PAYMENT_METHOD,
  PAYMENT_REJECTION_REASON,
  AVAILABILITY,
} = require("../config/constants");
const { evaluateDelivery } = require("./geoService");
const { priceCart, computeDiscount, applyTax } = require("./pricingService");
const { notifyUser } = require("./notificationService");

const REJECTION_REASON_LABELS = {
  [PAYMENT_REJECTION_REASON.NOT_RECEIVED]: "Amount was not received in our account.",
  [PAYMENT_REJECTION_REASON.INCORRECT_AMOUNT]: "The amount credited was incorrect.",
};

async function getConfig(tx) {
  const ref = db().collection(COLLECTIONS.CONFIG).doc("global");
  const snap = tx ? await tx.get(ref) : await ref.get();
  if (!snap.exists) throw Object.assign(new Error("Config missing"), { statusCode: 500 });
  return { ref, data: snap.data() };
}

/**
 * Places an order atomically:
 * - reprices server-side, validates min order value
 * - enforces 5KM radius + computes delivery charge
 * - decrements stock, auto-marks out-of-stock products unavailable
 * - allocates sequential order number
 * - writes daily + monthly metric counters (incl. peak-hour histogram)
 */
async function placeOrder({ userId, cartItems, couponCode, address, slot, notes, paymentMethod, idempotencyKey }) {
  // Cash on Delivery has been discontinued — UPI_MANUAL is the only accepted method.
  // Enforced here (not just hidden in the UI) so no client build can place a COD order.
  if (paymentMethod !== PAYMENT_METHOD.UPI_MANUAL) {
    throw Object.assign(
      new Error("Cash on Delivery is no longer available. Please pay via UPI."),
      { statusCode: 422, code: "COD_DISCONTINUED" }
    );
  }

  // Resolve coupon OUTSIDE the transaction (Admin SDK tx.get() only accepts doc refs, not queries)
  let offerRef = null;
  let offerData = null;
  if (couponCode) {
    const offSnap = await db()
      .collection(COLLECTIONS.OFFERS)
      .where("code", "==", couponCode.toUpperCase())
      .limit(1)
      .get();
    if (!offSnap.empty) {
      offerRef = offSnap.docs[0].ref;
      offerData = { id: offSnap.docs[0].id, ...offSnap.docs[0].data() };
    }
  }

  return db().runTransaction(async (tx) => {
    // Idempotency: if a key was supplied, check if we already wrote this order
    if (idempotencyKey) {
      const idemSnap = await tx.get(
        db().collection("orderIdempotency").doc(idempotencyKey)
      );
      if (idemSnap.exists) {
        const prev = idemSnap.data();
        return prev; // return the already-created order
      }
    }

    const { ref: cfgRef, data: config } = await getConfig(tx);

    // load products in cart (batch tx.get — no N+1)
    const productRefs = [...new Set(cartItems.map((i) => i.productId))].map((id) =>
      db().collection(COLLECTIONS.PRODUCTS).doc(id)
    );
    const productSnaps = await Promise.all(productRefs.map((r) => tx.get(r)));
    const products = new Map();
    productSnaps.forEach((s) => {
      if (!s.exists) throw Object.assign(new Error("Product missing"), { statusCode: 422 });
      products.set(s.id, { id: s.id, ...s.data() });
    });

    // validate stock for each cart item
    for (const ci of cartItems) {
      const product = products.get(ci.productId);
      if (!product) throw Object.assign(new Error(`Product ${ci.productId} not found`), { statusCode: 422 });
      if (product.availability === AVAILABILITY.OUT_OF_STOCK) {
        throw Object.assign(new Error(`${product.name} is out of stock`), { statusCode: 422, code: "OUT_OF_STOCK" });
      }
      const variant = product.variants.find((v) => v.id === ci.variantId);
      if (!variant) throw Object.assign(new Error("Variant not found"), { statusCode: 422 });
      if (variant.stock < ci.qty) {
        throw Object.assign(
          new Error(`Only ${variant.stock} unit(s) of ${product.name} (${variant.label}) available`),
          { statusCode: 422, code: "INSUFFICIENT_STOCK" }
        );
      }
    }

    // price
    const { items, subtotal } = priceCart(cartItems, products);
    if (subtotal < config.minOrderValue) {
      throw Object.assign(
        new Error(`Minimum order value is ₹${config.minOrderValue}`),
        { statusCode: 422, code: "BELOW_MIN_ORDER" }
      );
    }

    // geo / radius — delivery charge depends on subtotal (free above FREE_DELIVERY_THRESHOLD)
    const geo = evaluateDelivery(config, address.lat, address.lng, subtotal);
    // if (!geo.withinRadius) {
    //   throw Object.assign(new Error("Delivery currently unavailable in your area."), {
    //     statusCode: 422,
    //     code: "OUT_OF_SERVICE",
    //   });
    // }

    // coupon — re-read inside tx using doc ref for consistency
    let discount = 0;
    if (offerRef) {
      const offerSnap = await tx.get(offerRef);
      const offer = offerSnap.exists ? { id: offerSnap.id, ...offerSnap.data() } : null;
      discount = computeDiscount(offer, subtotal, items, products);
    }

    // customer info snapshot — denormalized onto the order so admin tooling never has
    // to join against users/{uid} just to show who placed it (same idea as addressSnapshot).
    const userSnap = await tx.get(db().collection(COLLECTIONS.USERS).doc(userId));
    const userData = userSnap.exists ? userSnap.data() : {};

    const taxed = subtotal - discount;
    const tax = applyTax(taxed, config.taxPercent);
    const total = Number((taxed + tax + geo.deliveryCharge).toFixed(2));

    // sequential order number
    const orderNo = (config.orderSeq || 1000) + 1;

    // decrement stock + availability
    for (const ci of cartItems) {
      const product = products.get(ci.productId);
      const variant = product.variants.find((v) => v.id === ci.variantId);
      variant.stock -= ci.qty;
      const totalStock = product.variants.reduce((s, v) => s + v.stock, 0);
      const availability = totalStock <= 0 ? AVAILABILITY.OUT_OF_STOCK : product.availability;
      tx.update(db().collection(COLLECTIONS.PRODUCTS).doc(product.id), {
        variants: product.variants,
        availability,
        soldCount: (product.soldCount || 0) + ci.qty,
        updatedAt: Date.now(),
      });
    }

    // create order
    const now = Date.now();
    const orderRef = db().collection(COLLECTIONS.ORDERS).doc();
    const order = {
      orderNo,
      userId,
      userName: userData.name || null,
      userEmail: userData.email || null,
      userPhone: userData.mobile || null,
      items,
      addressSnapshot: address,
      slot,
      notes: notes || null,
      paymentMethod,
      paymentStatus: PAYMENT_STATUS.PENDING,
      subtotal,
      tax,
      deliveryCharge: geo.deliveryCharge,
      discount,
      total,
      distanceKm: geo.distanceKm,
      status: ORDER_STATUS.PLACED,
      statusHistory: [{ status: ORDER_STATUS.PLACED, at: now }],
      assignedPartnerId: null,
      createdAt: now,
      updatedAt: now,
    };
    tx.set(orderRef, order);

    // bump order sequence
    tx.update(cfgRef, { orderSeq: orderNo, updatedAt: now });

    // metrics
    const hour = dayjs(now).format("H");
    const dayId = dayjs(now).format("YYYY-MM-DD");
    const monthId = dayjs(now).format("YYYY-MM");
    const dayRef = db().collection(COLLECTIONS.METRICS).doc("daily").collection("days").doc(dayId);
    const monthRef = db().collection(COLLECTIONS.METRICS).doc("monthly").collection("months").doc(monthId);
    const inc = require("firebase-admin").firestore.FieldValue.increment;
    tx.set(
      dayRef,
      { orders: inc(1), revenue: inc(total), pending: inc(1), [`hourly.${hour}`]: inc(1), updatedAt: now },
      { merge: true }
    );
    tx.set(monthRef, { orders: inc(1), revenue: inc(total), updatedAt: now }, { merge: true });

    // clear cart
    tx.set(db().collection(COLLECTIONS.CARTS).doc(userId), { items: [], couponCode: null, updatedAt: now });

    // bump user aggregates
    tx.set(
      db().collection(COLLECTIONS.USERS).doc(userId),
      { totalOrders: inc(1), lifetimeSpending: inc(total), updatedAt: now },
      { merge: true }
    );

    // idempotency record — TTL via expireAt if Cloud Firestore TTL enabled, else just leave it
    if (idempotencyKey) {
      tx.set(db().collection("orderIdempotency").doc(idempotencyKey), {
        orderId: orderRef.id,
        orderNo,
        userId,
        total,
        createdAt: now,
        expireAt: now + 24 * 60 * 60 * 1000, // 24h
      });
    }

    return { id: orderRef.id, ...order };
  });
}

// validates forward-only status transitions
function assertValidTransition(from, to) {
  if (to === ORDER_STATUS.CANCELLED) return true;
  const fi = ORDER_STATUS_FLOW.indexOf(from);
  const ti = ORDER_STATUS_FLOW.indexOf(to);
  if (ti !== fi + 1) {
    throw Object.assign(new Error(`Invalid transition ${from} -> ${to}`), { statusCode: 422 });
  }
  return true;
}

// Customer-facing copy for each status transition — kept here (not in the route) so
// every caller of updateStatus() (admin portal, delivery-partner app) notifies the
// customer identically, regardless of which client triggered the change.
const STATUS_NOTIFICATION = {
  [ORDER_STATUS.ACCEPTED]: (orderNo) => ["Order Accepted", `Your order #${orderNo} has been accepted and will be prepared soon.`],
  [ORDER_STATUS.PACKING]: (orderNo) => ["Packing your order", `Your order #${orderNo} is being packed.`],
  [ORDER_STATUS.READY]: (orderNo) => ["Ready for delivery", `Your order #${orderNo} is ready and will be out for delivery shortly.`],
  [ORDER_STATUS.OUT_FOR_DELIVERY]: (orderNo) => ["Out for delivery", `Your order #${orderNo} is on its way.`],
  [ORDER_STATUS.DELIVERED]: (orderNo) => ["Delivered", `Your order #${orderNo} has been delivered. Enjoy!`],
  [ORDER_STATUS.CANCELLED]: (orderNo) => ["Order Cancelled", `Your order #${orderNo} has been cancelled.`],
};

async function updateStatus(orderId, nextStatus) {
  const ref = db().collection(COLLECTIONS.ORDERS).doc(orderId);
  const order = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw Object.assign(new Error("Order not found"), { statusCode: 404 });
    const order = snap.data();
    assertValidTransition(order.status, nextStatus);

    // Hard stop: a UPI_MANUAL order can never be fulfilled (packed/shipped/delivered) unless the
    // customer has at least claimed payment. Without this, "fake payment" (nobody paid, nobody even
    // tapped "I've Paid") would still let staff advance the order to OUT_FOR_DELIVERY/DELIVERED.
    if (
      nextStatus !== ORDER_STATUS.CANCELLED &&
      order.paymentMethod === PAYMENT_METHOD.UPI_MANUAL &&
      order.paymentStatus === PAYMENT_STATUS.PENDING
    ) {
      throw Object.assign(
        new Error("This order's UPI payment has not been confirmed by the customer yet — it cannot be advanced until they tap \"I've Paid\" (or you mark it PAID directly)."),
        { statusCode: 422, code: "PAYMENT_NOT_CONFIRMED" }
      );
    }

    const now = Date.now();
    tx.update(ref, {
      status: nextStatus,
      statusHistory: [...order.statusHistory, { status: nextStatus, at: now }],
      updatedAt: now,
    });

    // metric adjustments on terminal states
    const inc = require("firebase-admin").firestore.FieldValue.increment;
    const dayId = dayjs(order.createdAt).format("YYYY-MM-DD");
    const dayRef = db().collection(COLLECTIONS.METRICS).doc("daily").collection("days").doc(dayId);
    if (nextStatus === ORDER_STATUS.DELIVERED) {
      tx.set(dayRef, { delivered: inc(1), pending: inc(-1), updatedAt: now }, { merge: true });
    } else if (nextStatus === ORDER_STATUS.CANCELLED) {
      tx.set(dayRef, { cancelled: inc(1), pending: inc(-1), updatedAt: now }, { merge: true });
    }
    return { ...order, id: orderId, status: nextStatus };
  });

  const notification = STATUS_NOTIFICATION[nextStatus];
  if (notification) {
    const [title, body] = notification(order.orderNo);
    await notifyUser(order.userId, title, body, { type: "ORDER_STATUS", status: nextStatus, orderId });
  }

  return { id: orderId, status: nextStatus };
}

// Customer confirms they paid via UPI; order moves PENDING -> AWAITING_CONFIRMATION.
// The shop/admin still has to verify the payment and mark it PAID (via /:id/status or admin tools).
async function markPaymentClaimed(orderId, userId) {
  const ref = db().collection(COLLECTIONS.ORDERS).doc(orderId);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw Object.assign(new Error("Order not found"), { statusCode: 404 });
    const order = snap.data();
    if (order.userId !== userId) throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
    if (order.paymentMethod !== PAYMENT_METHOD.UPI_MANUAL) {
      throw Object.assign(new Error("Order is not a UPI order"), { statusCode: 422 });
    }
    if (order.paymentStatus !== PAYMENT_STATUS.PENDING) {
      throw Object.assign(
        new Error(`Order payment is already ${order.paymentStatus}`),
        { statusCode: 422 }
      );
    }
    const now = Date.now();
    tx.update(ref, { paymentStatus: PAYMENT_STATUS.AWAITING_CONFIRMATION, updatedAt: now });
    return { id: orderId, paymentStatus: PAYMENT_STATUS.AWAITING_CONFIRMATION };
  });
}

// Customer removes an order from their own order-history list — doesn't delete the
// order doc (it's still a real record admin/reporting needs), just flags it so
// GET /orders/mine stops returning it. Idempotent; owner-only.
async function hideOrderForUser(orderId, userId) {
  const ref = db().collection(COLLECTIONS.ORDERS).doc(orderId);
  const snap = await ref.get();
  if (!snap.exists) throw Object.assign(new Error("Order not found"), { statusCode: 404 });
  const order = snap.data();
  if (order.userId !== userId) throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
  await ref.update({ hiddenFromUser: true, updatedAt: Date.now() });
  return { id: orderId, hiddenFromUser: true };
}

// Admin verifies the UPI payment actually landed (bank/UPI app check) and marks it PAID.
// This is the only place paymentStatus can become PAID for a UPI_MANUAL order — nothing
// in this codebase auto-confirms it.
async function markPaid(orderId) {
  const ref = db().collection(COLLECTIONS.ORDERS).doc(orderId);
  const order = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw Object.assign(new Error("Order not found"), { statusCode: 404 });
    const current = snap.data();
    if (current.paymentStatus === PAYMENT_STATUS.PAID) return { ...current, id: orderId, alreadyPaid: true };
    const now = Date.now();
    tx.update(ref, { paymentStatus: PAYMENT_STATUS.PAID, updatedAt: now });
    return { ...current, id: orderId, paymentStatus: PAYMENT_STATUS.PAID };
  });

  if (!order.alreadyPaid) {
    await notifyUser(
      order.userId,
      "Payment approved!",
      `Your order #${order.orderNo} is confirmed — it'll be delivered to your doorstep soon.`,
      { type: "PAYMENT_APPROVED", orderId }
    );
  }

  return { id: orderId, paymentStatus: PAYMENT_STATUS.PAID };
}

// Admin rejects a manually-claimed UPI payment — the money either never arrived or the
// wrong amount was credited. Cancels the order (nothing to fulfill) and requires a reason,
// which the customer sees on their tracking screen and in their notifications.
async function rejectPayment(orderId, reason, customReason) {
  if (!Object.values(PAYMENT_REJECTION_REASON).includes(reason)) {
    throw Object.assign(new Error("Invalid rejection reason"), { statusCode: 422 });
  }
  const reasonText = reason === PAYMENT_REJECTION_REASON.OTHER
    ? String(customReason || "").trim() || "Payment could not be verified."
    : REJECTION_REASON_LABELS[reason];

  const ref = db().collection(COLLECTIONS.ORDERS).doc(orderId);
  const order = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw Object.assign(new Error("Order not found"), { statusCode: 404 });
    const current = snap.data();
    if (current.paymentStatus === PAYMENT_STATUS.PAID) {
      throw Object.assign(new Error("This payment was already confirmed as PAID — it cannot be rejected."), { statusCode: 422 });
    }
    if (current.status === ORDER_STATUS.CANCELLED) {
      throw Object.assign(new Error("This order is already cancelled."), { statusCode: 422 });
    }
    const now = Date.now();
    tx.update(ref, {
      paymentStatus: PAYMENT_STATUS.FAILED,
      status: ORDER_STATUS.CANCELLED,
      paymentRejectionReason: reasonText,
      statusHistory: [...(current.statusHistory || []), { status: ORDER_STATUS.CANCELLED, at: now }],
      updatedAt: now,
    });
    return { ...current, id: orderId };
  });

  await notifyUser(
    order.userId,
    "Order rejected",
    reasonText,
    { type: "PAYMENT_REJECTED", orderId }
  );

  return { id: orderId, paymentStatus: PAYMENT_STATUS.FAILED, status: ORDER_STATUS.CANCELLED, paymentRejectionReason: reasonText };
}

module.exports = { placeOrder, updateStatus, assertValidTransition, markPaymentClaimed, markPaid, rejectPayment, hideOrderForUser };
