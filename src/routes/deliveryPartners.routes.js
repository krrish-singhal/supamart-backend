const express = require("express");
const { asyncHandler } = require("../middleware/error");
const { authenticate, requireRole } = require("../middleware/auth");
const { DeliveryPartners, Orders } = require("../models");
const { ROLES, COLLECTIONS, ORDER_STATUS } = require("../config/constants");
const { db } = require("../config/firebase");

const router = express.Router();

// GET /api/delivery-partners — admin: list all, paginated
router.get(
  "/",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const result = await DeliveryPartners.paginate({
      orderBy: { field: "createdAt", dir: "desc" },
      limit: Number(req.query.limit) || 20,
      startAfter: req.query.cursor || null,
    });
    res.json(result);
  })
);

// GET /api/delivery-partners/me — delivery partner: own profile
router.get(
  "/me",
  authenticate,
  requireRole(ROLES.PARTNER),
  asyncHandler(async (req, res) => {
    const partner = await DeliveryPartners.findById(req.user.uid);
    if (!partner) return res.status(404).json({ error: "Partner profile not found" });
    res.json(partner);
  })
);

// GET /api/delivery-partners/:uid — admin or self
router.get(
  "/:uid",
  authenticate,
  asyncHandler(async (req, res) => {
    if (req.user.uid !== req.params.uid && req.user.role !== ROLES.ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const partner = await DeliveryPartners.findById(req.params.uid);
    if (!partner) return res.status(404).json({ error: "Partner not found" });
    res.json(partner);
  })
);

// POST /api/delivery-partners — admin: register a new delivery partner
router.post(
  "/",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const { name, mobile, email, password } = req.body;
    if (!name || !mobile || !email || !password) {
      return res.status(422).json({ error: "name, mobile, email, and password are required" });
    }

    const { authAdmin } = require("../config/firebase");
    
    // Create the user in Firebase Auth
    const userRecord = await authAdmin().createUser({
      email,
      password,
      displayName: name,
    });

    const uid = userRecord.uid;
    const now = Date.now();
    const partner = await DeliveryPartners.create(uid, {
      name,
      email,
      mobile,
      isActive: true,
      fcmTokens: [],
      currentOrders: [],
      createdAt: now,
    });

    // Set custom claim so they can authenticate as PARTNER
    await authAdmin().setCustomUserClaims(uid, { role: ROLES.PARTNER });
    
    res.status(201).json(partner);
  })
);

// PUT /api/delivery-partners/:uid — admin or partner updates own profile
router.put(
  "/:uid",
  authenticate,
  asyncHandler(async (req, res) => {
    if (req.user.uid !== req.params.uid && req.user.role !== ROLES.ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const allowed = ["name", "mobile", "isActive", "fcmTokens"];
    const update = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );
    const updated = await DeliveryPartners.update(req.params.uid, update);
    res.json(updated);
  })
);

// PATCH /api/delivery-partners/:uid/location — partner updates their location
router.patch(
  "/:uid/location",
  authenticate,
  asyncHandler(async (req, res) => {
    if (req.user.uid !== req.params.uid) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const { lat, lng } = req.body;
    if (typeof lat !== "number" || typeof lng !== "number") {
      return res.status(400).json({ error: "lat and lng must be numbers" });
    }
    const update = {
      currentLocation: {
        lat,
        lng,
        updatedAt: Date.now(),
      }
    };
    const updated = await DeliveryPartners.update(req.params.uid, update);
    res.json(updated);
  })
);

// DELETE /api/delivery-partners/:uid — admin only
router.delete(
  "/:uid",
  authenticate,
  requireRole(ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    await DeliveryPartners.delete(req.params.uid);
    res.json({ uid: req.params.uid, deleted: true });
  })
);

// GET /api/delivery-partners/:uid/orders — partner's assigned orders (active + recent)
router.get(
  "/:uid/orders",
  authenticate,
  asyncHandler(async (req, res) => {
    if (req.user.uid !== req.params.uid && req.user.role !== ROLES.ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const result = await Orders.paginate({
      where: [["assignedPartnerId", "==", req.params.uid]],
      orderBy: { field: "createdAt", dir: "desc" },
      limit: Number(req.query.limit) || 20,
      startAfter: req.query.cursor || null,
    });
    res.json(result);
  })
);

// GET /api/delivery-partners/:uid/stats — returns partner stats (orders delivered, earnings, rating)
router.get(
  "/:uid/stats",
  authenticate,
  asyncHandler(async (req, res) => {
    if (req.user.uid !== req.params.uid && req.user.role !== ROLES.ADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }
    
    // For now, return mock/aggregated stats
    // A real implementation would query the ORDERS collection for delivered orders assigned to this UID
    const stats = {
      deliveredToday: 0,
      totalEarnings: 0,
      rating: "4.8",
      activeOrders: 0
    };
    
    // Example logic to fetch active orders count
    const activeQuery = await db()
      .collection(COLLECTIONS.ORDERS)
      .where("assignedPartnerId", "==", req.params.uid)
      .where("status", "in", [ORDER_STATUS.ACCEPTED, ORDER_STATUS.OUT_FOR_DELIVERY])
      .get();
      
    stats.activeOrders = activeQuery.size;
    
    res.json(stats);
  })
);

module.exports = router;
