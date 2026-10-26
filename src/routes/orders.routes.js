const express = require("express");
const { asyncHandler } = require("../middleware/error");
const { authenticate, requireRole } = require("../middleware/auth");
const { placeOrder, updateStatus, markPaymentClaimed, markPaid, rejectPayment, hideOrderForUser, confirmDelivery, disputeDelivery } = require("../services/orderService");
const { createPayment } = require("../services/paymentService");
const { sendOwnerWhatsApp, notifyAdminsNewOrder, notifyUser } = require("../services/notificationService");
const { Orders, DeliveryPartners, Users } = require("../models");
const { db } = require("../config/firebase");
const { ROLES, ORDER_STATUS, COLLECTIONS, REFUND_STATUS } = require("../config/constants");
const { invalidateReadsCache } = require("./reads.routes");

const router = express.Router();

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
    res.json(result);
  })
);

// Complete purchase history, independent of order-history pagination.
router.get('/buy-again', authenticate, asyncHandler(async (req, res) => {
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

  res.json({
    items,
    recentOrders,
    totalOrdersCount: validOrders.length,
  });
}));

router.patch('/:id/ratings', authenticate, asyncHandler(async (req, res) => {
  const { validateOrderRatings } = require('../services/customerFeatures');
  const now = Date.now();
  let targetRef = db().collection(COLLECTIONS.ORDERS).doc(req.params.id);
  const snapCheck = await targetRef.get();
  if (!snapCheck.exists) {
    const byNo = await db()
      .collection(COLLECTIONS.ORDERS)
      .where("orderNo", "==", Number(req.params.id) || req.params.id)
      .limit(1)
      .get();
    if (!byNo.empty) {
      targetRef = byNo.docs[0].ref;
    }
  }

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
  res.json(result);
}));

// PATCH /api/orders/:id/instructions  (customer updates delivery instructions)
router.patch(
  "/:id/instructions",
  authenticate,
  asyncHandler(async (req, res) => {
    const order = await Orders.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.userId !== req.user.uid && req.user.role !== ROLES.ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const { deliveryInstructions } = req.body;
    const updated = await Orders.update(req.params.id, {
      deliveryInstructions,
      updatedAt: Date.now(),
    });
    invalidateReadsCache(req.params.id);
    res.json(updated);
  })
);

// GET /api/orders/:id  (customer own | admin | partner assigned)
router.get(
  "/:id",
  authenticate,
  asyncHandler(async (req, res) => {
    const order = await Orders.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    const isAdmin = req.user.role === ROLES.ADMIN;
    const isOwner = order.userId === req.user.uid;
    const isAssignedPartner =
      req.user.role === ROLES.PARTNER && order.assignedPartnerId === req.user.uid;
    if (!isAdmin && !isOwner && !isAssignedPartner) {
      return res.status(403).json({ error: "Forbidden" });
    }
    // If a delivery partner is assigned, ensure partner name and contact info are attached for customer tracking
    if (order.assignedPartnerId && (!order.deliveryBoyName || !order.deliveryBoyPhone || !order.deliveryPartner)) {
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
        }
      } catch (_) {}
    }
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
    const order = await Orders.get(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.userId !== req.user.uid && req.user.role !== ROLES.ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const nonCancellable = [ORDER_STATUS.DELIVERED, ORDER_STATUS.CANCELLED];
    if (nonCancellable.includes(order.status)) {
      return res.status(422).json({ error: "Order cannot be cancelled at this stage", code: "CANNOT_CANCEL" });
    }
    const result = await updateStatus(req.params.id, ORDER_STATUS.CANCELLED);

    // Create refund record if one doesn't exist already
    try {
      const existingRef = await db()
        .collection(COLLECTIONS.REFUNDS)
        .where("orderId", "==", req.params.id)
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
    const order = await Orders.findById(req.params.id);
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
    const updated = await Orders.update(req.params.id, updatePayload);
    invalidateReadsCache(req.params.id);

    if (partnerId) {
      notifyUser(
        partnerId,
        "New Delivery Assigned",
        `Order #${order.orderNo || req.params.id.slice(-4)} has been assigned to you. Open app to accept or reject.`,
        { type: "ORDER_ASSIGNED", orderId: req.params.id }
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
    const order = await Orders.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (req.user.role === ROLES.PARTNER && order.assignedPartnerId !== req.user.uid) {
      return res.status(403).json({ error: "Forbidden: Order not assigned to you" });
    }
    const now = Date.now();
    const updatePayload = {
      deliveryAcceptanceStatus: "ACCEPTED",
      status: ORDER_STATUS.OUT_FOR_DELIVERY,
      statusHistory: [
        ...(order.statusHistory || []),
        { status: ORDER_STATUS.OUT_FOR_DELIVERY, at: now, note: "Partner accepted delivery" },
      ],
      updatedAt: now,
    };
    const updated = await Orders.update(req.params.id, updatePayload);
    invalidateReadsCache(req.params.id);

    // Notify customer that delivery boy is on the way
    notifyUser(
      order.userId,
      "Order on the way!",
      `Your order #${order.orderNo} has been accepted by ${order.deliveryBoyName || "your delivery partner"} and is on its way.`,
      { type: "ORDER_STATUS", status: ORDER_STATUS.OUT_FOR_DELIVERY, orderId: req.params.id }
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
    const order = await Orders.findById(req.params.id);
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
    const updated = await Orders.update(req.params.id, updatePayload);
    invalidateReadsCache(req.params.id);
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

    const order = await Orders.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (req.user.role === ROLES.PARTNER && order.assignedPartnerId !== req.user.uid) {
      return res.status(403).json({ error: "Forbidden: Order not assigned to you" });
    }

    const cleanReason = String(delayReason).trim();
    const now = Date.now();

    // Parse new estimated time if possible into timestamp, or keep string
    let newEtaTimestamp = now + 30 * 60000;
    if (typeof newEstimatedTime === "number") {
      newEtaTimestamp = newEstimatedTime;
    } else if (typeof newEstimatedTime === "string") {
      const matchMins = newEstimatedTime.match(/(\d+)\s*min/i);
      if (matchMins) {
        newEtaTimestamp = now + parseInt(matchMins[1], 10) * 60000;
      }
    }

    const updatedBy = req.user.role === ROLES.ADMIN ? "Store Admin" : "Delivery Partner";
    const displayOrderNo = order.orderNo || order.displayId || (req.params.id ? req.params.id.slice(-4) : "---");

    const updatePayload = {
      delayReason: cleanReason,
      delayReportedAt: now,
      deliveryDelay: {
        newEstimatedTime: String(newEstimatedTime),
        delayReason: cleanReason,
        reportedAt: now,
        reportedBy: updatedBy,
      },
      estimatedDeliveryAt: newEtaTimestamp,
      updatedAt: now,
    };

    const updated = await Orders.update(req.params.id, updatePayload);
    invalidateReadsCache(req.params.id);

    // 1. Auto-shoot email to customer (mandatory default task)
    const { sendDeliveryDelayEmail } = require("../services/emailService");
    let targetEmail = order.userEmail || order.email || order.addressSnapshot?.email;
    let targetName = order.userName || order.name || order.addressSnapshot?.name || "Customer";
    if (!targetEmail && order.userId) {
      try {
        const uSnap = await db().collection(COLLECTIONS.USERS).doc(order.userId).get();
        if (uSnap.exists) {
          const uData = uSnap.data();
          targetEmail = uData.email || uData.userEmail;
          if ((!order.userName || order.userName === "Customer") && uData.name) {
            targetName = uData.name;
          }
        }
      } catch (e) {
        console.error("Could not fetch user email for delay notification:", e);
      }
    }

    if (targetEmail) {
      sendDeliveryDelayEmail(targetEmail, {
        orderNo: displayOrderNo,
        customerName: targetName,
        newEstimatedTime: String(newEstimatedTime),
        delayReason: cleanReason,
        updatedBy,
      }).catch((err) => console.error("Auto delay email failed:", err));
    }

    // 2. Real-time in-app notification & push to customer
    notifyUser(
      order.userId,
      `Delivery Update: Order #${displayOrderNo}`,
      `Your order is delayed due to: ${cleanReason}. Expected delivery: ${newEstimatedTime}.`,
      {
        type: "DELIVERY_DELAY",
        orderId: req.params.id,
        orderNo: displayOrderNo,
        delayReason: cleanReason,
        newEstimatedTime: String(newEstimatedTime),
      }
    ).catch((err) => console.error("Delay notifyUser error:", err));

    res.json(updated);
  })
);

module.exports = router;
