const express = require("express");
const { asyncHandler } = require("../middleware/error");
const { authenticate, requireRole } = require("../middleware/auth");
const { placeOrder, updateStatus, markPaymentClaimed, markPaid, rejectPayment, hideOrderForUser, confirmDelivery, disputeDelivery } = require("../services/orderService");
const { createPayment } = require("../services/paymentService");
const { sendOwnerWhatsApp, notifyAdminsNewOrder } = require("../services/notificationService");
const { Orders, DeliveryPartners } = require("../models");
const { db } = require("../config/firebase");
const { ROLES, ORDER_STATUS, COLLECTIONS, REFUND_STATUS } = require("../config/constants");

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
  const ref = db().collection(COLLECTIONS.ORDERS).doc(req.params.id);
  const result = await db().runTransaction(async tx => {
    const snap = await tx.get(ref);
    const value = validateOrderRatings(snap.exists ? snap.data() : null, req.user.uid, req.body);
    const ratings = { ...value, ratedAt: Date.now() };
    tx.update(ref, { ratings, updatedAt: Date.now() });
    return ratings;
  });
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
    const { rating, review } = req.body;
    const result = await confirmDelivery(req.params.id, req.user.uid, rating, review);
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
      try {
        const p = await DeliveryPartners.findById(partnerId);
        if (p) {
          partnerData = {
            id: partnerId,
            name: p.name || "",
            phone: p.phone || p.mobile || "",
          };
        }
      } catch (_) {}
    }
    const updatePayload = {
      assignedPartnerId: partnerId,
      deliveryPartner: partnerData,
      deliveryBoyName: partnerData ? partnerData.name : null,
      deliveryBoyPhone: partnerData ? partnerData.phone : null,
      updatedAt: Date.now(),
    };
    const updated = await Orders.update(req.params.id, updatePayload);
    res.json(updated);
  })
);

module.exports = router;
