const { db } = require("../config/firebase");
const dayjs = require("dayjs");
const {
  COLLECTIONS,
  ORDER_STATUS,
  ORDER_STATUS_FLOW,
  PAYMENT_STATUS,
  PAYMENT_METHOD,
  AVAILABILITY,
} = require("../config/constants");
const { evaluateDelivery } = require("./geoService");
const { priceCart, computeDiscount, applyTax } = require("./pricingService");

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

    // geo / radius
    const geo = evaluateDelivery(config, address.lat, address.lng);
    if (!geo.withinRadius) {
      throw Object.assign(new Error("Delivery currently unavailable in your area."), {
        statusCode: 422,
        code: "OUT_OF_SERVICE",
      });
    }

    // price
    const { items, subtotal } = priceCart(cartItems, products);
    if (subtotal < config.minOrderValue) {
      throw Object.assign(
        new Error(`Minimum order value is ₹${config.minOrderValue}`),
        { statusCode: 422, code: "BELOW_MIN_ORDER" }
      );
    }

    // coupon — re-read inside tx using doc ref for consistency
    let discount = 0;
    if (offerRef) {
      const offerSnap = await tx.get(offerRef);
      const offer = offerSnap.exists ? { id: offerSnap.id, ...offerSnap.data() } : null;
      discount = computeDiscount(offer, subtotal, items, products);
    }

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
      items,
      addressSnapshot: address,
      slot,
      notes: notes || null,
      paymentMethod: paymentMethod || PAYMENT_METHOD.COD,
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

async function updateStatus(orderId, nextStatus) {
  const ref = db().collection(COLLECTIONS.ORDERS).doc(orderId);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw Object.assign(new Error("Order not found"), { statusCode: 404 });
    const order = snap.data();
    assertValidTransition(order.status, nextStatus);
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
    return { id: orderId, status: nextStatus };
  });
}

module.exports = { placeOrder, updateStatus, assertValidTransition };
