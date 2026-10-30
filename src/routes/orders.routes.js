const express = require("express");
const { asyncHandler } = require("../middleware/error");
const { authenticate, requireRole } = require("../middleware/auth");
const { placeOrder, updateStatus, markPaymentClaimed, markPaid, rejectPayment, hideOrderForUser, confirmDelivery, disputeDelivery } = require("../services/orderService");
const { createPayment } = require("../services/paymentService");
const { sendOwnerWhatsApp, notifyAdminsNewOrder, notifyUser } = require("../services/notificationService");
const { Orders, DeliveryPartners, Users } = require("../models");
const { db, authAdmin } = require("../config/firebase");
const { ROLES, ORDER_STATUS, COLLECTIONS, REFUND_STATUS } = require("../config/constants");
const { storeStatus } = require("../config/storeHours");
const { invalidateReadsCache, onInvalidateReadsCache } = require("./reads.routes");
const { enqueueDeliveryDelayEmail, processDeliveryDelayEmail } = require("../services/deliveryDelayEmailQueue");

const router = express.Router();

// In-memory cache for user orders (/mine), buy-again, and individual order lookups (/:id)
// Drastically cuts Firestore reads from polling and screen focus events
const userOrdersCache = new Map();
const USER_ORDERS_CACHE_TTL_MS = 20 * 1000; // 20s
const orderDetailCache = new Map();
const ORDER_DETAIL_CACHE_TTL_MS = 10 * 1000; // 10s
const buyAgainCache = new Map();
const BUY_AGAIN_CACHE_TTL_MS = 30 * 1000; // 30s

function invalidateOrderMemoryCache(pathSubstring) {
  if (!pathSubstring) {
    userOrdersCache.clear();
    orderDetailCache.clear();
    buyAgainCache.clear();
    return;
  }
  const clean = String(pathSubstring).trim();
  orderDetailCache.delete(clean);
  for (const key of userOrdersCache.keys()) {
    if (key.includes(clean)) userOrdersCache.delete(key);
  }
  buyAgainCache.delete(clean);
}

onInvalidateReadsCache(invalidateOrderMemoryCache);

function parseDelayMinutes(input, currentEta, now) {
  if (typeof input === 'number' && Number.isFinite(input)) {
    const minutes = input > 1_000_000_000_000
      ? Math.ceil((input - currentEta) / 60000)
      : Math.ceil(input);
    return minutes > 0 ? minutes : null;
  }

  const value = String(input || '').trim();
  const minuteMatch = value.match(/\+?\s*(\d+(?:\.\d+)?)\s*(?:min|mins|minutes?)\b/i) || value.match(/^\+?\s*(\d+(?:\.\d+)?)$/i);
  if (minuteMatch) {
    const minutes = Math.ceil(Number(minuteMatch[1]));
    return minutes > 0 ? minutes : null;
  }

  // Also accept a target clock time such as "Arriving by 5:30 PM". Convert it
  // to the extra time beyond the existing ETA, using the store's India timezone.
  const clockMatch = value.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!clockMatch) return null;
  let hour = Number(clockMatch[1]);
  const minute = Number(clockMatch[2]);
  const meridiem = clockMatch[3]?.toUpperCase();
  if (minute > 59 || hour > (meridiem ? 12 : 23) || hour < (meridiem ? 1 : 0)) return null;
  if (meridiem) hour = (hour % 12) + (meridiem === 'PM' ? 12 : 0);
  const dateParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(now));
  const part = (type) => Number(dateParts.find((entry) => entry.type === type)?.value);
  let target = Date.UTC(part('year'), part('month') - 1, part('day'), hour, minute) - 330 * 60000;
  const baseEta = Number.isFinite(currentEta) && currentEta > now ? currentEta : now;
  if (target <= baseEta) target += 24 * 60 * 60000;
  const delayMinutes = Math.ceil((target - baseEta) / 60000);
  return delayMinutes > 0 ? delayMinutes : null;
}

// POST /api/orders  (customer places order)
router.post(
  "/",
  authenticate,
  asyncHandler(async (req, res) => {
    const { cartItems, couponCode, address, notes, paymentMethod } = req.body;
    const idempotencyKey = req.headers["x-idempotency-key"] || null;
    if (!cartItems || !Array.isArray(cartItems) || cartItems.length === 0) {
      return res.status(422).json({ error: "cartItems is required" });
    }

    try {
      const cfgSnap = await db().collection(COLLECTIONS.CONFIG).doc("global").get();
      if (cfgSnap.exists) {
        const cfg = cfgSnap.data();
        const status = storeStatus(Date.now(), cfg);
        if (!status.isOpen) {
          return res.status(422).json({
            error: status.label || "Store is currently closed for orders. Please try again during store hours.",
            code: "STORE_CLOSED",
          });
        }
      }
    } catch (e) {
      console.warn("Store status check failed:", e.message);
    }
    const order = await placeOrder({
      userId: req.user.uid,
      cartItems,
      couponCode: couponCode || null,
      address,
      notes: notes || null,
      paymentMethod,
      idempotencyKey,
    });
    await createPayment(order.paymentMethod, order);
    await sendOwnerWhatsApp(order);
    await notifyAdminsNewOrder(order);
    invalidateReadsCache(order.id);
    if (order.userId) invalidateReadsCache(order.userId);
    res.status(201).json(order);
  })
);

// GET /api/orders  (admin — all orders, paginated, filterable by status | partner - assigned orders)
router.get(
  "/",
  authenticate,
  requireRole(ROLES.ADMIN, ROLES.PARTNER),
  asyncHandler(async (req, res) => {
    let where = [];
    if (req.user.role === ROLES.PARTNER) {
      where.push(["assignedPartnerId", "==", req.user.uid]);
      // Partners usually only want non-delivered orders, but they can filter.
      if (req.query.status) {
        where.push(["status", "==", req.query.status]);
      } else {
        // Exclude delivered/cancelled by default or just return all assigned.
        // Returning all assigned for now.
      }
    } else {
      if (req.query.status) {
        where.push(["status", "==", req.query.status]);
      }
    }

    const result = await Orders.paginate({
      where,
      orderBy: { field: "createdAt", dir: "desc" },
      limit: Number(req.query.limit) || 20,
      startAfter: req.query.cursor || null,
    });
    if (req.user.role === ROLES.PARTNER) {
      result.items = (result.items || []).filter(
        (o) => o.deliveryAcceptanceStatus !== "REJECTED"
      );
    }
    res.json(result);
  })
);

// GET /api/orders/mine  (customer order history, paginated)
router.get(
  "/mine",
  authenticate,
  asyncHandler(async (req, res) => {
    const cacheKey = `${req.user.uid}:${req.query.limit || 20}:${req.query.cursor || ''}`;
    const cached = userOrdersCache.get(cacheKey);
    if (cached && Date.now() - cached.time < USER_ORDERS_CACHE_TTL_MS) {
      return res.json(cached.data);
    }

    const result = await Orders.paginate({
      where: [["userId", "==", req.user.uid]],
      orderBy: { field: "createdAt", dir: "desc" },
      limit: Number(req.query.limit) || 20,
      startAfter: req.query.cursor || null,
    });
    // Filtered here (not in the Firestore query) — most existing orders predate the
    // hiddenFromUser field entirely, and a `where("hiddenFromUser","!=",true)` filter
    // would incorrectly exclude every doc that's missing the field outright, not just
    // ones explicitly set to true.
    result.items = result.items.filter((o) => !o.hiddenFromUser);
    userOrdersCache.set(cacheKey, { time: Date.now(), data: result });
    res.json(result);
  })
);

// Complete purchase history, independent of order-history pagination.
router.get('/buy-again', authenticate, asyncHandler(async (req, res) => {
  const cached = buyAgainCache.get(req.user.uid);
  if (cached && Date.now() - cached.time < BUY_AGAIN_CACHE_TTL_MS) {
    return res.json(cached.data);
  }

  const { boughtProducts } = require('../services/customerFeatures');
  const { Products } = require('../models');
  const snap = await db().collection(COLLECTIONS.ORDERS).where('userId', '==', req.user.uid).get();
  const rawOrders = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  const validOrders = rawOrders
    .filter(order => !order.hiddenFromUser && order.status !== 'CANCELLED' && order.status !== 'PAYMENT_FAILED')
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const history = boughtProducts(validOrders);
  const productIds = [...new Set([
    ...history.map(item => item.productId),
    ...validOrders.slice(0, 8).flatMap(o => (o.items || []).map(i => i.productId)),
  ])];

  const catSnap = await db().collection(COLLECTIONS.CATEGORIES).get();
  const catMap = new Map();
  catSnap.docs.forEach(d => catMap.set(d.id, d.data().name));

  const current = new Map();
  // Bound concurrent Firestore reads for accounts with a large purchase history.
  for (let i = 0; i < productIds.length; i += 20) {
    await Promise.all(productIds.slice(i, i + 20).map(async id => {
      const prod = await Products.findById(id);
      if (prod) {
        if (prod.categoryId && catMap.has(prod.categoryId)) {
          prod.categoryName = catMap.get(prod.categoryId);
          prod.category = prod.categoryName;
        }
        current.set(id, prod);
      }
    }));
  }

  // Build lookup map of catalog products by name for fallback matching
  const nameToProd = new Map();
  for (const prod of current.values()) {
    if (prod && prod.name) {
      nameToProd.set(prod.name.trim().toLowerCase(), prod);
    }
  }

  const resolveProduct = (productId, name, fallbackItem = {}) => {
    if (productId && current.has(productId)) {
      return current.get(productId);
    }
    const cleanName = (name || '').trim().toLowerCase();
    if (cleanName && nameToProd.has(cleanName)) {
      return nameToProd.get(cleanName);
    }
    // Fallback product constructed from purchase record so items are never lost
    return {
      id: productId || `fallback-${cleanName || 'item'}`,
      name: name || fallbackItem.name || fallbackItem.productName || 'Grocery Item',
      images: fallbackItem.images || (fallbackItem.image ? [fallbackItem.image] : []),
      variants: [{
        id: fallbackItem.variantId || 'default',
        label: fallbackItem.variantLabel || '1 Unit',
        price: fallbackItem.lastPrice ?? fallbackItem.price ?? 0,
        offerPrice: fallbackItem.lastPrice ?? fallbackItem.price ?? 0,
        stock: 0,
      }],
      categoryName: fallbackItem.categoryName || 'Other',
      category: fallbackItem.categoryName || 'Other',
      isUnavailable: true,
    };
  };

  const recentOrders = validOrders.slice(0, 8).map(order => ({
    id: order.id,
    orderNo: order.orderNo || order.id.slice(-5),
    createdAt: order.createdAt,
    total: order.total || order.totalAmount || order.pricing?.total || 0,
    items: (order.items || []).map(it => {
      const p = resolveProduct(it.productId, it.productName || it.name, it);
      return {
        ...it,
        productName: it.productName || it.name || p?.name || 'Item',
        images: (it.images && it.images.length > 0) ? it.images : (p?.images || []),
        product: p,
      };
    }),
  }));

  const items = history.map(item => {
    const p = resolveProduct(item.productId, item.name, item);
    return {
      ...item,
      product: p,
    };
  });

  const buyAgainData = {
    items,
    recentOrders,
    totalOrdersCount: validOrders.length,
  };
  buyAgainCache.set(req.user.uid, { time: Date.now(), data: buyAgainData });
  res.json(buyAgainData);
}));

router.patch('/:id/ratings', authenticate, asyncHandler(async (req, res) => {
  const { validateOrderRatings } = require('../services/customerFeatures');
  const now = Date.now();
  const foundOrder = await findOrderByIdOrOrderNo(req.params.id);
  if (!foundOrder) {
    return res.status(404).json({ error: "Order not found" });
  }
  const targetRef = db().collection(COLLECTIONS.ORDERS).doc(foundOrder.id);

  const result = await db().runTransaction(async tx => {
    const snap = await tx.get(targetRef);
    const orderData = snap.exists ? snap.data() : null;
    const value = validateOrderRatings(orderData, req.user.uid, req.body, req.user.role);
    const ratings = { ...value, ratedAt: now };
    const updatePayload = {
      ratings,
      deliveryRating: value.orderRating || null,
      deliveryReview: value.review || null,
      rating: value.orderRating || null,
      updatedAt: now,
    };
    if (orderData && (orderData.status === ORDER_STATUS.PENDING_CONFIRMATION || orderData.status === ORDER_STATUS.OUT_FOR_DELIVERY || orderData.status === ORDER_STATUS.DISPATCHED)) {
      updatePayload.status = ORDER_STATUS.DELIVERED;
      updatePayload.confirmedAt = now;
      updatePayload.statusHistory = [...(orderData.statusHistory || []), { status: ORDER_STATUS.DELIVERED, at: now, note: "Confirmed & rated by customer" }];
      const inc = require("firebase-admin").firestore.FieldValue.increment;
      const dayId = require("dayjs")(orderData.createdAt).format("YYYY-MM-DD");
      const dayRef = db().collection(COLLECTIONS.METRICS).doc("daily").collection("days").doc(dayId);
      tx.set(dayRef, { delivered: inc(1), pending: inc(-1), updatedAt: now }, { merge: true });
    }
    tx.update(targetRef, updatePayload);
    return ratings;
  });
  invalidateReadsCache(targetRef.id);
  if (foundOrder.userId) invalidateReadsCache(foundOrder.userId);
  res.json(result);
}));

// Helper to robustly find order by doc ID, numeric orderNo, or string orderNo
async function findOrderByIdOrOrderNo(idOrNo) {
  if (!idOrNo || idOrNo === "undefined" || idOrNo === "null") return null;
  const cleanId = String(idOrNo).trim();
  try {
    const order = await Orders.findById(cleanId);
    if (order) return order;
  } catch (_) {}

  try {
    const num = Number(cleanId);
    if (!isNaN(num) && num > 0) {
      const snap = await db().collection(COLLECTIONS.ORDERS).where("orderNo", "==", num).limit(1).get();
      if (!snap.empty) {
        return { id: snap.docs[0].id, ...snap.docs[0].data() };
      }
    }
    const strSnap = await db().collection(COLLECTIONS.ORDERS).where("orderNo", "==", cleanId).limit(1).get();
    if (!strSnap.empty) {
      return { id: strSnap.docs[0].id, ...strSnap.docs[0].data() };
    }
  } catch (_) {}

  return null;
}

// PATCH /api/orders/:id/instructions  (customer updates delivery instructions)
router.patch(
  "/:id/instructions",
  authenticate,
  asyncHandler(async (req, res) => {
    const order = await findOrderByIdOrOrderNo(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.userId !== req.user.uid && req.user.role !== ROLES.ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const { deliveryInstructions } = req.body;
    const updated = await Orders.update(order.id, {
      deliveryInstructions,
      updatedAt: Date.now(),
    });
    invalidateReadsCache(order.id);
    res.json(updated);
  })
);

// GET /api/orders/:id  (customer own | admin | partner assigned)
router.get(
  "/:id",
  authenticate,
  asyncHandler(async (req, res) => {
    const cacheKey = `${req.params.id}:${req.user.uid}`;
    const cached = orderDetailCache.get(cacheKey);
    if (cached && Date.now() - cached.time < ORDER_DETAIL_CACHE_TTL_MS) {
      return res.json(cached.data);
    }

    const order = await findOrderByIdOrOrderNo(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    const isAdmin = req.user.role === ROLES.ADMIN;
    const isOwner = order.userId === req.user.uid;
    const isAssignedPartner =
      req.user.role === ROLES.PARTNER && order.assignedPartnerId === req.user.uid;
    if (!isAdmin && !isOwner && !isAssignedPartner) {
      return res.status(403).json({ error: "Forbidden" });
    }
    // If a delivery partner is assigned, ensure partner name, contact info, and live coordinates are attached for customer tracking
    if (order.assignedPartnerId) {
      try {
        const p = await DeliveryPartners.findById(order.assignedPartnerId);
        if (p) {
          order.deliveryBoyName = order.deliveryBoyName || p.name || "";
          order.deliveryBoyPhone = order.deliveryBoyPhone || p.phone || p.mobile || "";
          order.deliveryPartner = order.deliveryPartner || {
            id: order.assignedPartnerId,
            name: p.name || "",
            phone: p.phone || p.mobile || "",
          };
          const pLoc = p.currentLocation || p.location || p.lastLocation;
          if (pLoc && Number.isFinite(Number(pLoc.lat)) && Number.isFinite(Number(pLoc.lng))) {
            order.partnerLocation = {
              lat: Number(pLoc.lat),
              lng: Number(pLoc.lng),
              updatedAt: pLoc.updatedAt || p.lastSyncedAt || Date.now(),
            };
          }
        }
      } catch (_) {}
    }
    orderDetailCache.set(cacheKey, { time: Date.now(), data: order });
    res.json(order);
  })
);

// PATCH /api/orders/:id/status  (admin/partner advance status)
router.patch(
  "/:id/status",
  authenticate,
  requireRole(ROLES.ADMIN, ROLES.PARTNER),
  asyncHandler(async (req, res) => {
    if (!req.body.status) return res.status(422).json({ error: "status is required" });
    const result = await updateStatus(req.params.id, req.body.status, req.user);
    res.json(result);
  })
);

// PATCH /api/orders/:id/confirm-delivery  (customer confirms delivery and adds rating)
router.patch(
  "/:id/confirm-delivery",
  authenticate,
  asyncHandler(async (req, res) => {
    const { rating, review, ratings } = req.body;
    const result = await confirmDelivery(req.params.id, req.user.uid, rating, review, ratings || req.body);
    res.json(result);
  })
);

// PATCH /api/orders/:id/dispute-delivery  (customer disputes delivery)
router.patch(
  "/:id/dispute-delivery",
  authenticate,
  asyncHandler(async (req, res) => {
    const result = await disputeDelivery(req.params.id, req.user.uid);
    res.json(result);
  })
);

// PATCH /api/orders/:id/payment-claimed  (customer confirms they paid via UPI)
router.patch(
  "/:id/payment-claimed",
  authenticate,
  asyncHandler(async (req, res) => {
    const result = await markPaymentClaimed(req.params.id, req.user.uid);
    res.json(result);
  })
);

// PATCH /api/orders/:id/mark-paid  (admin confirms a UPI payment actually landed)
router.patch(
  "/:id/mark-paid",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const result = await markPaid(req.params.id);
    invalidateReadsCache(req.params.id);
    res.json(result);
  })
);

// PATCH /api/orders/:id/reject-payment  (admin rejects a manually-claimed UPI payment)
router.patch(
  "/:id/reject-payment",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const { reason, customReason } = req.body;
    if (!reason) return res.status(422).json({ error: "reason is required" });
    const result = await rejectPayment(req.params.id, reason, customReason);
    invalidateReadsCache(req.params.id);
    res.json(result);
  })
);

// PATCH /api/orders/:id/cancel  (customer cancels own order before PACKING)
router.patch(
  "/:id/cancel",
  authenticate,
  asyncHandler(async (req, res) => {
    const order = await findOrderByIdOrOrderNo(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.userId !== req.user.uid && req.user.role !== ROLES.ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const nonCancellable = [ORDER_STATUS.DELIVERED, ORDER_STATUS.CANCELLED];
    if (nonCancellable.includes(order.status)) {
      return res.status(422).json({ error: "Order cannot be cancelled at this stage", code: "CANNOT_CANCEL" });
    }
    const result = await updateStatus(order.id, ORDER_STATUS.CANCELLED);

    // Create refund record if one doesn't exist already
    try {
      const existingRef = await db()
        .collection(COLLECTIONS.REFUNDS)
        .where("orderId", "==", order.id)
        .limit(1)
        .get();

      if (existingRef.empty) {
        const now = Date.now();
        await db().collection(COLLECTIONS.REFUNDS).add({
          orderId: req.params.id,
          orderNo: order.orderNo || "N/A",
          userId: order.userId,
          userName: order.userName || "Customer",
          userEmail: order.userEmail || "",
          userPhone: order.userPhone || "",
          address: order.address || null,
          items: order.items || [],
          totalRefund: Number(order.total || order.totalAmount || 0),
          refundTo: order.paymentMethod === "COD" ? "Cash / UPI" : "UPI app",
          refundReference: `REF-${order.orderNo || Date.now()}`,
          reason: req.body.reason || "Order cancelled",
          status: REFUND_STATUS.PENDING_APPROVAL,
          timeline: [
            { step: "ORDER_CANCELLED", label: "Order cancelled", at: now, completed: true },
            { step: "REFUND_INITIATED", label: "Refund Initiated", at: now, completed: true },
            { step: "ADMIN_APPROVAL", label: "Admin approval", at: null, completed: false, current: true, note: "Shop owner reviewing case" },
            { step: "MONEY_RECEIVED", label: "Money received", at: null, completed: false, note: "Awaiting shop approval" },
          ],
          rejectReason: null,
          dismissedByUser: false,
          createdAt: now,
          updatedAt: now,
        });
      }
    } catch (refundErr) {
      console.error("[Orders] Failed to create auto-refund:", refundErr);
    }

    res.json(result);
  })
);

// PATCH /api/orders/:id/hide  (customer removes an order from their own order-history list)
router.patch(
  "/:id/hide",
  authenticate,
  asyncHandler(async (req, res) => {
    const result = await hideOrderForUser(req.params.id, req.user.uid);
    res.json(result);
  })
);

// PATCH /api/orders/:id/assign  (admin assigns delivery partner)
router.patch(
  "/:id/assign",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const order = await findOrderByIdOrOrderNo(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.status === ORDER_STATUS.DELIVERED || order.status === ORDER_STATUS.CANCELLED) {
      return res.status(422).json({
        error: `Order #${order.orderNo || req.params.id} is closed (${order.status}) and cannot be edited.`,
        code: "ORDER_CLOSED",
      });
    }
    // partnerId can be empty string/null to unassign
    const partnerId = req.body.partnerId || null;
    let partnerData = null;
    if (partnerId) {
      const p = await DeliveryPartners.findById(partnerId);
      if (!p) {
        return res.status(404).json({ error: "Delivery partner not found" });
      }
      // Verify partner is ON DUTY
      if (p.isOnDuty === false || p.isActive === false) {
        return res.status(422).json({
          error: `${p.name || "Delivery partner"} is currently off duty and cannot receive orders at real time.`,
          code: "PARTNER_OFF_DUTY",
        });
      }
      partnerData = {
        id: partnerId,
        name: p.name || "",
        phone: p.phone || p.mobile || "",
      };
    }
    const updatePayload = {
      assignedPartnerId: partnerId,
      deliveryPartner: partnerData,
      deliveryBoyName: partnerData ? partnerData.name : null,
      deliveryBoyPhone: partnerData ? partnerData.phone : null,
      deliveryAcceptanceStatus: partnerId ? "PENDING" : null,
      rejectedByPartnerId: null,
      rejectedByPartnerName: null,
      updatedAt: Date.now(),
    };
    const updated = await Orders.update(order.id, updatePayload);
    invalidateReadsCache(order.id);
    if (order.userId) invalidateReadsCache(order.userId);
    invalidateReadsCache("orders");

    if (partnerId) {
      notifyUser(
        partnerId,
        "New Delivery Assigned",
        `Order #${order.orderNo || order.id.slice(-4)} has been assigned to you. Open app to accept or reject.`,
        { type: "ORDER_ASSIGNED", orderId: order.id }
      ).catch((e) => console.error(e));
    }

    if (order.userId && partnerData) {
      notifyUser(
        order.userId,
        "Delivery Partner Assigned",
        `${partnerData.name} has been assigned to deliver your order #${order.orderNo || order.id.slice(-4)}.`,
        { type: "PARTNER_ASSIGNED", orderId: order.id }
      ).catch((e) => console.error(e));
    }

    res.json(updated);
  })
);

// PATCH /api/orders/:id/accept-assignment (delivery partner accepts assigned order)
router.patch(
  "/:id/accept-assignment",
  authenticate,
  requireRole(ROLES.PARTNER, ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const order = await findOrderByIdOrOrderNo(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (req.user.role === ROLES.PARTNER && order.assignedPartnerId !== req.user.uid) {
      return res.status(403).json({ error: "Forbidden: Order not assigned to you" });
    }

    try {
      const cfgSnap = await db().collection(COLLECTIONS.CONFIG).doc("global").get();
      if (cfgSnap.exists) {
        const cfg = cfgSnap.data();
        const status = storeStatus(Date.now(), cfg);
        if (!status.isOpen) {
          return res.status(422).json({
            error: "Shop is currently closed. Delivery partners cannot accept new orders while the shop is closed.",
            code: "STORE_CLOSED",
          });
        }
      }
    } catch (e) {
      console.warn("Store status check failed:", e.message);
    }
    const now = Date.now();
    const updatePayload = {
      deliveryAcceptanceStatus: "ACCEPTED",
      status: ORDER_STATUS.OUT_FOR_DELIVERY,
      outForDeliveryAt: now,
      estimatedDeliveryAt: Number.isFinite(Number(order.distanceKm)) && Number(order.distanceKm) > 0
        ? now + (Math.ceil(Math.max(2, Math.min(180, Number(order.distanceKm) * 1.3 / 20 * 60)) + (Number(order.deliveryDelayMinutes) || 0)) * 60000)
        : null,
      statusHistory: [
        ...(order.statusHistory || []),
        { status: ORDER_STATUS.OUT_FOR_DELIVERY, at: now, note: "Partner accepted delivery" },
      ],
      updatedAt: now,
    };
    const updated = await Orders.update(order.id, updatePayload);
    invalidateReadsCache(order.id);

    // Update partner status in deliveryPartners collection
    if (order.assignedPartnerId) {
      try {
        await DeliveryPartners.update(order.assignedPartnerId, {
          status: "on_delivery",
          lastAssignedOrder: order.id,
          updatedAt: now,
        });
        invalidateReadsCache(`deliveryPartners/${order.assignedPartnerId}`);
      } catch (err) {
        console.warn("Could not update deliveryPartner doc status:", err.message);
      }
    }

    // Notify customer that delivery boy is on the way
    notifyUser(
      order.userId,
      "Order on the way!",
      `Your order #${order.orderNo} has been accepted by ${order.deliveryBoyName || "your delivery partner"} and is on its way.`,
      { type: "ORDER_STATUS", status: ORDER_STATUS.OUT_FOR_DELIVERY, orderId: order.id }
    ).catch((e) => console.error(e));

    res.json(updated);
  })
);

// PATCH /api/orders/:id/reject-assignment (delivery partner rejects assigned order)
router.patch(
  "/:id/reject-assignment",
  authenticate,
  requireRole(ROLES.PARTNER, ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const order = await findOrderByIdOrOrderNo(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (req.user.role === ROLES.PARTNER && order.assignedPartnerId !== req.user.uid) {
      return res.status(403).json({ error: "Forbidden: Order not assigned to you" });
    }
    const now = Date.now();
    const rejectedPartnerId = order.assignedPartnerId;
    const rejectedPartnerName = order.deliveryBoyName || order.deliveryPartner?.name || "";
    const updatePayload = {
      deliveryAcceptanceStatus: "REJECTED",
      rejectedByPartnerId: rejectedPartnerId,
      rejectedByPartnerName: rejectedPartnerName,
      statusHistory: [
        ...(order.statusHistory || []),
        {
          status: order.status,
          at: now,
          note: `Delivery assignment rejected by ${rejectedPartnerName || "partner"}`,
        },
      ],
      updatedAt: now,
    };
    const updated = await Orders.update(order.id, updatePayload);
    invalidateReadsCache(order.id);
    res.json(updated);
  })
);

// PATCH /api/orders/:id/delivery-delay (delivery partner reports delay with reason & new delivery time)
router.patch(
  "/:id/delivery-delay",
  authenticate,
  requireRole(ROLES.PARTNER, ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const { newEstimatedTime, delayReason } = req.body;
    if (!newEstimatedTime || !delayReason || !String(delayReason).trim()) {
      return res.status(422).json({
        error: "Both new delivery time and delay reason are mandatory.",
      });
    }

    const order = await findOrderByIdOrOrderNo(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (req.user.role === ROLES.PARTNER && order.assignedPartnerId !== req.user.uid) {
      return res.status(403).json({ error: "Forbidden: Order not assigned to you" });
    }

    const cleanReason = String(delayReason).trim();
    const now = Date.now();

    // Reported time is an added delay, not a replacement countdown. Add it to
    // the current ETA and retain the accumulated delay for future GPS updates.
    const previousEta = Number(order.estimatedDeliveryAt);
    const baseEta = Number.isFinite(previousEta) && previousEta > now ? previousEta : now;
    const addedDelayMinutes = parseDelayMinutes(newEstimatedTime, baseEta, now);
    if (!addedDelayMinutes) {
      return res.status(422).json({ error: 'Enter a positive delay in minutes or a later clock time.' });
    }
    const newEtaTimestamp = baseEta + addedDelayMinutes * 60000;
    const previousDelayMinutes = Number(order.deliveryDelayMinutes ?? order.deliveryDelay?.totalDelayMinutes) || 0;
    const totalDelayMinutes = previousDelayMinutes + addedDelayMinutes;
    const liveEtaLabel = `~${Math.max(1, Math.ceil((newEtaTimestamp - now) / 60000))} mins`;

    const updatedBy = req.user.role === ROLES.ADMIN ? "Store Admin" : "Delivery Partner";
    const displayOrderNo = order.orderNo || order.displayId || (order.id ? order.id.slice(-4) : "---");

    const updatePayload = {
      delayReason: cleanReason,
      delayReportedAt: now,
      deliveryDelay: {
        newEstimatedTime: liveEtaLabel,
        reportedDelayMinutes: addedDelayMinutes,
        totalDelayMinutes,
        delayReason: cleanReason,
        reportedAt: now,
        reportedBy: updatedBy,
      },
      deliveryDelayMinutes: totalDelayMinutes,
      estimatedDeliveryAt: newEtaTimestamp,
      updatedAt: now,
    };

    const updated = await Orders.update(order.id, updatePayload);
    invalidateReadsCache(order.id);

    // 1. Send the customer email from the backend in both local and production builds.
    const validEmail = (value) => {
      const email = String(value || '').trim();
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
    };
    let targetEmail = [order.userEmail, order.email, order.addressSnapshot?.email]
      .map(validEmail)
      .find(Boolean) || null;
    let targetName = order.userName || order.name || order.addressSnapshot?.name || "Customer";
    if (!targetEmail && order.userId) {
      try {
        const uSnap = await db().collection(COLLECTIONS.USERS).doc(order.userId).get();
        if (uSnap.exists) {
          const uData = uSnap.data();
          targetEmail = validEmail(uData.email) || validEmail(uData.userEmail);
          if ((!order.userName || order.userName === "Customer") && uData.name) {
            targetName = uData.name;
          }
        }
      } catch (e) {
        console.error("Could not fetch user email for delay notification:", e);
      }
    }

    if (!targetEmail && order.userId) {
      try {
        const authUser = await authAdmin().getUser(order.userId);
        targetEmail = validEmail(authUser.email);
        if ((!order.userName || order.userName === "Customer") && authUser.displayName) {
          targetName = authUser.displayName;
        }
      } catch (e) {
        console.error("Could not fetch auth email for delivery delay notification:", e?.message || e);
      }
    }

    let emailStatus = 'FAILED';
    let emailError = 'Customer email address is unavailable.';
    let emailNotificationId = null;
    if (targetEmail) {
      try {
        emailNotificationId = await enqueueDeliveryDelayEmail({
          orderId: order.id,
          to: targetEmail,
          orderNo: displayOrderNo,
          customerName: targetName,
          newEstimatedTime: liveEtaLabel,
          delayReason: cleanReason,
          updatedBy,
        });
        emailStatus = 'PENDING';
        emailError = null;
        await db().collection(COLLECTIONS.ORDERS).doc(order.id).update({
          'deliveryDelay.emailStatus': emailStatus,
          'deliveryDelay.emailNotificationId': emailNotificationId,
          'deliveryDelay.emailError': null,
        });
        processDeliveryDelayEmail(emailNotificationId).catch((err) => {
          console.error('Immediate delivery delay email attempt failed:', err?.message || err);
        });
      } catch (err) {
        console.error('Could not queue delivery delay email:', err?.message || err);
        emailError = 'The delivery update was saved, but the email could not be queued.';
      }
    }
    if (emailStatus === 'FAILED') {
      await db().collection(COLLECTIONS.ORDERS).doc(order.id).update({
        'deliveryDelay.emailStatus': emailStatus,
        'deliveryDelay.emailError': emailError,
      }).catch((err) => console.warn('Could not save delay email failure status:', err?.message || err));
      console.error('Delivery delay email unavailable:', emailError);
    }

    // 2. Real-time in-app notification & push to customer
    notifyUser(
      order.userId,
      `Delivery Update: Order #${displayOrderNo}`,
      `Your order is delayed due to: ${cleanReason}. Updated ETA: ${liveEtaLabel}. Additional delay: ${addedDelayMinutes} minutes.`,
      {
        type: "DELIVERY_DELAY",
        orderId: req.params.id,
        orderNo: displayOrderNo,
        delayReason: cleanReason,
        newEstimatedTime: liveEtaLabel,
      }
    ).catch((err) => console.error("Delay notifyUser error:", err));

    res.json({
      ...updated,
      deliveryDelay: { ...updated.deliveryDelay, emailStatus, emailNotificationId },
      emailSent: false,
      emailQueued: emailStatus === 'PENDING',
      emailStatus,
      emailError: emailStatus === 'FAILED' ? emailError : undefined,
    });
  })
);

module.exports = router;
