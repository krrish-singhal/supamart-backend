const express = require("express");
const multer = require("multer");
const { asyncHandler } = require("../middleware/error");
const { authenticate, requireRole } = require("../middleware/auth");
const { db } = require("../config/firebase");
const { COLLECTIONS, ROLES, ISSUE_STATUS, ORDER_STATUS } = require("../config/constants");
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

    // Fetch order details by doc ID or sequential orderNo
    let orderDoc = await db().collection(COLLECTIONS.ORDERS).doc(orderId).get();
    let order = orderDoc.exists ? orderDoc.data() : null;
    let actualOrderId = orderId;

    if (!order) {
      const byNo = await db()
        .collection(COLLECTIONS.ORDERS)
        .where("orderNo", "==", Number(orderId) || orderId)
        .limit(1)
        .get();
      if (!byNo.empty) {
        orderDoc = byNo.docs[0];
        order = orderDoc.data();
        actualOrderId = orderDoc.id;
      }
    }

    // Verify ownership if order exists
    if (order && String(order.userId || '') !== String(req.user.uid || '') && req.user.role !== ROLES.ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const now = Date.now();
    const issueData = {
      orderId: actualOrderId,
      orderNo: order?.orderNo || (String(orderId).length <= 6 ? String(orderId) : "N/A"),
      orderDate: order?.createdAt || now,
      orderTotal: Number(order?.total || order?.totalAmount || 0),
      userId: req.user.uid,
      userName: order?.userName || req.user.name || "Customer",
      userEmail: order?.userEmail || req.user.email || "",
      userPhone: order?.userPhone || req.user.mobile || "",
      address: order?.addressSnapshot || order?.address || null,
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

    // If customer requested a refund resolution, sync to refunds collection so refund workflow is triggered
    if (issueData.resolutionType === "REFUND") {
      try {
        const existingRefund = await db()
          .collection(COLLECTIONS.REFUNDS)
          .where("orderId", "==", actualOrderId)
          .limit(1)
          .get();
        if (existingRefund.empty) {
          const refundDoc = await db().collection(COLLECTIONS.REFUNDS).add({
            orderId: actualOrderId,
            orderNo: issueData.orderNo,
            userId: req.user.uid,
            userName: issueData.userName,
            userEmail: issueData.userEmail,
            userPhone: issueData.userPhone,
            address: issueData.address,
            items: affectedItems,
            affectedItems,
            issueType,
            photos: Array.isArray(photos) ? photos : [],
            description: (description || "").trim(),
            totalRefund: issueData.orderTotal,
            refundTo: order?.paymentMethod === "COD" ? "Cash / UPI" : "UPI app",
            refundReference: `REF-${issueData.orderNo || Date.now()}`,
            reason: issueType || "Customer reported issue",
            status: "PENDING_APPROVAL",
            issueId: docRef.id,
            timeline: [
              { step: "REFUND_INITIATED", label: "Refund Initiated", at: now, completed: true },
              { step: "ADMIN_APPROVAL", label: "Admin approval", at: null, completed: false, current: true, note: "Shop owner reviewing case" },
              { step: "MONEY_RECEIVED", label: "Money received", at: null, completed: false, note: "Awaiting shop approval" },
            ],
            rejectReason: null,
            dismissedByUser: false,
            createdAt: now,
            updatedAt: now,
          });
          await docRef.update({ refundId: refundDoc.id });
        }
      } catch (err) {
        console.error("Failed to sync refund from issue report:", err);
      }
    }

    try {
      await db().collection(COLLECTIONS.ADMIN_ALERTS || "adminAlerts").add({
        type: "ISSUE_REPORTED",
        issueId: docRef.id,
        orderId: actualOrderId,
        orderNo: issueData.orderNo || "",
        customerName: issueData.userName || "Customer",
        issueType: issueType || "Reported Issue",
        resolutionType: issueData.resolutionType,
        createdAt: now,
        read: false,
      });
    } catch (_) {}

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
    let issues = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    // For admin, also include any customer issues/problems reported via refunds or delivery disputes
    if (req.user.role === ROLES.ADMIN) {
      try {
        const existingOrderIds = new Set(issues.map((i) => i.orderId));

        // 1. Check refunds
        const refundsSnap = await db().collection(COLLECTIONS.REFUNDS).get();
        refundsSnap.docs.forEach((doc) => {
          const r = doc.data();
          if (!existingOrderIds.has(r.orderId) && (r.reason || r.issueType || (r.affectedItems && r.affectedItems.length > 0))) {
            issues.push({
              id: doc.id,
              orderId: r.orderId,
              orderNo: r.orderNo || "N/A",
              orderDate: r.createdAt || Date.now(),
              orderTotal: Number(r.totalRefund || 0),
              userId: r.userId,
              userName: r.userName || "Customer",
              userEmail: r.userEmail || "",
              userPhone: r.userPhone || "",
              address: r.address || null,
              affectedItems: r.affectedItems || r.items || [],
              issueType: r.issueType || r.reason || "Order Issue",
              photos: r.photos || [],
              description: r.description || r.reason || "Customer reported an issue with their delivery.",
              resolutionType: "REFUND",
              refundId: doc.id,
              status: r.status === "REFUND_GRANTED" ? ISSUE_STATUS.RESOLVED : (r.status === "REJECTED" ? ISSUE_STATUS.REJECTED : ISSUE_STATUS.OPEN),
              resolutionNotes: r.rejectReason || null,
              createdAt: r.createdAt || Date.now(),
              updatedAt: r.updatedAt || Date.now(),
            });
            existingOrderIds.add(r.orderId);
          }
        });

        // 2. Check disputed delivery orders
        const disputesSnap = await db()
          .collection(COLLECTIONS.ORDERS)
          .where("status", "==", ORDER_STATUS.DELIVERY_DISPUTED)
          .get();
        disputesSnap.docs.forEach((doc) => {
          const o = doc.data();
          if (!existingOrderIds.has(doc.id) && !existingOrderIds.has(o.orderNo)) {
            issues.push({
              id: `dispute_${doc.id}`,
              orderId: doc.id,
              orderNo: o.orderNo || doc.id.slice(-4),
              orderDate: o.createdAt || Date.now(),
              orderTotal: Number(o.total || o.totalAmount || 0),
              userId: o.userId,
              userName: o.userName || "Customer",
              userEmail: o.userEmail || "",
              userPhone: o.userPhone || "",
              address: o.addressSnapshot || o.address || null,
              affectedItems: o.items || [],
              issueType: "Delivery Not Received",
              photos: [],
              description: `Customer disputed delivery: Order #${o.orderNo || doc.id.slice(-4)} marked delivered by partner, but customer stated they did not receive it.`,
              resolutionType: "REFUND",
              status: o.disputeResolved ? ISSUE_STATUS.RESOLVED : ISSUE_STATUS.OPEN,
              resolutionNotes: o.disputeResolutionNotes || null,
              createdAt: o.updatedAt || o.createdAt || Date.now(),
              updatedAt: o.updatedAt || Date.now(),
            });
            existingOrderIds.add(doc.id);
          }
        });
      } catch (err) {
        console.error("Failed to aggregate refunds and disputes into issues:", err);
      }
    }

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
    const { status, resolutionNotes, resolutionType } = req.body;
    const now = Date.now();
    let ref = db().collection(COLLECTIONS.ISSUES).doc(req.params.id);
    let doc = await ref.get();

    // Handle dispute_ prefixed IDs from disputed delivery orders
    if (req.params.id.startsWith("dispute_")) {
      const orderId = req.params.id.replace("dispute_", "");
      const orderRef = db().collection(COLLECTIONS.ORDERS).doc(orderId);
      const orderSnap = await orderRef.get();
      if (orderSnap.exists) {
        await orderRef.update({
          disputeResolved: status === ISSUE_STATUS.RESOLVED || status === "RESOLVED",
          disputeResolutionNotes: resolutionNotes || "",
          updatedAt: now,
        });
        return res.json({ id: req.params.id, status: status || ISSUE_STATUS.RESOLVED, resolutionNotes });
      }
    }

    // If not found in issues, check if this is an aggregated refund item
    if (!doc.exists) {
      const refundRef = db().collection(COLLECTIONS.REFUNDS).doc(req.params.id);
      const refundDoc = await refundRef.get();
      if (refundDoc.exists) {
        const rData = refundDoc.data();
        const effectiveType = resolutionType || (status === 'REJECTED' ? 'REJECT' : 'REFUND');
        const refundStatus = effectiveType === 'REJECT' || status === 'REJECTED'
          ? "REJECTED"
          : effectiveType === 'REDELIVER'
          ? "RESOLVED_REDELIVER"
          : "REFUND_GRANTED";

        let effectiveNotes = resolutionNotes || "";
        if (effectiveType === 'REDELIVER' && (!effectiveNotes || effectiveNotes.includes('refund of ₹'))) {
          effectiveNotes = `We apologize for the inconvenience with order #${rData.orderNo || ''}. We have arranged a replacement redelivery for your reported item(s). Our delivery partner is bringing the replacement shortly.`;
        }

        const refundUpdates = {
          status: refundStatus,
          resolutionType: effectiveType,
          rejectReason: effectiveType === 'REJECT' ? effectiveNotes : null,
          resolutionNotes: effectiveNotes,
          adminMessage: effectiveNotes,
          resolvedAt: now,
          updatedAt: now,
        };

        if (effectiveType === 'REDELIVER') {
          refundUpdates.timeline = [
            { step: "ISSUE_REPORTED", label: "Issue Reported", at: rData.createdAt || now, completed: true },
            { step: "REDELIVERY_SCHEDULED", label: "Redelivery Scheduled", at: now, completed: true, note: effectiveNotes },
            { step: "OUT_FOR_DELIVERY", label: "Replacement In Progress", at: null, completed: false, current: true, note: "Delivery partner will bring replacement items" },
          ];
        }

        await refundRef.update(refundUpdates);

        if (rData.userId) {
          const notifTitle = effectiveType === 'REDELIVER'
            ? "Redelivery Arranged"
            : refundStatus === "REFUND_GRANTED"
            ? "Refund Approved"
            : "Issue Claim Update";
          const notifBody = effectiveNotes || (effectiveType === 'REDELIVER'
            ? `We have arranged a redelivery for your order #${rData.orderNo || ''}.`
            : refundStatus === "REFUND_GRANTED"
            ? `Your refund for order #${rData.orderNo || ''} has been approved.`
            : `Your claim for order #${rData.orderNo || ''} was reviewed.`);

          notifyUser(rData.userId, notifTitle, notifBody, {
            type: effectiveType === 'REDELIVER' ? "ISSUE_REDELIVER" : "REFUND",
            refundId: req.params.id,
            orderId: rData.orderId,
            orderNo: String(rData.orderNo || ''),
            resolutionType: effectiveType,
            status: refundStatus,
          }).catch(() => {});
        }

        try {
          const { invalidateReadsCache } = require("./reads.routes");
          invalidateReadsCache("issues");
          invalidateReadsCache("refunds");
          invalidateReadsCache("orders");
          if (rData.userId) invalidateReadsCache(rData.userId);
        } catch (_) {}

        return res.json({ id: req.params.id, status: status || ISSUE_STATUS.RESOLVED, resolutionNotes: effectiveNotes, resolutionType: effectiveType });
      }
      return res.status(404).json({ error: "Issue not found" });
    }

    const current = doc.data();
    const effectiveResolutionType = resolutionType || current.resolutionType || (status === 'REJECTED' ? 'REJECT' : 'REFUND');

    let effectiveNotes = resolutionNotes || current.resolutionNotes || "";
    if (effectiveResolutionType === 'REDELIVER' && (!effectiveNotes || effectiveNotes.includes('refund of ₹'))) {
      effectiveNotes = `We apologize for the inconvenience with order #${current.orderNo || ''}. We have arranged a replacement redelivery for your reported item(s). Our delivery partner is bringing the replacement shortly.`;
    }

    const updated = {
      status: status || (effectiveResolutionType === 'REJECT' ? ISSUE_STATUS.REJECTED : ISSUE_STATUS.RESOLVED),
      resolutionType: effectiveResolutionType,
      resolutionNotes: effectiveNotes,
      resolvedAt: now,
      updatedAt: now,
    };

    await ref.update(updated);

    // If there is an associated refund, sync its status according to resolution type
    try {
      const targetRefundStatus = effectiveResolutionType === 'REJECT' || updated.status === ISSUE_STATUS.REJECTED
        ? "REJECTED"
        : effectiveResolutionType === 'REDELIVER'
        ? "RESOLVED_REDELIVER"
        : "REFUND_GRANTED";

      const refundUpdates = {
        status: targetRefundStatus,
        resolutionType: effectiveResolutionType,
        rejectReason: effectiveResolutionType === 'REJECT' ? effectiveNotes : null,
        resolutionNotes: effectiveNotes,
        adminMessage: effectiveNotes,
        resolvedAt: now,
        updatedAt: now,
      };

      if (effectiveResolutionType === 'REDELIVER') {
        refundUpdates.timeline = [
          { step: "ISSUE_REPORTED", label: "Issue Reported", at: current.createdAt || now, completed: true },
          { step: "REDELIVERY_SCHEDULED", label: "Redelivery Scheduled", at: now, completed: true, note: effectiveNotes },
          { step: "OUT_FOR_DELIVERY", label: "Replacement In Progress", at: null, completed: false, current: true, note: "Delivery partner will bring replacement items" },
        ];
      }

      if (current.refundId) {
        await db().collection(COLLECTIONS.REFUNDS).doc(current.refundId).update(refundUpdates);
      } else if (current.orderId) {
        const refSnap = await db().collection(COLLECTIONS.REFUNDS).where("orderId", "==", current.orderId).limit(1).get();
        if (!refSnap.empty) {
          await refSnap.docs[0].ref.update(refundUpdates);
        }
      }
    } catch (err) {
      console.error("Failed to sync refund on issue resolution:", err);
    }

    // Notify user dynamically based on REDELIVER vs REFUND vs REJECT
    if (current.userId) {
      const notifTitle = effectiveResolutionType === 'REDELIVER'
        ? "Redelivery Arranged"
        : updated.status === ISSUE_STATUS.RESOLVED
        ? "Refund Approved"
        : "Issue Claim Update";
      const notifBody = effectiveNotes || (effectiveResolutionType === 'REDELIVER'
        ? `We have arranged a redelivery for your order #${current.orderNo || ''}.`
        : updated.status === ISSUE_STATUS.RESOLVED
        ? `Your refund for order #${current.orderNo || ''} has been approved.`
        : `Your claim for order #${current.orderNo || ''} was reviewed.`);

      notifyUser(
        current.userId,
        notifTitle,
        notifBody,
        {
          type: effectiveResolutionType === 'REDELIVER' ? "ISSUE_REDELIVER" : "REFUND",
          issueId: req.params.id,
          orderId: current.orderId,
          orderNo: String(current.orderNo || ''),
          refundId: current.refundId || '',
          resolutionType: effectiveResolutionType,
          status: updated.status,
        }
      ).catch(() => {});
    }

    try {
      const { invalidateReadsCache } = require("./reads.routes");
      invalidateReadsCache("issues");
      invalidateReadsCache("refunds");
      invalidateReadsCache("orders");
      if (current.userId) invalidateReadsCache(current.userId);
    } catch (_) {}

    res.json({ id: req.params.id, ...current, ...updated });
  })
);

// POST /api/issues/:id/reply - Admin replies to customer regarding an issue
router.post(
  "/:id/reply",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const { reply } = req.body;
    const cleanReply = (reply || "").trim();
    if (!cleanReply) {
      return res.status(400).json({ error: "Reply text is required" });
    }

    const now = Date.now();
    let issueRef = db().collection(COLLECTIONS.ISSUES).doc(req.params.id);
    let doc = await issueRef.get();
    let userId = null;
    let orderId = "";
    let orderNo = "";
    let refundId = "";

    if (req.params.id.startsWith("dispute_")) {
      orderId = req.params.id.replace("dispute_", "");
      const orderRef = db().collection(COLLECTIONS.ORDERS).doc(orderId);
      const orderSnap = await orderRef.get();
      if (orderSnap.exists) {
        const oData = orderSnap.data();
        userId = oData.userId;
        orderNo = oData.orderNo || orderId.slice(-4);
        const existingReplies = oData.adminReplies || [];
        await orderRef.update({
          adminReplies: [...existingReplies, { text: cleanReply, sentBy: "ADMIN", createdAt: now }],
          lastAdminReply: cleanReply,
          lastAdminReplyAt: now,
          updatedAt: now,
        });
      }
    } else if (doc.exists) {
      const iData = doc.data();
      userId = iData.userId;
      orderId = iData.orderId || "";
      orderNo = iData.orderNo || "";
      const existingReplies = iData.replies || [];
      await issueRef.update({
        replies: [...existingReplies, { text: cleanReply, sentBy: "ADMIN", createdAt: now }],
        lastReply: cleanReply,
        lastReplyAt: now,
        updatedAt: now,
      });
      try {
        // Older issue reports may not have stored refundId even though their
        // matching refund exists. Resolve it by the order/user pair so the
        // customer Refund Status screen receives the same live reply.
        let rRef = iData.refundId
          ? db().collection(COLLECTIONS.REFUNDS).doc(iData.refundId)
          : null;
        let rSnap = rRef ? await rRef.get() : null;
        if (iData.refundId) refundId = iData.refundId;
        if ((!rSnap || !rSnap.exists) && orderId && userId) {
          const matchingRefund = await db().collection(COLLECTIONS.REFUNDS)
            .where("orderId", "==", orderId)
            .limit(20)
            .get();
          const ownedRefund = matchingRefund.docs.find((refundDoc) => refundDoc.data().userId === userId);
          if (ownedRefund) {
            rRef = ownedRefund.ref;
            rSnap = ownedRefund;
            refundId = ownedRefund.id;
          }
        }
        if (rSnap?.exists) {
          const rReplies = rSnap.data().replies || [];
          await rRef.update({
            replies: [...rReplies, { text: cleanReply, sentBy: "ADMIN", createdAt: now }],
            lastReply: cleanReply,
            lastReplyAt: now,
            adminMessage: cleanReply,
            issueId: req.params.id,
            updatedAt: now,
          });
        }
      } catch (e) {
        console.warn("Failed to sync reply to refund:", e.message);
      }
    } else {
      const refundRef = db().collection(COLLECTIONS.REFUNDS).doc(req.params.id);
      const refundDoc = await refundRef.get();
      if (refundDoc.exists) {
        const rData = refundDoc.data();
        userId = rData.userId;
        refundId = req.params.id;
        orderId = rData.orderId || "";
        orderNo = rData.orderNo || "";
        const existingReplies = rData.replies || [];
        await refundRef.update({
          replies: [...existingReplies, { text: cleanReply, sentBy: "ADMIN", createdAt: now }],
          lastReply: cleanReply,
          lastReplyAt: now,
          adminMessage: cleanReply,
          updatedAt: now,
        });
      } else {
        return res.status(404).json({ error: "Issue not found" });
      }
    }

    // The customer refund screen polls the private reads API; invalidate both
    // source collections immediately so it sees the newly saved reply on its
    // next poll instead of waiting for a stale cached document.
    try {
      const { invalidateReadsCache } = require("./reads.routes");
      invalidateReadsCache("issues");
      invalidateReadsCache("refunds");
      invalidateReadsCache("orders");
      if (userId) invalidateReadsCache(userId);
    } catch (_) {}

    const replyResolutionType = doc.exists
      ? doc.data()?.resolutionType
      : (refundDoc?.exists ? refundDoc.data()?.resolutionType : null);

    if (userId) {
      await notifyUser(
        userId,
        replyResolutionType === 'REDELIVER' || cleanReply.toLowerCase().includes('redeliver')
          ? "Redelivery Update from MS Traders"
          : "Reply from MS Traders",
        cleanReply,
        {
          type: replyResolutionType === 'REDELIVER' || cleanReply.toLowerCase().includes('redeliver')
            ? "ISSUE_REDELIVER"
            : "ISSUE_REPLY",
          issueId: req.params.id,
          orderId,
          orderNo: String(orderNo),
          refundId,
          resolutionType: replyResolutionType,
        }
      );
    }

    res.json({
      success: true,
      issueId: req.params.id,
      reply: cleanReply,
      createdAt: now,
    });
  })
);

module.exports = router;

