const express = require("express");
const { asyncHandler } = require("../middleware/error");
const { authenticate, requireRole } = require("../middleware/auth");
const { placeOrder, updateStatus } = require("../services/orderService");
const { createPayment } = require("../services/paymentService");
const { sendOwnerWhatsApp } = require("../services/notificationService");
const { Orders } = require("../models");
const { ROLES, ORDER_STATUS } = require("../config/constants");

const router = express.Router();

// POST /api/orders  (customer places order)
router.post(
  "/",
  authenticate,
  asyncHandler(async (req, res) => {
    const { cartItems, couponCode, address, slot, notes, paymentMethod } = req.body;
    const idempotencyKey = req.headers["x-idempotency-key"] || null;
    if (!cartItems || !Array.isArray(cartItems) || cartItems.length === 0) {
      return res.status(422).json({ error: "cartItems is required" });
    }
    const order = await placeOrder({
      userId: req.user.uid,
      cartItems,
      couponCode: couponCode || null,
      address,
      slot,
      notes: notes || null,
      paymentMethod,
      idempotencyKey,
    });
    await createPayment(order.paymentMethod, order);
    await sendOwnerWhatsApp(order);
    res.status(201).json(order);
  })
);

// GET /api/orders  (admin — all orders, paginated, filterable by status)
router.get(
  "/",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const where = req.query.status ? [["status", "==", req.query.status]] : [];
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
    res.json(result);
  })
);

// GET /api/orders/:id  (customer own | admin | partner assigned)
router.get(
  "/:id",
  authenticate,
  asyncHandler(async (req, res) => {
    const order = await Orders.get(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    const isAdmin = req.user.role === ROLES.ADMIN;
    const isOwner = order.userId === req.user.uid;
    const isAssignedPartner =
      req.user.role === ROLES.PARTNER && order.assignedPartnerId === req.user.uid;
    if (!isAdmin && !isOwner && !isAssignedPartner) {
      return res.status(403).json({ error: "Forbidden" });
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
    const result = await updateStatus(req.params.id, req.body.status);
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
    res.json(result);
  })
);

// PATCH /api/orders/:id/assign  (admin assigns delivery partner)
router.patch(
  "/:id/assign",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    if (!req.body.partnerId) return res.status(422).json({ error: "partnerId is required" });
    const updated = await Orders.update(req.params.id, {
      assignedPartnerId: req.body.partnerId,
      updatedAt: Date.now(),
    });
    res.json(updated);
  })
);

module.exports = router;
