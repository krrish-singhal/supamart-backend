const { issueCode, cancelCode, verifyCode } = require('../services/accountCodes');
const express = require("express");
const multer = require("multer");
const { asyncHandler } = require("../middleware/error");
const { authenticate, requireRole } = require("../middleware/auth");
const { Users } = require("../models");
const { ROLES } = require("../config/constants");
const { upload: uploadToCloud } = require("../services/storageService");
const { deleteUserAccount } = require("../services/accountDeletionService");
const { publicUser } = require("../utils/publicUser");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// GET /api/users/:uid — admin can get any user; user can get their own
router.get(
  "/:uid",
  authenticate,
  asyncHandler(async (req, res) => {
    if (req.user.uid !== req.params.uid && req.user.role !== ROLES.ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const user = await Users.findById(req.params.uid);
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(publicUser(user));
  })
);

// PUT /api/users/:uid — update profile fields
router.put(
  "/:uid",
  authenticate,
  asyncHandler(async (req, res) => {
    if (req.user.uid !== req.params.uid && req.user.role !== ROLES.ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const allowed = ["name", "mobile", "defaultAddressId", "gender", "dateOfBirth", "profileImage", "offerNotificationsEnabled"];
    const update = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );
    const updated = await Users.update(req.params.uid, { ...update, updatedAt: Date.now() });
    res.json(publicUser(updated));
  })
);

// PATCH /api/users/:uid/avatar — upload profile photo to Cloudinary
router.patch(
  "/:uid/avatar",
  authenticate,
  upload.single("avatar"),
  asyncHandler(async (req, res) => {
    if (req.user.uid !== req.params.uid && req.user.role !== ROLES.ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (!req.file) return res.status(422).json({ error: "No image file provided" });
    const { url } = await uploadToCloud(req.file.buffer, "avatars");
    const updated = await Users.update(req.params.uid, { profileImage: url, updatedAt: Date.now() });
    res.json(publicUser(updated));
  })
);

// PATCH /api/users/:uid/favorites — toggle a product in/out of the user's favorites
router.patch(
  "/:uid/favorites",
  authenticate,
  asyncHandler(async (req, res) => {
    if (req.user.uid !== req.params.uid && req.user.role !== ROLES.ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const { productId, action } = req.body;
    if (!productId || !["add", "remove"].includes(action)) {
      return res.status(422).json({ error: "productId and action ('add'|'remove') are required" });
    }
    const user = await Users.findById(req.params.uid);
    if (!user) return res.status(404).json({ error: "User not found" });
    const current = user.favoriteProductIds || [];
    const favoriteProductIds =
      action === "add"
        ? Array.from(new Set([...current, productId]))
        : current.filter((id) => id !== productId);
    const updated = await Users.update(req.params.uid, { favoriteProductIds, updatedAt: Date.now() });
    res.json({ favoriteProductIds: updated.favoriteProductIds });
  })
);

// GET /api/users — admin: list all users (paginated)
router.get(
  "/",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const result = await Users.paginate({
      orderBy: { field: "createdAt", dir: "desc" },
      limit: Number(req.query.limit) || 20,
      startAfter: req.query.cursor || null,
    });
    res.json({ ...result, items: result.items.map(publicUser) });
  })
);

// GET /api/users/me/deletion-status — pre-flight status checks before deleting account
router.get(
  "/me/deletion-status",
  authenticate,
  asyncHandler(async (req, res) => {
    const { db } = require("../config/firebase");
    const { COLLECTIONS, ORDER_STATUS, REFUND_STATUS } = require("../config/constants");
    const user = await Users.findById(req.user.uid);
    if (!user) return res.status(404).json({ error: "User not found" });

    const activeOrderStatuses = [
      ORDER_STATUS.PLACED,
      ORDER_STATUS.ACCEPTED,
      ORDER_STATUS.OUT_FOR_DELIVERY,
      ORDER_STATUS.PENDING_CONFIRMATION,
    ];

    const activeOrdersSnap = await db()
      .collection(COLLECTIONS.ORDERS)
      .where("userId", "==", req.user.uid)
      .where("status", "in", activeOrderStatuses)
      .get();

    const activeRefundStatuses = [
      REFUND_STATUS.PENDING_APPROVAL,
      REFUND_STATUS.INITIATED,
      REFUND_STATUS.PROCESSING,
    ];

    let pendingRefundsCount = 0;
    try {
      const refundsSnap = await db()
        .collection(COLLECTIONS.REFUNDS)
        .where("userId", "==", req.user.uid)
        .where("status", "in", activeRefundStatuses)
        .get();
      pendingRefundsCount = refundsSnap.size;
    } catch (_err) {
      // refunds collection might be optional or empty
    }

    const email = user.email || req.user.email || (user.mobile ? `${user.mobile}@ms-traders.in` : "");
    const mobile = user.mobile || "";
    const msClubActive = !!user.isMSClubMember;
    const msClubExpiryDate = user.msClubValidUntil
      ? new Date(user.msClubValidUntil).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
      : null;

    res.json({
      hasActiveOrders: !activeOrdersSnap.empty,
      activeOrdersCount: activeOrdersSnap.size,
      hasActiveRefunds: pendingRefundsCount > 0,
      pendingRefundsCount,
      email,
      mobile,
      msClubActive,
      msClubExpiryDate,
    });
  })
);

// POST /api/users/me/delete-otp — sends a 6-digit deletion confirmation code to user's email via Nodemailer
router.post(
  "/me/delete-otp",
  authenticate,
  asyncHandler(async (req, res) => {
    const { db } = require("../config/firebase");
    const { COLLECTIONS, ORDER_STATUS } = require("../config/constants");
    const { sendDeleteAccountOTPEmail } = require("../services/emailService");

    const user = await Users.findById(req.user.uid);
    if (!user) return res.status(404).json({ error: "User not found" });

    // Check if user has active orders
    const activeOrderStatuses = [
      ORDER_STATUS.PLACED,
      ORDER_STATUS.ACCEPTED,
      ORDER_STATUS.OUT_FOR_DELIVERY,
      ORDER_STATUS.PENDING_CONFIRMATION,
    ];

    const activeOrdersSnap = await db()
      .collection(COLLECTIONS.ORDERS)
      .where("userId", "==", req.user.uid)
      .where("status", "in", activeOrderStatuses)
      .limit(1)
      .get();

    if (!activeOrdersSnap.empty) {
      return res.status(400).json({
        error: "Cannot delete account while you have active orders in progress. Please wait until your orders are delivered or cancelled.",
      });
    }

    const targetEmail = user.email || req.user.email;
    if (!targetEmail) {
      return res.status(422).json({
        error: "No email address found on account. Please add an email address in Edit Profile to receive the deletion code.",
      });
    }

    const issued = await issueCode('deletion', req.user.uid, req.user.uid);
    const result = await sendDeleteAccountOTPEmail(targetEmail, issued.otp);
    if (!result.delivered) {
      await cancelCode('deletion', req.user.uid, issued.generation);
      return res.status(503).json({ error: "Failed to send the confirmation email. Please try again later." });
    }

    // Masked email for UI display (e.g., "jo***@gmail.com")
    const parts = targetEmail.split("@");
    const maskedName = parts[0].length > 2 ? `${parts[0].slice(0, 2)}***` : `${parts[0]}***`;
    const maskedEmail = `${maskedName}@${parts[1] || ""}`;

    res.json({
      ok: true,
      email: targetEmail,
      maskedEmail,
      message: "A 6-digit code has been sent to your email.",
    });
  })
);

// DELETE /api/users/me — authenticated customer permanently deletes their own account using 6-digit OTP or password
router.delete(
  "/me",
  authenticate,
  asyncHandler(async (req, res) => {
    const { otp, password, reason } = req.body || {};
    const user = await Users.findById(req.user.uid);
    if (!user) return res.status(404).json({ error: "User not found" });

    if (otp) {
      await verifyCode('deletion', req.user.uid, otp);

      const result = await deleteUserAccount(req.user.uid, req.user, { forceVerified: true, reason });
      return res.json(result);
    }

    // Fallback: If password is provided (e.g. for legacy or test scripts)
    if (password) {
      const result = await deleteUserAccount(req.user.uid, req.user, { password, reason });
      return res.json(result);
    }

    return res.status(400).json({ error: "Confirmation code or password is required to delete your account." });
  })
);

// DELETE /api/users/:uid — user deletes own account or admin deletes account
router.delete(
  "/:uid",
  authenticate,
  asyncHandler(async (req, res) => {
    const { password, forceAdmin, otp, reason } = req.body || {};
    const isOwner = req.user.uid === req.params.uid;
    if (isOwner && otp) {
      const user = await Users.findById(req.params.uid);
      if (!user) return res.status(404).json({ error: "User not found" });
      await verifyCode('deletion', req.params.uid, otp);
      const result = await deleteUserAccount(req.params.uid, req.user, { forceVerified: true, reason });
      return res.json(result);
    }

    const result = await deleteUserAccount(req.params.uid, req.user, { password, forceAdmin, reason });
    res.json(result);
  })
);

module.exports = router;
