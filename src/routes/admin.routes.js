const express = require("express");
const PDFDocument = require("pdfkit");
const cloudinary = require("cloudinary").v2;
const { asyncHandler } = require("../middleware/error");
const { authenticate, requireRole } = require("../middleware/auth");
const { db, authAdmin } = require("../config/firebase");
const { ROLES, COLLECTIONS } = require("../config/constants");
const { broadcast, notifyLowStockToCartHolders } = require("../services/notificationService");
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

// POST /api/admin/fcm-token — registers this browser's FCM token to receive "New Order"
// pushes (admin-portal calls this once Notification permission is granted — see
// admin-portal/src/services/pushNotifications.js). Tokens live on a shared config doc,
// not a per-admin profile, because admin accounts have no Firestore user doc — just a
// Firebase Auth user with a `role` custom claim.
router.post(
  "/fcm-token",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(422).json({ error: "token is required" });
    try {
      const admin = require("firebase-admin");
      const ref = db().collection(COLLECTIONS.CONFIG).doc("adminDevices");
      await Promise.race([
        ref.set(
          { fcmTokens: admin.firestore.FieldValue.arrayUnion(token), updatedAt: Date.now() },
          { merge: true }
        ),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Firestore write timed out")), 10000))
      ]);
      res.json({ ok: true });
    } catch (err) {
      console.warn("[Admin FCM Token] Registration warning:", err.message);
      // Return ok: false rather than 500 so admin portal UI is not disturbed
      res.json({ ok: false, warning: err.message });
    }
  })
);

// DELETE /api/admin/fcm-token — unregisters a token (called on sign-out).
router.delete(
  "/fcm-token",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    // Accepts the token via query string too — apiDel() in the admin portal never sends a
    // request body, so the client passes it as ?token= instead.
    const token = req.body.token || req.query.token;
    if (!token) return res.status(422).json({ error: "token is required" });
    try {
      const admin = require("firebase-admin");
      const ref = db().collection(COLLECTIONS.CONFIG).doc("adminDevices");
      await Promise.race([
        ref.set(
          { fcmTokens: admin.firestore.FieldValue.arrayRemove(token), updatedAt: Date.now() },
          { merge: true }
        ),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Firestore write timed out")), 10000))
      ]);
      res.json({ ok: true });
    } catch (err) {
      console.warn("[Admin FCM Token] Deregistration warning:", err.message);
      res.json({ ok: false, warning: err.message });
    }
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

// In-memory catalog cache for zero-read low-stock evaluation
const { getCachedProducts, invalidateCatalogCache } = require("../services/catalogCache");

function invalidateLowStockCache() {
  invalidateCatalogCache();
}

// GET /api/admin/low-stock — products below stock threshold per variant (serves from memory, 0 reads)
router.get(
  "/low-stock",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const defaultThreshold = Number(req.query.threshold) || 10;
    const products = await getCachedProducts();
    const low = [];
    products.forEach((p) => {
      const thresh = Number(p.lowStockThreshold) || defaultThreshold;
      const lowVariants = (p.variants || []).filter((v) => Number(v.stock) <= thresh);
      if (lowVariants.length) {
        const totalStock = (p.variants || []).reduce((sum, v) => sum + (Number(v.stock) || 0), 0);
        low.push({ ...p, lowVariants, totalStock, isOutOfStock: totalStock <= 0 });
      }
    });
    res.json({ items: low });
  })
);

// GET /api/admin/catalog — full catalog (products, categories, brands) served from in-memory cache (0 Firestore reads)
router.get(
  "/catalog",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const { getCatalog } = require("../services/catalogCache");
    const catalog = await getCatalog();
    res.json(catalog);
  })
);

// GET /api/admin/alerts — recent operational alerts (low stock, stockouts)
router.get(
  "/alerts",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const snap = await db()
      .collection(COLLECTIONS.ADMIN_ALERTS || "adminAlerts")
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();
    const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json({ items });
  })
);

// PATCH /api/admin/alerts/:id/read — mark an alert as read
router.patch(
  "/alerts/:id/read",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const ref = db().collection(COLLECTIONS.ADMIN_ALERTS || "adminAlerts").doc(req.params.id);
    await ref.update({ read: true, readAt: Date.now() });
    res.json({ ok: true, id: req.params.id });
  })
);

// POST /api/admin/alerts/clear-all — mark all unread alerts as read
router.post(
  "/alerts/clear-all",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const snap = await db()
      .collection(COLLECTIONS.ADMIN_ALERTS || "adminAlerts")
      .where("read", "==", false)
      .limit(50)
      .get();
    const batch = db().batch();
    snap.docs.forEach((d) => batch.update(d.ref, { read: true, readAt: Date.now() }));
    await batch.commit();
    res.json({ ok: true, cleared: snap.size });
  })
);

// GET /api/admin/broadcasts — list past push broadcasts
router.get(
  "/broadcasts",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const snap = await db().collection("broadcasts").orderBy("createdAt", "desc").limit(50).get();
    const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json({ items });
  })
);

// POST /api/admin/broadcast — push notification to all customers
router.post(
  "/broadcast",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const { title, body, audience, targetScreen } = req.body;
    if (!title || !body) {
      const e = new Error("title and body are required");
      e.statusCode = 422;
      throw e;
    }
    // Collect all FCM tokens from users
    const usersSnap = await db().collection(COLLECTIONS.USERS).get();
    const tokens = new Set();
    usersSnap.docs.forEach((d) => {
      const user = d.data();
      if (user.offerNotificationsEnabled === false) return;
      const fcmTokens = user.fcmTokens || [];
      fcmTokens.forEach((token) => tokens.add(token));
    });
    const tokenList = [...tokens];
    
    // Create record in broadcasts collection
    const record = {
      title,
      body,
      audience: audience || "All customers",
      targetScreen: targetScreen || "Home screen",
      delivered: tokenList.length,
      opened: 0,
      createdAt: Date.now(),
    };
    const docRef = await db().collection("broadcasts").add(record);

    // Persist inbox entries in bounded batches so a broadcast request does not wait
    // on one network round-trip per customer.
    const eligibleUsers = usersSnap.docs.filter((d) => d.data().offerNotificationsEnabled !== false);
    const cacheInvalidations = [];
    for (let start = 0; start < eligibleUsers.length; start += 450) {
      const batch = db().batch();
      const chunk = eligibleUsers.slice(start, start + 450);
      chunk.forEach((d) => {
        const notificationRef = d.ref.collection("notifications").doc();
        batch.set(notificationRef, {
          title,
          body,
          data: { type: "BROADCAST", targetScreen: targetScreen || "Home screen" },
          read: false,
          createdAt: Date.now(),
        });
        cacheInvalidations.push(d.id);
      });
      await batch.commit();
    }
    try {
      const { invalidateReadsCache } = require("./reads.routes");
      cacheInvalidations.forEach((userId) => invalidateReadsCache(`users/${userId}/notifications`));
    } catch (_) {}

    if (tokenList.length) {
      // Push providers can be slow or unavailable. The inbox is already committed;
      // queue push delivery without holding the admin form open.
      broadcast(tokenList, title, body).catch((err) => {
        console.error("Broadcast push delivery failed:", err?.message || err);
      });
    }
    res.json({ id: docRef.id, sent: tokenList.length, ...record });
  })
);

// POST /api/admin/notify-low-stock — sends low-stock alerts to customers who have low-stock items in their cart
router.post(
  "/notify-low-stock",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const productsSnap = await db().collection(COLLECTIONS.PRODUCTS).get();
    let notifiedCount = 0;
    for (const doc of productsSnap.docs) {
      const p = doc.data();
      const lowVariant = (p.variants || []).find((v) => Number(v.stock) > 0 && Number(v.stock) <= 5);
      if (lowVariant) {
        await notifyLowStockToCartHolders(doc.id, lowVariant.stock, p.name);
        notifiedCount++;
      }
    }
    res.json({ ok: true, productsChecked: productsSnap.size, lowStockProductsFound: notifiedCount });
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

// Staff management routes
router.get(
  "/staff",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const snap = await db().collection("staff").orderBy("createdAt", "asc").get();
    if (snap.empty) {
      // Return default initial staff matching screenshot
      const initialStaff = [
        {
          id: "staff-owner-1",
          name: "Sudarsanan",
          email: "sudarsanan.in@gmail.com",
          role: "Owner",
          canAccess: "Everything",
          lastActive: "Now",
          isOwner: true,
          createdAt: Date.now() - 86400000 * 30,
        },
        {
          id: "staff-mgr-1",
          name: "Store Manager",
          email: "admin@supamart.in",
          role: "Manager",
          canAccess: "Orders, products, payments, customers",
          lastActive: "Today",
          isOwner: false,
          createdAt: Date.now() - 86400000 * 10,
        },
        {
          id: "staff-pkr-1",
          name: "Warehouse Packer",
          email: "—",
          role: "Packer",
          canAccess: "Orders (packing only)",
          lastActive: "Yesterday",
          isOwner: false,
          createdAt: Date.now() - 86400000 * 5,
        },
      ];
      // Seed them into Firestore so subsequent calls and real-time listeners pick them up
      const batch = db().batch();
      initialStaff.forEach((s) => {
        const ref = db().collection("staff").doc(s.id);
        batch.set(ref, s);
      });
      await batch.commit();
      return res.json({ staff: initialStaff });
    }
    const staff = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json({ staff });
  })
);

router.post(
  "/staff",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const { name, email, role, phone } = req.body;
    if (!name || !role) {
      const e = new Error("Name and role are required");
      e.statusCode = 422;
      throw e;
    }
    let canAccess = "Orders, products, payments, customers";
    if (role === "Owner") canAccess = "Everything";
    else if (role === "Packer") canAccess = "Orders (packing only)";
    else if (role === "Delivery") canAccess = "Deliveries & dispatch only";
    else if (role === "Cashier") canAccess = "Orders & payments";

    const newStaff = {
      name: name.trim(),
      email: email ? email.trim() : "—",
      phone: phone ? phone.trim() : "",
      role,
      canAccess,
      lastActive: "Just invited",
      isOwner: role === "Owner",
      createdAt: Date.now(),
    };
    const docRef = await db().collection("staff").add(newStaff);
    res.json({ id: docRef.id, ...newStaff });
  })
);

router.delete(
  "/staff/:id",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const docRef = db().collection("staff").doc(req.params.id);
    const snap = await docRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Staff member not found" });
    if (snap.data().isOwner || snap.data().role === "Owner") {
      return res.status(403).json({ error: "Cannot delete the Owner account" });
    }
    await docRef.delete();
    res.json({ ok: true, id: req.params.id });
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

    const configSnap = await db().collection(COLLECTIONS.CONFIG).doc("global").get();
    const configData = configSnap.exists ? configSnap.data() : {};
    const biz = configData.businessLegal || {};
    const storeName = biz.legalEntityName || "MS Traders";

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="invoice-${order.orderNo}.pdf"`);

    const doc = new PDFDocument({ size: "A4", margin: 50 });
    doc.pipe(res);

    // Header
    doc.fontSize(20).text(storeName, { align: "center" });
    if (biz.gstin) doc.fontSize(9).text(`GSTIN: ${biz.gstin}`, { align: "center" });
    if (biz.fssaiLicenceNumber) doc.fontSize(9).text(`FSSAI: ${biz.fssaiLicenceNumber}`, { align: "center" });
    doc.fontSize(12).text("Tax Invoice / Order Receipt", { align: "center" });
    doc.moveDown();
    const prefix = biz.invoicePrefix || "";
    doc.fontSize(10).text(`Order #${prefix}${order.orderNo}`);
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

// GET /api/admin/ratings — dynamic ratings & reviews summary from database
router.get(
  "/ratings",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const snap = await db().collection(COLLECTIONS.ORDERS).get();

    const ratedOrders = [];
    snap.docs.forEach((doc) => {
      const data = doc.data();
      const rating = data.ratings?.orderRating || data.deliveryRating || data.rating;
      if (typeof rating === "number" && rating > 0) {
        ratedOrders.push({ id: doc.id, ...data });
      }
    });

    ratedOrders.sort((a, b) => {
      const timeA = a.ratings?.ratedAt || a.updatedAt || a.createdAt || 0;
      const timeB = b.ratings?.ratedAt || b.updatedAt || b.createdAt || 0;
      return timeB - timeA;
    });

    let sum = 0;
    const starCounts = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };

    const reviews = ratedOrders.map((o) => {
      const star = Math.min(5, Math.max(1, Math.round(o.ratings?.orderRating || o.deliveryRating || o.rating)));
      starCounts[star] = (starCounts[star] || 0) + 1;
      sum += star;

      const ratedAt = o.ratings?.ratedAt || o.updatedAt || o.createdAt || Date.now();

      return {
        id: o.id,
        orderNo: o.orderNo || o.id?.slice(-4),
        customerName: o.userName || o.customerName || "Customer",
        phone: o.userPhone || o.customerPhone || "",
        rating: star,
        tags: o.ratings?.tags || o.tags || ["Customer Feedback"],
        comment: o.ratings?.review || o.deliveryReview || o.comment || "",
        deliveryFeedback: o.ratings?.deliveryFeedback || null,
        productRatings: o.ratings?.productRatings || [],
        items: o.items || [],
        ratedAt,
        status: o.status,
      };
    });

    const totalRatings = reviews.length;
    const avgRating = totalRatings > 0 ? (sum / totalRatings).toFixed(1) : "0.0";
    const breakdown = [
      { star: 5, count: starCounts[5] || 0, color: "bg-[#0a7c47]" },
      { star: 4, count: starCounts[4] || 0, color: "bg-[#059669]" },
      { star: 3, count: starCounts[3] || 0, color: "bg-[#f59e0b]" },
      { star: 2, count: starCounts[2] || 0, color: "bg-[#ef4444]" },
      { star: 1, count: starCounts[1] || 0, color: "bg-[#dc2626]" },
    ];

    res.json({
      avgRating,
      totalRatings,
      breakdown,
      counts: starCounts,
      reviews,
    });
  })
);

router.invalidateLowStockCache = invalidateLowStockCache;
module.exports = router;
module.exports.invalidateLowStockCache = invalidateLowStockCache;
