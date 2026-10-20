const express = require("express");
const { asyncHandler } = require("../middleware/error");
const { authenticate, requireRole } = require("../middleware/auth");
const { db } = require("../config/firebase");
const { COLLECTIONS, ROLES, REFUND_STATUS } = require("../config/constants");
const { notifyUser } = require("../services/notificationService");

const router = express.Router();

// Helper to construct manual 4-step refund timeline
function buildTimeline(status = REFUND_STATUS.PENDING_APPROVAL, createdAt = Date.now(), resolvedAt = null) {
  if (status === REFUND_STATUS.REFUND_GRANTED) {
    return [
      { step: "ORDER_CANCELLED", label: "Order cancelled", at: createdAt, completed: true },
      { step: "REFUND_INITIATED", label: "Refund Initiated", at: createdAt, completed: true },
      { step: "ADMIN_APPROVAL", label: "Admin approval", at: resolvedAt || Date.now(), completed: true, note: "Approved by shop admin" },
      { step: "MONEY_RECEIVED", label: "Money received", at: resolvedAt || Date.now(), completed: true, note: "Refund granted & sent manually via UPI" }
    ];
  }
  if (status === REFUND_STATUS.REJECTED) {
    return [
      { step: "ORDER_CANCELLED", label: "Order cancelled", at: createdAt, completed: true },
      { step: "REFUND_INITIATED", label: "Refund Initiated", at: createdAt, completed: true },
      { step: "ADMIN_APPROVAL", label: "Admin approval", at: resolvedAt || Date.now(), completed: false, rejected: true, note: "Request rejected by admin" },
      { step: "MONEY_RECEIVED", label: "Money received", at: null, completed: false, note: "Case closed" }
    ];
  }
  return [
    { step: "ORDER_CANCELLED", label: "Order cancelled", at: createdAt, completed: true },
    { step: "REFUND_INITIATED", label: "Refund Initiated", at: createdAt, completed: true },
    { step: "ADMIN_APPROVAL", label: "Admin approval", at: null, completed: false, current: true, note: "Shop owner reviewing case" },
    { step: "MONEY_RECEIVED", label: "Money received", at: null, completed: false, note: "Awaiting shop approval" }
  ];
}

// POST /api/refunds - create or get refund for an order
router.post(
  "/",
  authenticate,
  asyncHandler(async (req, res) => {
    const { orderId, reason, refundTo, affectedItems, issueType, photos, description } = req.body;
    if (!orderId) {
      return res.status(400).json({ error: "orderId is required" });
    }

    // Check if refund record already exists
    const existingSnap = await db()
      .collection(COLLECTIONS.REFUNDS)
      .where("orderId", "==", orderId)
      .limit(1)
      .get();

    if (!existingSnap.empty) {
      const doc = existingSnap.docs[0];
      return res.json({ id: doc.id, ...doc.data() });
    }

    // Fetch order details
    const orderDoc = await db().collection(COLLECTIONS.ORDERS).doc(orderId).get();
    if (!orderDoc.exists) {
      return res.status(404).json({ error: "Order not found" });
    }
    const order = orderDoc.data();

    // Verify user owns order or is admin
    if (order.userId !== req.user.uid && req.user.role !== ROLES.ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const now = Date.now();
    const refundData = {
      orderId,
      orderNo: order.orderNo || "N/A",
      userId: order.userId,
      userName: order.userName || "Customer",
      userEmail: order.userEmail || "",
      userPhone: order.userPhone || "",
      address: order.address || null,
      items: (affectedItems && affectedItems.length > 0) ? affectedItems : (order.items || []),
      affectedItems: affectedItems || [],
      issueType: issueType || null,
      photos: photos || [],
      description: description || null,
      totalRefund: Number(order.total || order.totalAmount || 0),
      refundTo: refundTo || (order.paymentMethod === "COD" ? "Cash / UPI" : "UPI app"),
      refundReference: `REF-${order.orderNo || Date.now()}`,
      reason: reason || issueType || "Refund requested by customer",
      status: REFUND_STATUS.PENDING_APPROVAL,
      timeline: buildTimeline(REFUND_STATUS.PENDING_APPROVAL, now),
      rejectReason: null,
      dismissedByUser: false,
      createdAt: now,
      updatedAt: now,
    };

    const docRef = await db().collection(COLLECTIONS.REFUNDS).add(refundData);
    res.status(201).json({ id: docRef.id, ...refundData });
  })
);

// GET /api/refunds - list refunds (all for admin, own for customer)
router.get(
  "/",
  authenticate,
  asyncHandler(async (req, res) => {
    let q = db().collection(COLLECTIONS.REFUNDS);

    if (req.user.role !== ROLES.ADMIN) {
      q = q.where("userId", "==", req.user.uid);
    }

    const snap = await q.get();
    const refunds = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    // Sort descending by createdAt in memory
    refunds.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.json({ items: refunds, total: refunds.length });
  })
);

// GET /api/refunds/order/:orderId - get refund for specific order
router.get(
  "/order/:orderId",
  authenticate,
  asyncHandler(async (req, res) => {
    const snap = await db()
      .collection(COLLECTIONS.REFUNDS)
      .where("orderId", "==", req.params.orderId)
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(404).json({ error: "Refund request not found for this order" });
    }

    const doc = snap.docs[0];
    const data = doc.data();

    // Verify ownership
    if (data.userId !== req.user.uid && req.user.role !== ROLES.ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }

    res.json({ id: doc.id, ...data });
  })
);

// GET /api/refunds/:id - get refund by id
router.get(
  "/:id",
  authenticate,
  asyncHandler(async (req, res) => {
    const doc = await db().collection(COLLECTIONS.REFUNDS).doc(req.params.id).get();
    if (!doc.exists) {
      return res.status(404).json({ error: "Refund request not found" });
    }
    const data = doc.data();
    if (data.userId !== req.user.uid && req.user.role !== ROLES.ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }
    res.json({ id: doc.id, ...data });
  })
);

// PATCH /api/refunds/:id/status - Admin decision (ACCEPT / GRANT or REJECT)
router.patch(
  "/:id/status",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const { status, rejectReason } = req.body;
    const ref = db().collection(COLLECTIONS.REFUNDS).doc(req.params.id);
    const doc = await ref.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Refund request not found" });
    }

    const current = doc.data();
    const now = Date.now();

    if (status === REFUND_STATUS.REFUND_GRANTED || status === "APPROVED") {
      const finalStatus = REFUND_STATUS.REFUND_GRANTED;
      const updatedData = {
        status: finalStatus,
        timeline: buildTimeline(finalStatus, current.createdAt, now),
        resolvedAt: now,
        updatedAt: now,
      };
      await ref.update(updatedData);

      // Notify customer
      if (current.userId) {
        notifyUser(
          current.userId,
          "Refund Granted",
          `Your refund of ₹${current.totalRefund} for order #${current.orderNo} has been granted.`,
          { type: "REFUND", refundId: req.params.id, orderId: current.orderId }
        ).catch(() => {});
      }

      return res.json({ id: req.params.id, ...current, ...updatedData });
    }

    if (status === REFUND_STATUS.REJECTED) {
      const reasonText = rejectReason || "Request could not be verified";
      const updatedData = {
        status: REFUND_STATUS.REJECTED,
        rejectReason: reasonText,
        timeline: buildTimeline(REFUND_STATUS.REJECTED, current.createdAt, now),
        resolvedAt: now,
        updatedAt: now,
      };
      await ref.update(updatedData);

      // Notify customer
      if (current.userId) {
        notifyUser(
          current.userId,
          "Refund Request Update",
          `Your refund request for order #${current.orderNo} was rejected: ${reasonText}`,
          { type: "REFUND", refundId: req.params.id, orderId: current.orderId }
        ).catch(() => {});
      }

      return res.json({ id: req.params.id, ...current, ...updatedData });
    }

    return res.status(400).json({ error: "Invalid status" });
  })
);

// PATCH /api/refunds/:id/dismiss - Customer acknowledges rejection and closes case
router.patch(
  "/:id/dismiss",
  authenticate,
  asyncHandler(async (req, res) => {
    const ref = db().collection(COLLECTIONS.REFUNDS).doc(req.params.id);
    const doc = await ref.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Refund request not found" });
    }

    const current = doc.data();
    if (current.userId !== req.user.uid && req.user.role !== ROLES.ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }

    await ref.update({
      dismissedByUser: true,
      updatedAt: Date.now(),
    });

    res.json({ ok: true, dismissed: true });
  })
);

module.exports = router;
