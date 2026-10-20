const express = require("express");
const multer = require("multer");
const { asyncHandler } = require("../middleware/error");
const { authenticate, requireRole } = require("../middleware/auth");
const { db } = require("../config/firebase");
const { COLLECTIONS, ROLES, ISSUE_STATUS } = require("../config/constants");
const { notifyUser } = require("../services/notificationService");
const { upload: uploadToCloud } = require("../services/storageService");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// POST /api/issues/upload - Upload an issue photo to Cloudinary
router.post(
  "/upload",
  authenticate,
  upload.single("photo"),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No image file provided" });
    }
    const { url } = await uploadToCloud(req.file.buffer, "issues");
    res.json({ url });
  })
);

// POST /api/issues - Submit a new issue report
router.post(
  "/",
  authenticate,
  asyncHandler(async (req, res) => {
    const { orderId, affectedItems, issueType, photos, description, resolutionType } = req.body;

    if (!orderId) {
      return res.status(400).json({ error: "orderId is required" });
    }
    if (!affectedItems || !Array.isArray(affectedItems) || affectedItems.length === 0) {
      return res.status(400).json({ error: "Please select at least one affected item" });
    }
    if (!issueType) {
      return res.status(400).json({ error: "issueType is required" });
    }

    // Fetch order details
    const orderDoc = await db().collection(COLLECTIONS.ORDERS).doc(orderId).get();
    if (!orderDoc.exists) {
      return res.status(404).json({ error: "Order not found" });
    }
    const order = orderDoc.data();

    // Verify ownership
    if (order.userId !== req.user.uid && req.user.role !== ROLES.ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const now = Date.now();
    const issueData = {
      orderId,
      orderNo: order.orderNo || "N/A",
      orderDate: order.createdAt || now,
      orderTotal: Number(order.total || order.totalAmount || 0),
      userId: req.user.uid,
      userName: order.userName || req.user.name || "Customer",
      userEmail: order.userEmail || req.user.email || "",
      userPhone: order.userPhone || req.user.mobile || "",
      address: order.address || null,
      affectedItems,
      issueType,
      photos: Array.isArray(photos) ? photos : [],
      description: (description || "").trim(),
      resolutionType: resolutionType || "REFUND", // "REFUND" or "REDELIVER"
      status: ISSUE_STATUS.OPEN,
      resolutionNotes: null,
      createdAt: now,
      updatedAt: now,
    };

    const docRef = await db().collection(COLLECTIONS.ISSUES).add(issueData);
    res.status(201).json({ id: docRef.id, ...issueData });
  })
);

// GET /api/issues - List issues (all for admin, user's own for customer)
router.get(
  "/",
  authenticate,
  asyncHandler(async (req, res) => {
    let q = db().collection(COLLECTIONS.ISSUES);

    if (req.user.role !== ROLES.ADMIN) {
      q = q.where("userId", "==", req.user.uid);
    }

    const snap = await q.get();
    const issues = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    // Sort descending by createdAt
    issues.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.json({ items: issues, total: issues.length });
  })
);

// GET /api/issues/order/:orderId - List issues for a specific order
router.get(
  "/order/:orderId",
  authenticate,
  asyncHandler(async (req, res) => {
    const snap = await db()
      .collection(COLLECTIONS.ISSUES)
      .where("orderId", "==", req.params.orderId)
      .get();

    const issues = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    // Verify ownership
    if (req.user.role !== ROLES.ADMIN) {
      const forbidden = issues.some((it) => it.userId !== req.user.uid);
      if (forbidden) return res.status(403).json({ error: "Forbidden" });
    }

    res.json({ items: issues });
  })
);

// GET /api/issues/:id - Get single issue
router.get(
  "/:id",
  authenticate,
  asyncHandler(async (req, res) => {
    const doc = await db().collection(COLLECTIONS.ISSUES).doc(req.params.id).get();
    if (!doc.exists) {
      return res.status(404).json({ error: "Issue not found" });
    }
    const data = doc.data();
    if (data.userId !== req.user.uid && req.user.role !== ROLES.ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }
    res.json({ id: doc.id, ...data });
  })
);

// PATCH /api/issues/:id/status - Admin resolves or rejects an issue
router.patch(
  "/:id/status",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const { status, resolutionNotes } = req.body;
    const ref = db().collection(COLLECTIONS.ISSUES).doc(req.params.id);
    const doc = await ref.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Issue not found" });
    }

    const current = doc.data();
    const now = Date.now();
    const updated = {
      status: status || ISSUE_STATUS.RESOLVED,
      resolutionNotes: resolutionNotes || "",
      resolvedAt: now,
      updatedAt: now,
    };

    await ref.update(updated);

    // Notify user
    if (current.userId) {
      notifyUser(
        current.userId,
        status === ISSUE_STATUS.RESOLVED ? "Issue Resolved" : "Issue Update",
        `Update on your reported issue for order #${current.orderNo}: ${status}. ${resolutionNotes || ""}`,
        { type: "ISSUE", issueId: req.params.id, orderId: current.orderId }
      ).catch(() => {});
    }

    res.json({ id: req.params.id, ...current, ...updated });
  })
);

module.exports = router;
