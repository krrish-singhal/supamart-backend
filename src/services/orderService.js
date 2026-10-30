const { storeStatus, withStoreHours } = require('../config/storeHours');
const { validCoordinates, withDeliveryArea } = require('../config/deliveryArea');
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
  LOW_STOCK_THRESHOLD,
} = require("../config/constants");
const { evaluateDelivery } = require("./geoService");
const { priceCart, computeDiscount, applyTax } = require("./pricingService");
const { notifyUser, notifyLowStockToCartHolders, notifyAdminsLowStock } = require("./notificationService");
const { invalidateLowStockCache } = require("../routes/admin.routes");

const REJECTION_REASON_LABELS = {
  [PAYMENT_REJECTION_REASON.NOT_RECEIVED]: "Amount was not received in our account.",
  [PAYMENT_REJECTION_REASON.INCORRECT_AMOUNT]: "The amount credited was incorrect.",
  [PAYMENT_REJECTION_REASON.INVALID_UTR]: "Invalid or unverified UTR reference number.",
};

async function getConfig(tx) {
  const ref = db().collection(COLLECTIONS.CONFIG).doc("global");
  const snap = tx ? await tx.get(ref) : await ref.get();
  if (!snap.exists) throw Object.assign(new Error("Config missing"), { statusCode: 500 });
  return { ref, data: withStoreHours(withDeliveryArea(snap.data())) };
}

/**
 * Places an order atomically:
 * - reprices server-side, validates min order value
 * - enforces 5KM radius + computes delivery charge
 * - decrements stock, auto-marks out-of-stock products unavailable
 * - allocates sequential order number
 * - writes daily + monthly metric counters (incl. peak-hour histogram)
 */
async function placeOrder({ userId, cartItems, couponCode, address, notes, paymentMethod, idempotencyKey }) {
  // Cash on Delivery has been discontinued — UPI_MANUAL is the only accepted method.
  // Enforced here (not just hidden in the UI) so no client build can place a COD order.
  if (paymentMethod !== PAYMENT_METHOD.UPI_MANUAL) {
    throw Object.assign(
      new Error("Cash on Delivery is no longer available. Please pay via UPI."),
      { statusCode: 422, code: "COD_DISCONTINUED" }
    );
  }

  if (!address || !validCoordinates(address.lat, address.lng)) {
    throw Object.assign(new Error('Select a delivery address with valid map coordinates.'), {
      statusCode: 422, code: 'INVALID_DELIVERY_LOCATION',
    });
  }

  // Resolve coupon OUTSIDE the transaction (Admin SDK tx.get() only accepts doc refs, not queries)
  let offerRef = null;
  let offerData = null;
  const cleanCouponCode = couponCode ? String(couponCode).trim().toUpperCase() : null;
  if (cleanCouponCode) {
    const offSnap = await db()
      .collection(COLLECTIONS.OFFERS)
      .where("code", "==", cleanCouponCode)
      .limit(1)
      .get();
    if (offSnap.empty) {
      throw Object.assign(new Error("Invalid or expired coupon"), {
        statusCode: 422,
        code: "INVALID_COUPON",
      });
    }

    offerRef = offSnap.docs[0].ref;
    offerData = { id: offSnap.docs[0].id, ...offSnap.docs[0].data() };

    const now = Date.now();
    if (
      !offerData.isActive ||
      (offerData.validFrom && now < offerData.validFrom) ||
      (offerData.validTo && now > offerData.validTo)
    ) {
      throw Object.assign(new Error("Invalid or expired coupon"), {
        statusCode: 422,
        code: "INVALID_COUPON",
      });
    }

    const { hasUserUsedCoupon } = require("./couponService");
    const alreadyUsed = await hasUserUsedCoupon(userId, cleanCouponCode);
    if (alreadyUsed) {
      throw Object.assign(
        new Error("You have already used this coupon code. Each coupon can only be used once."),
        { statusCode: 422, code: "COUPON_ALREADY_USED" }
      );
    }
  }

  const result = await db().runTransaction(async (tx) => {
    // Idempotency: if a key was supplied, check if we already wrote this order
    if (idempotencyKey) {
      const idemSnap = await tx.get(
        db().collection("orderIdempotency").doc(idempotencyKey)
      );
      if (idemSnap.exists) {
        const prev = idemSnap.data();
        const existingOrderId = prev.orderId || prev.id;
        if (existingOrderId) {
          const prevOrderSnap = await tx.get(db().collection(COLLECTIONS.ORDERS).doc(existingOrderId));
          if (prevOrderSnap.exists) {
            const prevOrder = prevOrderSnap.data();
            // If the previous order was cancelled or failed, do NOT return it as active; allow creating fresh order
            if (prevOrder.status !== ORDER_STATUS.CANCELLED && prevOrder.paymentStatus !== PAYMENT_STATUS.FAILED) {
              return { id: existingOrderId, ...prevOrder };
            }
          }
        }
      }
    }

    const { ref: cfgRef, data: config } = await getConfig(tx);

    // Check after idempotency lookup: retrying an already-created order stays safe after closing.
    const currentStatus = storeStatus(Date.now(), config);
    if (!currentStatus.isOpen) {
      throw Object.assign(new Error(currentStatus.label || 'The shop is closed. Order daily from 10 AM to 11 PM (India time).'), {
        statusCode: 422, code: 'STORE_CLOSED',
      });
    }

    // Check the actual address before stock/price work or any transaction writes.
    const geo = evaluateDelivery(config, address.lat, address.lng);
    if (!geo.withinRadius) {
      throw Object.assign(new Error('Delivery is available only within 5 km of our Menamkulam shop, including exactly 5 km.'), {
        statusCode: 422, code: 'OUT_OF_SERVICE',
      });
    }

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
      if (
        product.availability === AVAILABILITY.OUT_OF_STOCK ||
        product.availability === AVAILABILITY.UNAVAILABLE
      ) {
        throw Object.assign(new Error(`${product.name} is currently out of stock`), {
          statusCode: 422,
          code: "OUT_OF_STOCK",
          outOfStockItem: { productId: product.id, name: product.name, variantId: ci.variantId },
        });
      }
      const variant = product.variants.find((v) => v.id === ci.variantId);
      if (!variant) throw Object.assign(new Error("Variant not found"), { statusCode: 422 });
      if (variant.stock < ci.qty) {
        throw Object.assign(
          new Error(
            variant.stock <= 0
              ? `${product.name} is out of stock`
              : `Only ${variant.stock} unit(s) of ${product.name} (${variant.label}) available`
          ),
          {
            statusCode: 422,
            code: variant.stock <= 0 ? "OUT_OF_STOCK" : "INSUFFICIENT_STOCK",
            outOfStockItem: { productId: product.id, name: product.name, variantId: ci.variantId, availableStock: variant.stock },
          }
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

    // Apply the same distance-based delivery tiers after repricing the cart.
    geo.deliveryCharge = evaluateDelivery(config, address.lat, address.lng, subtotal).deliveryCharge;

    // coupon — re-read inside tx using doc ref for consistency
    let discount = 0;
    if (offerRef) {
      const offerSnap = await tx.get(offerRef);
      const offer = offerSnap.exists ? { id: offerSnap.id, ...offerSnap.data() } : null;
      if (!offer || !offer.isActive) {
        throw Object.assign(new Error("Invalid or expired coupon"), {
          statusCode: 422,
          code: "INVALID_COUPON",
        });
      }
      if (offer.minValue && subtotal < offer.minValue) {
        throw Object.assign(
          new Error(`Minimum order value for coupon ${cleanCouponCode} is ₹${offer.minValue}`),
          { statusCode: 422, code: "BELOW_COUPON_MIN_ORDER" }
        );
      }
      discount = computeDiscount(offer, subtotal, items, products);
    }

    // customer info snapshot — denormalized onto the order so admin tooling never has
    // to join against users/{uid} just to show who placed it (same idea as addressSnapshot).
    const userRef = db().collection(COLLECTIONS.USERS).doc(userId);
    const userSnap = await tx.get(userRef);
    const userData = userSnap.exists ? userSnap.data() : {};

    // Atomic concurrency check: ensure coupon was not used concurrently
    if (cleanCouponCode) {
      const usedSubRef = userRef.collection("usedCoupons").doc(cleanCouponCode);
      const usedSubSnap = await tx.get(usedSubRef);
      if (
        usedSubSnap.exists ||
        (Array.isArray(userData.usedCoupons) && userData.usedCoupons.includes(cleanCouponCode))
      ) {
        throw Object.assign(
          new Error("You have already used this coupon code. Each coupon can only be used once."),
          { statusCode: 422, code: "COUPON_ALREADY_USED" }
        );
      }
    }

    const tax = applyTax(subtotal, config.taxPercent);
    const total = Number(Math.max(0, subtotal + tax + geo.deliveryCharge - discount).toFixed(2));

    // sequential order number
    const orderNo = (config.orderSeq || 1000) + 1;

    // decrement stock + availability
    const lowStockItems = [];
    for (const ci of cartItems) {
      const product = products.get(ci.productId);
      const variant = product.variants.find((v) => v.id === ci.variantId);
      const previousStock = variant.stock;
      variant.stock -= ci.qty;
      const threshold = Number(product.lowStockThreshold) || LOW_STOCK_THRESHOLD || 10;
      if (variant.stock <= threshold) {
        lowStockItems.push({
          productId: product.id,
          name: product.name,
          variantId: variant.id,
          variantLabel: variant.label,
          previousStock,
          stock: variant.stock,
          threshold,
          isOutOfStock: variant.stock <= 0,
        });
      }
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
      couponCode: cleanCouponCode || null,
      couponId: offerData?.id || null,
      addressSnapshot: address,
      deliveryMode: "ON_DEMAND",
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
      idempotencyKey: idempotencyKey || null,
      createdAt: now,
      updatedAt: now,
    };
    tx.set(orderRef, order);

    // record real-time operational alerts for admin
    for (const item of lowStockItems) {
      const alertRef = db().collection(COLLECTIONS.ADMIN_ALERTS || "adminAlerts").doc();
      tx.set(alertRef, {
        type: item.isOutOfStock ? "OUT_OF_STOCK" : "LOW_STOCK",
        productId: item.productId,
        productName: item.name,
        variantId: item.variantId,
        variantLabel: item.variantLabel,
        previousStock: item.previousStock,
        currentStock: Math.max(0, item.stock),
        threshold: item.threshold,
        isOutOfStock: item.isOutOfStock,
        orderId: orderRef.id,
        orderNo,
        createdAt: now,
        read: false,
      });
    }

    // mark coupon as used atomically
    if (cleanCouponCode) {
      const { markCouponUsedInTx } = require("./couponService");
      markCouponUsedInTx(tx, userId, cleanCouponCode, orderRef.id, offerData?.id, discount);
    }

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
        id: orderRef.id,
        orderId: orderRef.id,
        orderNo,
        userId,
        total,
        createdAt: now,
        expireAt: now + 24 * 60 * 60 * 1000, // 24h
      });
    }

    return { order: { id: orderRef.id, ...order }, lowStockItems };
  });

  // Always invalidate low stock cache and products read cache when order is created
  try {
    invalidateLowStockCache();
    const { invalidateReadsCache } = require("../routes/reads.routes");
    invalidateReadsCache("products");
  } catch (_) {}

  if (result?.lowStockItems && result.lowStockItems.length > 0) {
    for (const item of result.lowStockItems) {
      if (item.stock > 0 && item.stock <= 5) {
        notifyLowStockToCartHolders(item.productId, item.stock, item.name).catch(() => {});
      }
    }
    // Push real-time low-stock and out-of-stock notification to admin devices
    notifyAdminsLowStock(result.lowStockItems, result.order?.orderNo).catch((err) => {
      console.error("notifyAdminsLowStock failed", err);
    });
  }

  return result?.order || result;
}

// Validates forward-only status transitions — but not required to be the immediate next
// step. A one-shop/one-rider admin needs to be able to correct/skip a status from the desk
// (e.g. an order that was never marked Accepted but is already physically out the door)
// without hitting "Invalid transition X -> Y". Still always forward, never backward, and
// CANCELLED is reachable from any non-terminal state.
function assertValidTransition(from, to) {
  if (from === ORDER_STATUS.DELIVERED || from === ORDER_STATUS.CANCELLED) {
    throw Object.assign(
      new Error(`Order is finalized as ${from} and cannot be modified or reopened`),
      { statusCode: 422, code: "ORDER_CLOSED" }
    );
  }

  if (to === ORDER_STATUS.CANCELLED) return true;
  
  if (from === ORDER_STATUS.DELIVERY_DISPUTED) {
    if (to === ORDER_STATUS.OUT_FOR_DELIVERY || to === ORDER_STATUS.DELIVERED) return true;
  }

  let normalizedFrom = from;
  if (from === 'PACKING' || from === 'READY_FOR_DELIVERY') {
    normalizedFrom = ORDER_STATUS.ACCEPTED;
  }

  // Idempotent: re-accepting or confirming an order that is already in target status succeeds quietly
  if (from === to || normalizedFrom === to) return true;

  const fi = ORDER_STATUS_FLOW.indexOf(normalizedFrom);
  const ti = ORDER_STATUS_FLOW.indexOf(to);
  if (fi === -1 || ti === -1 || ti <= fi) {
    throw Object.assign(new Error(`Invalid transition ${from} -> ${to}`), { statusCode: 422 });
  }
  return true;
}

// Customer-facing copy for each status transition — kept here (not in the route) so
// every caller of updateStatus() (admin portal, delivery-partner app) notifies the
// customer identically, regardless of which client triggered the change.
const STATUS_NOTIFICATION = {
  [ORDER_STATUS.ACCEPTED]: (orderNo) => ["Order Accepted", `Your order #${orderNo} has been accepted and will be prepared soon.`],
  [ORDER_STATUS.OUT_FOR_DELIVERY]: (orderNo) => ["Out for delivery", `Your order #${orderNo} is on its way.`],
  [ORDER_STATUS.PENDING_CONFIRMATION]: (orderNo) => ["Confirm Delivery", `Your delivery partner marked order #${orderNo} as delivered. Please confirm in the app.`],
  [ORDER_STATUS.DELIVERY_DISPUTED]: (orderNo) => ["Delivery Disputed", `We have registered your dispute for order #${orderNo}. Our team will contact you.`],
  [ORDER_STATUS.DELIVERED]: (orderNo) => ["Delivered", `Your order #${orderNo} has been delivered. Enjoy!`],
  [ORDER_STATUS.CANCELLED]: (orderNo) => ["Order Cancelled", `Your order #${orderNo} has been cancelled.`],
};

async function updateStatus(orderId, nextStatus, user) {
  const ref = db().collection(COLLECTIONS.ORDERS).doc(orderId);
  const order = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw Object.assign(new Error("Order not found"), { statusCode: 404 });
    const order = snap.data();

    if (user && user.role === "PARTNER" && nextStatus === ORDER_STATUS.DELIVERED) {
      throw Object.assign(new Error("Partners cannot mark orders as completed directly. Waiting for customer confirmation."), { statusCode: 403 });
    }

    if (user && user.role === "PARTNER" && order.deliveryAcceptanceStatus === "REJECTED") {
      throw Object.assign(new Error("Cannot update status of a rejected order."), { statusCode: 403 });
    }

    if (order.status === ORDER_STATUS.DELIVERED || order.status === ORDER_STATUS.CANCELLED) {
      throw Object.assign(
        new Error(`Order #${order.orderNo || orderId} is closed (${order.status}) and cannot be reopened or edited.`),
        { statusCode: 422, code: "ORDER_CLOSED" }
      );
    }

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

    let productSnaps = [];
    if (nextStatus === ORDER_STATUS.CANCELLED && Array.isArray(order.items) && order.items.length > 0) {
      const productRefs = [...new Set(order.items.map((i) => i.productId))].filter(Boolean).map((id) =>
        db().collection(COLLECTIONS.PRODUCTS).doc(id)
      );
      productSnaps = await Promise.all(productRefs.map((r) => tx.get(r)));
    }

    const now = Date.now();
    const etaFields = nextStatus === ORDER_STATUS.OUT_FOR_DELIVERY
      ? {
          outForDeliveryAt: now,
          estimatedDeliveryAt: Number.isFinite(Number(order.distanceKm)) && Number(order.distanceKm) > 0
            ? now + (Math.ceil(Math.max(2, Math.min(180, Number(order.distanceKm) * 1.3 / 20 * 60)) + (Number(order.deliveryDelayMinutes) || 0)) * 60000)
            : null,
        }
      : {};
    tx.update(ref, {
      status: nextStatus,
      statusHistory: [...order.statusHistory, { status: nextStatus, at: now }],
      ...etaFields,
      updatedAt: now,
    });

    if (nextStatus === ORDER_STATUS.CANCELLED && productSnaps.length > 0) {
      const products = new Map();
      productSnaps.forEach((s) => {
        if (s.exists) products.set(s.id, { id: s.id, ...s.data() });
      });
      for (const item of order.items || []) {
        const product = products.get(item.productId);
        if (!product) continue;
        const variant = (product.variants || []).find((v) => v.id === item.variantId);
        if (!variant) continue;
        variant.stock = (variant.stock || 0) + (item.qty || 1);
        const totalStock = product.variants.reduce((s, v) => s + (v.stock || 0), 0);
        const availability = totalStock > 0 ? AVAILABILITY.AVAILABLE : product.availability;
        const soldCount = Math.max(0, (product.soldCount || 0) - (item.qty || 1));
        tx.update(db().collection(COLLECTIONS.PRODUCTS).doc(product.id), {
          variants: product.variants,
          availability,
          soldCount,
          updatedAt: Date.now(),
        });
      }
    }

    // metric adjustments on terminal states
    const inc = require("firebase-admin").firestore.FieldValue.increment;
    const dayId = dayjs(order.createdAt).format("YYYY-MM-DD");
    const dayRef = db().collection(COLLECTIONS.METRICS).doc("daily").collection("days").doc(dayId);
    if (nextStatus === ORDER_STATUS.DELIVERED) {
      tx.set(dayRef, { delivered: inc(1), pending: inc(-1), updatedAt: now }, { merge: true });
    } else if (nextStatus === ORDER_STATUS.CANCELLED) {
      tx.set(dayRef, { cancelled: inc(1), pending: inc(-1), updatedAt: now }, { merge: true });
      if (order.couponCode) {
        const { releaseCouponInTx } = require("./couponService");
        releaseCouponInTx(tx, order.userId, order.couponCode, order.couponId);
      }
    }
    return { ...order, id: orderId, status: nextStatus };
  });

  const notification = STATUS_NOTIFICATION[nextStatus];
  if (notification) {
    const [title, body] = notification(order.orderNo);
    notifyUser(order.userId, title, body, { type: "ORDER_STATUS", status: nextStatus, orderId }).catch(e => console.error(e));
  }

  try {
    const { invalidateReadsCache } = require("../routes/reads.routes");
    invalidateReadsCache(orderId);
    if (order.userId) invalidateReadsCache(order.userId);
    invalidateReadsCache("products");
    invalidateLowStockCache();
  } catch (_) {}

  return { id: orderId, status: nextStatus };
}

// Customer confirms they paid via UPI; order moves PENDING -> AWAITING_CONFIRMATION.
// The shop/admin still has to verify the payment and mark it PAID (via /:id/status or admin tools).
async function markPaymentClaimed(orderId, userId) {
  const ref = db().collection(COLLECTIONS.ORDERS).doc(orderId);
  const res = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw Object.assign(new Error("Order not found"), { statusCode: 404 });
    const order = snap.data();
    if (order.userId !== userId) throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
    if (order.status === ORDER_STATUS.DELIVERED) {
      throw Object.assign(
        new Error(`Order is closed (${order.status}) and payment cannot be claimed.`),
        { statusCode: 422, code: "ORDER_CLOSED" }
      );
    }
    if (order.paymentMethod !== PAYMENT_METHOD.UPI_MANUAL) {
      throw Object.assign(new Error("Order is not a UPI order"), { statusCode: 422 });
    }
    // Allow claiming if payment is PENDING or if user is retrying after a FAILED payment
    if (order.paymentStatus !== PAYMENT_STATUS.PENDING && order.paymentStatus !== PAYMENT_STATUS.FAILED) {
      throw Object.assign(
        new Error(`Order payment is already ${order.paymentStatus}`),
        { statusCode: 422 }
      );
    }
    const now = Date.now();
    const updateData = {
      paymentStatus: PAYMENT_STATUS.AWAITING_CONFIRMATION,
      paymentRejectionReason: null,
      updatedAt: now,
    };
    if (order.status === ORDER_STATUS.CANCELLED) {
      updateData.status = ORDER_STATUS.PLACED;
      updateData.statusHistory = [
        ...(order.statusHistory || []),
        { status: ORDER_STATUS.PLACED, at: now, note: "Customer retried payment" },
      ];
      if (order.couponCode) {
        const { markCouponUsedInTx } = require("./couponService");
        markCouponUsedInTx(tx, order.userId, order.couponCode, orderId, order.couponId, order.discount || 0);
      }
    }
    tx.update(ref, updateData);
    return { id: orderId, paymentStatus: PAYMENT_STATUS.AWAITING_CONFIRMATION, status: updateData.status || order.status };
  });

  try {
    const { invalidateReadsCache } = require("../routes/reads.routes");
    invalidateReadsCache(orderId);
    if (userId) invalidateReadsCache(userId);
  } catch (_) {}

  return res;
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
    if (current.status === ORDER_STATUS.DELIVERED || current.status === ORDER_STATUS.CANCELLED) {
      throw Object.assign(
        new Error(`Order #${current.orderNo || orderId} is closed (${current.status}) — payment status cannot be modified.`),
        { statusCode: 422, code: "ORDER_CLOSED" }
      );
    }
    if (current.paymentStatus === PAYMENT_STATUS.PAID) return { ...current, id: orderId, alreadyPaid: true };
    if (current.paymentStatus === PAYMENT_STATUS.FAILED) {
      throw Object.assign(
        new Error("Payment was previously rejected and cannot be modified."),
        { statusCode: 422, code: "PAYMENT_ALREADY_FAILED" }
      );
    }
    const now = Date.now();
    const updates = { paymentStatus: PAYMENT_STATUS.PAID, updatedAt: now };
    let newStatus = current.status;
    if (current.status === ORDER_STATUS.ORDER_PLACED || !current.status) {
      newStatus = ORDER_STATUS.ORDER_ACCEPTED;
      updates.status = ORDER_STATUS.ORDER_ACCEPTED;
      updates.statusHistory = [...(current.statusHistory || []), { status: ORDER_STATUS.ORDER_ACCEPTED, at: now }];
    }
    tx.update(ref, updates);
    return { ...current, id: orderId, paymentStatus: PAYMENT_STATUS.PAID, status: newStatus };
  });

  if (!order.alreadyPaid) {
    notifyUser(
      order.userId,
      "Payment approved!",
      `Your order #${order.orderNo} is confirmed — it'll be delivered to your doorstep soon.`,
      { type: "PAYMENT_APPROVED", orderId }
    ).catch(e => console.error(e));
  }

  try {
    const { invalidateReadsCache } = require("../routes/reads.routes");
    invalidateReadsCache(orderId);
    if (order?.userId) invalidateReadsCache(order.userId);
  } catch (e) {
    console.error("Cache invalidation error:", e);
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
    if (current.status === ORDER_STATUS.DELIVERED) {
      // If order was already marked delivered, mark payment claim as failed without restocking inventory
      const now = Date.now();
      tx.update(ref, {
        paymentStatus: PAYMENT_STATUS.FAILED,
        paymentRejectionReason: reasonText,
        statusHistory: [
          ...(current.statusHistory || []),
          { status: ORDER_STATUS.DELIVERED, at: now, note: `Payment rejected: ${reasonText}` },
        ],
        updatedAt: now,
      });
      return { ...current, id: orderId, paymentStatus: PAYMENT_STATUS.FAILED, paymentRejectionReason: reasonText };
    }
    if (current.paymentStatus === PAYMENT_STATUS.PAID) {
      throw Object.assign(new Error("This payment was already confirmed as PAID — it cannot be rejected."), { statusCode: 422 });
    }
    if (current.paymentStatus === PAYMENT_STATUS.FAILED && current.status === ORDER_STATUS.CANCELLED) {
      return { ...current, id: orderId };
    }

    // Read all products in order to restore stock (reads must come before writes in tx)
    const productRefs = [...new Set((current.items || []).map((i) => i.productId))].map((id) =>
      db().collection(COLLECTIONS.PRODUCTS).doc(id)
    );
    const productSnaps = await Promise.all(productRefs.map((r) => tx.get(r)));
    const products = new Map();
    productSnaps.forEach((s) => {
      if (s.exists) products.set(s.id, { id: s.id, ...s.data() });
    });

    // 1. Restore product stock so items are immediately available for repurchase/retry
    for (const item of current.items || []) {
      const product = products.get(item.productId);
      if (!product) continue;
      const variant = (product.variants || []).find((v) => v.id === item.variantId);
      if (!variant) continue;
      variant.stock = (variant.stock || 0) + (item.qty || 1);
      const totalStock = product.variants.reduce((s, v) => s + (v.stock || 0), 0);
      const availability = totalStock > 0 ? AVAILABILITY.AVAILABLE : product.availability;
      const soldCount = Math.max(0, (product.soldCount || 0) - (item.qty || 1));
      tx.update(db().collection(COLLECTIONS.PRODUCTS).doc(product.id), {
        variants: product.variants,
        availability,
        soldCount,
        updatedAt: Date.now(),
      });
    }

    // 2. Mark order cancelled and payment failed
    const now = Date.now();
    tx.update(ref, {
      paymentStatus: PAYMENT_STATUS.FAILED,
      status: ORDER_STATUS.CANCELLED,
      paymentRejectionReason: reasonText,
      statusHistory: [...(current.statusHistory || []), { status: ORDER_STATUS.CANCELLED, at: now, note: reasonText }],
      updatedAt: now,
    });

    // 3. Clear idempotency record if present so retry won't return stale cancelled order
    if (current.idempotencyKey) {
      tx.delete(db().collection("orderIdempotency").doc(current.idempotencyKey));
    }

    if (current.couponCode) {
      const { releaseCouponInTx } = require("./couponService");
      releaseCouponInTx(tx, current.userId, current.couponCode, current.couponId);
    }

    return { ...current, id: orderId };
  });

  notifyUser(
    order.userId,
    "Payment rejected!",
    `Your payment for order #${order.orderNo || orderId} was rejected: ${reasonText}. Please tap to retry payment.`,
    { type: "PAYMENT_REJECTED", orderId, orderNo: order.orderNo }
  ).catch(e => console.error(e));

  try {
    const { invalidateReadsCache } = require("../routes/reads.routes");
    invalidateReadsCache(orderId);
    if (order?.userId) invalidateReadsCache(order.userId);
    invalidateReadsCache("products");
    invalidateLowStockCache();
  } catch (e) {
    console.error("Cache invalidation error:", e);
  }

  return { id: orderId, paymentStatus: PAYMENT_STATUS.FAILED, status: ORDER_STATUS.CANCELLED, paymentRejectionReason: reasonText };
}

async function confirmDelivery(orderId, userId, rating, review, ratingsData) {
  let resolvedOrderId = orderId;
  let ref = db().collection(COLLECTIONS.ORDERS).doc(orderId);
  const directSnap = await ref.get();
  if (!directSnap.exists) {
    const num = Number(orderId);
    if (!isNaN(num)) {
      const qSnap = await db().collection(COLLECTIONS.ORDERS).where("orderNo", "==", num).limit(1).get();
      if (!qSnap.empty) {
        ref = qSnap.docs[0].ref;
        resolvedOrderId = qSnap.docs[0].id;
      }
    }
  }

  const order = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw Object.assign(new Error("Order not found"), { statusCode: 404 });
    const orderData = snap.data();
    
    if (orderData.userId && orderData.userId !== userId) {
      throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
    }
    if (orderData.status !== ORDER_STATUS.PENDING_CONFIRMATION && orderData.status !== ORDER_STATUS.DELIVERED) {
      throw Object.assign(new Error("Order is not pending confirmation"), { statusCode: 422 });
    }

    const now = Date.now();
    const updatePayload = {
      status: ORDER_STATUS.DELIVERED,
      confirmedAt: now,
      deliveryRating: rating || ratingsData?.orderRating || null,
      deliveryReview: review || ratingsData?.review || null,
      updatedAt: now,
    };

    if (ratingsData) {
      updatePayload.ratings = {
        orderRating: ratingsData.orderRating || rating || 5,
        review: ratingsData.review || review || "",
        deliveryFeedback: ratingsData.deliveryFeedback || null,
        productRatings: ratingsData.productRatings || [],
        ratedAt: now,
      };
    }

    if (orderData.status !== ORDER_STATUS.DELIVERED) {
      updatePayload.statusHistory = [...(orderData.statusHistory || []), { status: ORDER_STATUS.DELIVERED, at: now, note: "Confirmed by customer" }];
      const inc = require("firebase-admin").firestore.FieldValue.increment;
      const dayId = dayjs(orderData.createdAt).format("YYYY-MM-DD");
      const dayRef = db().collection(COLLECTIONS.METRICS).doc("daily").collection("days").doc(dayId);
      tx.set(dayRef, { delivered: inc(1), pending: inc(-1), updatedAt: now }, { merge: true });
    }

    tx.update(ref, updatePayload);

    return { ...orderData, ...updatePayload, id: resolvedOrderId };
  });

  const notification = STATUS_NOTIFICATION[ORDER_STATUS.DELIVERED];
  if (notification) {
    const [title, body] = notification(order.orderNo);
    notifyUser(userId, title, body, { type: "ORDER_STATUS", status: ORDER_STATUS.DELIVERED, orderId: resolvedOrderId }).catch(e => console.error(e));
  }

  try {
    const { invalidateReadsCache } = require("../routes/reads.routes");
    invalidateReadsCache(resolvedOrderId);
    if (userId) invalidateReadsCache(userId);
    invalidateReadsCache("orders");
  } catch (_) {}

  return order;
}

async function disputeDelivery(orderId, userId) {
  let resolvedOrderId = orderId;
  let ref = db().collection(COLLECTIONS.ORDERS).doc(orderId);
  const directSnap = await ref.get();
  if (!directSnap.exists) {
    const num = Number(orderId);
    if (!isNaN(num)) {
      const qSnap = await db().collection(COLLECTIONS.ORDERS).where("orderNo", "==", num).limit(1).get();
      if (!qSnap.empty) {
        ref = qSnap.docs[0].ref;
        resolvedOrderId = qSnap.docs[0].id;
      }
    }
  }

  const order = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw Object.assign(new Error("Order not found"), { statusCode: 404 });
    const orderData = snap.data();
    
    if (orderData.userId && orderData.userId !== userId) {
      throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
    }
    if (orderData.status !== ORDER_STATUS.PENDING_CONFIRMATION) {
      throw Object.assign(new Error("Order is not pending confirmation"), { statusCode: 422 });
    }

    const now = Date.now();
    tx.update(ref, {
      status: ORDER_STATUS.DELIVERY_DISPUTED,
      statusHistory: [...orderData.statusHistory, { status: ORDER_STATUS.DELIVERY_DISPUTED, at: now }],
      updatedAt: now,
    });

    return { ...orderData, id: resolvedOrderId, status: ORDER_STATUS.DELIVERY_DISPUTED };
  });

  // Also record this as an active customer issue in COLLECTIONS.ISSUES so Admin Portal -> Issues sees it immediately
  try {
    const issueData = {
      orderId,
      orderNo: order.orderNo || orderId.slice(-4),
      orderDate: order.createdAt || Date.now(),
      orderTotal: Number(order.total || order.totalAmount || 0),
      userId,
      userName: order.userName || "Customer",
      userEmail: order.userEmail || "",
      userPhone: order.userPhone || "",
      address: order.addressSnapshot || order.address || null,
      affectedItems: order.items || [],
      issueType: "Delivery Not Received",
      photos: [],
      description: `Customer reported they did not receive Order #${order.orderNo || orderId.slice(-4)}. Partner marked it delivered, but customer disputed delivery.`,
      resolutionType: "REFUND",
      status: "OPEN",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await db().collection(COLLECTIONS.ISSUES).add(issueData);
  } catch (err) {
    console.error("Failed to sync dispute to issues collection:", err);
  }

  const notification = STATUS_NOTIFICATION[ORDER_STATUS.DELIVERY_DISPUTED];
  if (notification) {
    const [title, body] = notification(order.orderNo);
    notifyUser(userId, title, body, { type: "ORDER_STATUS", status: ORDER_STATUS.DELIVERY_DISPUTED, orderId }).catch(e => console.error(e));
  }

  try {
    const { invalidateReadsCache } = require("../routes/reads.routes");
    invalidateReadsCache(orderId);
    if (userId) invalidateReadsCache(userId);
    invalidateReadsCache("orders");
  } catch (_) {}

  return order;
}

module.exports = { placeOrder, updateStatus, assertValidTransition,  markPaymentClaimed,
  markPaid,
  rejectPayment,
  hideOrderForUser,
  confirmDelivery,
  disputeDelivery,
};
