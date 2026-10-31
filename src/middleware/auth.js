const jwt = require("jsonwebtoken");
const { authAdmin } = require("../config/firebase");
const { ROLES } = require("../config/constants");

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error("JWT_SECRET env var is required");

// Verifies either a Firebase ID token (admin portal) or a backend JWT (mobile apps).
// Firebase ID tokens carry a `role` custom claim set via Admin SDK.
// Backend JWTs carry `uid`, `role`, and `phone` signed with JWT_SECRET.
async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing token" });

    // Try Firebase ID token first (admin portal sends these directly)
    try {
      const decoded = await authAdmin().verifyIdToken(token);
      const isAdminEmail = decoded.email && (
        decoded.email === "admin@supamart.in" ||
        decoded.email.toLowerCase() === "krrishsinghal22@gmail.com" ||
        decoded.email.toLowerCase() === "krrishsinghal62@gmail.com"
      );
      let role = decoded.role;
      if (!role) {
        if (isAdminEmail) {
          role = ROLES.ADMIN;
        } else {
          try {
            const { DeliveryPartners } = require("../models");
            const partnerDoc = await DeliveryPartners.findById(decoded.uid);
            if (partnerDoc) {
              role = ROLES.PARTNER;
            }
          } catch (_e) {}
        }
      }
      req.user = {
        uid: decoded.uid,
        role: role || ROLES.CUSTOMER,
        email: decoded.email || null,
        phone: decoded.phone_number || null,
      };
      return next();
    } catch (_firebaseErr) {
      // Not a Firebase token — fall through to custom JWT
    }

    // Fall back to backend-signed JWT (customer / delivery partner apps)
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = { uid: decoded.uid, role: decoded.role || ROLES.CUSTOMER, phone: decoded.phone };
    return next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

async function optionalAuthenticate(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return next();

    try {
      const decoded = await authAdmin().verifyIdToken(token);
      let role = decoded.role;
      if (!role) {
        try {
          const { DeliveryPartners } = require("../models");
          const partnerDoc = await DeliveryPartners.findById(decoded.uid);
          if (partnerDoc) {
            role = ROLES.PARTNER;
          }
        } catch (_e) {}
      }
      req.user = {
        uid: decoded.uid,
        role: role || ROLES.CUSTOMER,
        email: decoded.email || null,
        phone: decoded.phone_number || null,
      };
      return next();
    } catch (_firebaseErr) {
      // Fall through to custom JWT
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = { uid: decoded.uid, role: decoded.role || ROLES.CUSTOMER, phone: decoded.phone };
    return next();
  } catch (e) {
    // Continue unauthenticated if token invalid or expired
    return next();
  }
}

// Role guard: requireRole(ROLES.ADMIN)
function requireRole(...allowed) {
  return (req, res, next) => {
    if (!req.user || !allowed.includes(req.user.role)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    next();
  };
}

module.exports = { authenticate, optionalAuthenticate, requireRole };

