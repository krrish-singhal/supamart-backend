const { db } = require("../config/firebase");
const { COLLECTIONS } = require("../config/constants");
const admin = require("firebase-admin");

/**
 * Returns a Set of uppercase coupon codes that the user has already used.
 * Checks:
 * 1. userDoc.usedCoupons array
 * 2. users/{userId}/usedCoupons subcollection
 * 3. orders placed by this user that recorded a couponCode (excluding CANCELLED orders)
 */
async function getUserUsedCoupons(userId) {
  if (!userId) return new Set();
  const usedCodes = new Set();

  try {
    // 1. Check user profile usedCoupons array
    const userSnap = await db().collection(COLLECTIONS.USERS).doc(userId).get();
    if (userSnap.exists) {
      const data = userSnap.data();
      if (Array.isArray(data.usedCoupons)) {
        data.usedCoupons.forEach((c) => {
          if (c && typeof c === "string") usedCodes.add(c.trim().toUpperCase());
        });
      }
    }

    // 2. Check subcollection users/{userId}/usedCoupons
    const subSnap = await db()
      .collection(COLLECTIONS.USERS)
      .doc(userId)
      .collection("usedCoupons")
      .get();
    const subDocs = subSnap ? (Array.isArray(subSnap.docs) ? subSnap.docs : (typeof subSnap.forEach === "function" ? [] : [])) : [];
    if (subSnap && typeof subSnap.forEach === "function") {
      subSnap.forEach((doc) => {
        const c = doc.data()?.code || doc.id;
        if (c && typeof c === "string") usedCodes.add(c.trim().toUpperCase());
      });
    } else if (subDocs.length > 0) {
      subDocs.forEach((doc) => {
        const c = doc.data()?.code || doc.id;
        if (c && typeof c === "string") usedCodes.add(c.trim().toUpperCase());
      });
    }

    // 3. Check any orders placed by this user with a couponCode (excluding cancelled / failed orders)
    const ordersSnap = await db()
      .collection(COLLECTIONS.ORDERS)
      .where("userId", "==", userId)
      .get();
    const orderDocs = ordersSnap ? (Array.isArray(ordersSnap.docs) ? ordersSnap.docs : []) : [];
    if (ordersSnap && typeof ordersSnap.forEach === "function") {
      ordersSnap.forEach((doc) => {
        const ord = doc.data();
        if (ord.couponCode && ord.status !== "CANCELLED" && ord.paymentStatus !== "FAILED") {
          usedCodes.add(String(ord.couponCode).trim().toUpperCase());
        }
      });
    } else if (orderDocs.length > 0) {
      orderDocs.forEach((doc) => {
        const ord = doc.data();
        if (ord.couponCode && ord.status !== "CANCELLED" && ord.paymentStatus !== "FAILED") {
          usedCodes.add(String(ord.couponCode).trim().toUpperCase());
        }
      });
    }
  } catch (err) {
    console.warn(`Error getting used coupons for user ${userId}:`, err.message);
  }

  return usedCodes;
}

/**
 * Checks if a user has already used the specified coupon code.
 */
async function hasUserUsedCoupon(userId, couponCode) {
  if (!userId || !couponCode) return false;
  const cleanCode = String(couponCode).trim().toUpperCase();

  try {
    // Fast check: check user doc usedCoupons array
    const userSnap = await db().collection(COLLECTIONS.USERS).doc(userId).get();
    if (userSnap.exists) {
      const data = userSnap.data();
      if (Array.isArray(data.usedCoupons) && data.usedCoupons.includes(cleanCode)) {
        return true;
      }
    }

    // Check subcollection
    const subDoc = await db()
      .collection(COLLECTIONS.USERS)
      .doc(userId)
      .collection("usedCoupons")
      .doc(cleanCode)
      .get();
    if (subDoc.exists) return true;

    // Check past non-cancelled orders with this coupon
    const orderQuery = await db()
      .collection(COLLECTIONS.ORDERS)
      .where("userId", "==", userId)
      .where("couponCode", "==", cleanCode)
      .get();
    for (const doc of orderQuery.docs) {
      const ord = doc.data();
      if (ord.status !== "CANCELLED" && ord.paymentStatus !== "FAILED") {
        return true;
      }
    }
  } catch (err) {
    console.warn(`Error checking coupon usage for user ${userId}:`, err.message);
  }

  return false;
}

/**
 * Record a coupon as used within a transaction.
 */
function markCouponUsedInTx(tx, userId, couponCode, orderId, offerId, discount = 0) {
  if (!userId || !couponCode) return;
  const cleanCode = String(couponCode).trim().toUpperCase();
  const now = Date.now();

  // 1. Add to user doc usedCoupons array
  const userRef = db().collection(COLLECTIONS.USERS).doc(userId);
  tx.set(
    userRef,
    {
      usedCoupons: admin.firestore.FieldValue.arrayUnion(cleanCode),
      updatedAt: now,
    },
    { merge: true }
  );

  // 2. Write to user subcollection
  const subRef = userRef.collection("usedCoupons").doc(cleanCode);
  tx.set(
    subRef,
    {
      code: cleanCode,
      orderId: orderId || null,
      offerId: offerId || null,
      discount: discount || 0,
      usedAt: now,
    },
    { merge: true }
  );

  // 3. Increment offer usedCount
  if (offerId) {
    const offerRef = db().collection(COLLECTIONS.OFFERS).doc(offerId);
    tx.set(
      offerRef,
      {
        usedCount: admin.firestore.FieldValue.increment(1),
        updatedAt: now,
      },
      { merge: true }
    );
  }
}

/**
 * Release a coupon in case of cancellation or payment rejection.
 */
function releaseCouponInTx(tx, userId, couponCode, offerId) {
  if (!userId || !couponCode) return;
  const cleanCode = String(couponCode).trim().toUpperCase();
  const now = Date.now();

  const userRef = db().collection(COLLECTIONS.USERS).doc(userId);
  tx.set(
    userRef,
    {
      usedCoupons: admin.firestore.FieldValue.arrayRemove(cleanCode),
      updatedAt: now,
    },
    { merge: true }
  );

  const subRef = userRef.collection("usedCoupons").doc(cleanCode);
  tx.delete(subRef);

  if (offerId) {
    const offerRef = db().collection(COLLECTIONS.OFFERS).doc(offerId);
    tx.set(
      offerRef,
      {
        usedCount: admin.firestore.FieldValue.increment(-1),
        updatedAt: now,
      },
      { merge: true }
    );
  }
}

module.exports = {
  getUserUsedCoupons,
  hasUserUsedCoupon,
  markCouponUsedInTx,
  releaseCouponInTx,
};
