const express = require("express");
const PDFDocument = require("pdfkit");
const cloudinary = require("cloudinary").v2;
const { asyncHandler } = require("../middleware/error");
const { authenticate, requireRole } = require("../middleware/auth");
const { db, authAdmin } = require("../config/firebase");
const { ROLES, COLLECTIONS } = require("../config/constants");
const { broadcast } = require("../services/notificationService");
const dayjs = require("dayjs");

// storageService.js configures Cloudinary globally; import it to ensure config is applied
require("../services/storageService");

const router = express.Router();

// GET /api/admin/cloudinary-signature — returns a short-lived signed upload token.
// The browser uploads directly to Cloudinary using this signature (no file passes through backend).
router.get(
  "/cloudinary-signature",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const folder = (req.query.folder || "uploads").replace(/[^a-z0-9_/-]/gi, "");
    const timestamp = Math.round(Date.now() / 1000);
    const paramsToSign = { folder, timestamp };
    const signature = cloudinary.utils.api_sign_request(
      paramsToSign,
      process.env.CLOUDINARY_API_SECRET
    );
    res.json({
      signature,
      timestamp,
      apiKey: process.env.CLOUDINARY_API_KEY,
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      folder,
    });
  })
);

// GET /api/admin/dashboard — today + month summary
router.get(
  "/dashboard",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const today = dayjs().format("YYYY-MM-DD");
    const month = dayjs().format("YYYY-MM");

    const [todaySnap, monthSnap] = await Promise.all([
      db().collection(COLLECTIONS.METRICS).doc("daily").collection("days").doc(today).get(),
      db().collection(COLLECTIONS.METRICS).doc("monthly").collection("months").doc(month).get(),
    ]);

    const todayData = todaySnap.exists ? todaySnap.data() : { orders: 0, revenue: 0, delivered: 0, pending: 0, cancelled: 0, hourly: {} };
    const monthData = monthSnap.exists ? monthSnap.data() : { orders: 0, revenue: 0 };

    res.json({ today: todayData, month: monthData });
  })
);

// GET /api/admin/analytics — last N days of daily metrics
router.get(
  "/analytics",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const days = Math.min(Number(req.query.days) || 30, 90);
    const promises = [];
    for (let i = 0; i < days; i++) {
      const dateId = dayjs().subtract(i, "day").format("YYYY-MM-DD");
      promises.push(
        db().collection(COLLECTIONS.METRICS).doc("daily").collection("days").doc(dateId).get()
      );
    }
    const snaps = await Promise.all(promises);
    const series = snaps
      .map((s, i) => ({
        date: dayjs().subtract(i, "day").format("YYYY-MM-DD"),
        ...(s.exists ? s.data() : { orders: 0, revenue: 0, delivered: 0, pending: 0, cancelled: 0 }),
      }))
      .reverse();
    res.json({ series });
  })
);

// GET /api/admin/low-stock — products below stock threshold per variant
router.get(
  "/low-stock",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const threshold = Number(req.query.threshold) || 10;
    const snap = await db().collection(COLLECTIONS.PRODUCTS).get();
    const low = [];
    snap.docs.forEach((d) => {
      const p = { id: d.id, ...d.data() };
      const lowVariants = (p.variants || []).filter((v) => v.stock <= threshold);
      if (lowVariants.length) low.push({ ...p, lowVariants });
    });
    res.json({ items: low });
  })
);

// POST /api/admin/broadcast — push notification to all customers
router.post(
  "/broadcast",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const { title, body } = req.body;
    if (!title || !body) {
      const e = new Error("title and body are required");
      e.statusCode = 422;
      throw e;
    }
    // Collect all FCM tokens from users
    const usersSnap = await db().collection(COLLECTIONS.USERS).get();
    const tokens = [];
    usersSnap.docs.forEach((d) => {
      const fcmTokens = d.data().fcmTokens || [];
      tokens.push(...fcmTokens);
    });
    if (!tokens.length) return res.json({ sent: 0 });
    await broadcast(tokens, title, body);
    res.json({ sent: tokens.length, title, body });
  })
);

// POST /api/admin/set-role — set a user's custom role claim (ADMIN or PARTNER)
router.post(
  "/set-role",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const { uid, role } = req.body;
    if (!uid || !role) {
      const e = new Error("uid and role are required");
      e.statusCode = 422;
      throw e;
    }
    if (![ROLES.ADMIN, ROLES.PARTNER, ROLES.CUSTOMER].includes(role)) {
      const e = new Error(`Invalid role: ${role}`);
      e.statusCode = 422;
      throw e;
    }
    await authAdmin().setCustomUserClaims(uid, { role });
    res.json({ uid, role });
  })
);

// GET /api/admin/invoices/:orderId — generate and stream PDF invoice
router.get(
  "/invoices/:orderId",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const orderSnap = await db().collection(COLLECTIONS.ORDERS).doc(req.params.orderId).get();
    if (!orderSnap.exists) return res.status(404).json({ error: "Order not found" });
    const order = { id: orderSnap.id, ...orderSnap.data() };

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="invoice-${order.orderNo}.pdf"`);

    const doc = new PDFDocument({ size: "A4", margin: 50 });
    doc.pipe(res);

    // Header
    doc.fontSize(20).text("SupaMart", { align: "center" });
    doc.fontSize(12).text("Tax Invoice / Order Receipt", { align: "center" });
    doc.moveDown();
    doc.fontSize(10).text(`Order #${order.orderNo}`);
    doc.text(`Date: ${dayjs(order.createdAt).format("DD MMM YYYY, h:mm A")}`);
    doc.text(`Payment: ${order.paymentMethod} — ${order.paymentStatus}`);
    doc.moveDown();

    // Delivery address
    const addr = order.addressSnapshot;
    doc.text("Delivery Address:", { underline: true });
    doc.text(`${addr.houseNo}, ${addr.street}${addr.landmark ? ", " + addr.landmark : ""}, ${addr.pincode}`);
    doc.moveDown();

    // Items table
    doc.text("Items:", { underline: true });
    order.items.forEach((item) => {
      doc.text(`${item.name} ${item.variantLabel}  x${item.qty}  @ ₹${item.price}  = ₹${(item.price * item.qty).toFixed(2)}`);
    });
    doc.moveDown();

    // Totals
    doc.text(`Subtotal:        ₹${order.subtotal.toFixed(2)}`);
    if (order.discount > 0) doc.text(`Discount:       -₹${order.discount.toFixed(2)}`);
    if (order.tax > 0) doc.text(`Tax:             ₹${order.tax.toFixed(2)}`);
    doc.text(`Delivery Charge: ₹${order.deliveryCharge.toFixed(2)}`);
    doc.fontSize(12).text(`Total:           ₹${order.total.toFixed(2)}`, { bold: true });

    doc.end();
  })
);

module.exports = router;
