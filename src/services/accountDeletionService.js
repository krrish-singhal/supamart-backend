const bcrypt = require("bcryptjs");
const firebase = require("../config/firebase");
const { Users } = require("../models");
const { COLLECTIONS, ROLES, ORDER_STATUS } = require("../config/constants");
const storageService = require("./storageService");

const ACTIVE_ORDER_STATUSES = [
  ORDER_STATUS.PLACED,
  ORDER_STATUS.ACCEPTED,
  ORDER_STATUS.OUT_FOR_DELIVERY,
  ORDER_STATUS.PENDING_CONFIRMATION,
];

function extractCloudinaryPublicId(url) {
  if (!url || typeof url !== "string") return null;
  if (!url.includes("cloudinary.com") && !url.includes("/upload/")) return null;
  const match = url.match(/\/upload\/(?:v\d+\/)?([^\.]+)/);
  return match ? match[1] : null;
}

/**
 * Permanently deletes a customer account and associated personal data across
 * Firebase Authentication, Cloudinary, and Firestore collections/subcollections.
 *
 * Legitimate business & accounting records (Orders) are retained for legal and tax
 * compliance, with all customer-identifiable information (name, email, phone, notes,
 * address contact info) permanently stripped and anonymized.
 *
 * @param {string} targetUid - User ID to delete
 * @param {object} requestingUser - req.user ({ uid, role })
 * @param {object} options - { password?: string, forceAdmin?: boolean }
 */
async function deleteUserAccount(targetUid, requestingUser, options = {}) {
  if (!targetUid) {
    const err = new Error("User ID is required");
    err.statusCode = 400;
    throw err;
  }

  const isAdmin = requestingUser && requestingUser.role === ROLES.ADMIN;
  const isOwner = requestingUser && requestingUser.uid === targetUid;

  if (!isOwner && !isAdmin) {
    const err = new Error("Forbidden: You cannot delete another user's account");
    err.statusCode = 403;
    throw err;
  }

  // Fetch user profile from Firestore
  const user = await Users.findById(targetUid);
  if (!user) {
    // If user document is missing from Firestore, check if orphaned Firebase Auth record exists
    try {
      await firebase.authAdmin().getUser(targetUid);
      // Orphan exists in Auth — clean it up
      await firebase.authAdmin().deleteUser(targetUid);
      return {
        success: true,
        message: "Cleaned up orphaned authentication account.",
        summary: { uid: targetUid, userDocDeleted: false, authDeleted: true },
      };
    } catch (_authErr) {
      const err = new Error("User account not found");
      err.statusCode = 404;
      throw err;
    }
  }

  // Re-authentication check for account owners (admin or OTP-verified flow bypasses password requirement)
  if (!isAdmin && !options.forceVerified && user.passwordHash) {
    if (!options.password) {
      const err = new Error("Password is required to confirm account deletion");
      err.statusCode = 400;
      throw err;
    }
    const isMatch = await bcrypt.compare(options.password, user.passwordHash);
    if (!isMatch) {
      const err = new Error("Incorrect account password");
      err.statusCode = 401;
      throw err;
    }
  }

  // Prevent concurrent deletion operations
  if (user.deletionInProgress) {
    const err = new Error("Account deletion is already in progress for this user");
    err.statusCode = 409;
    throw err;
  }

  // Check for in-flight / active orders
  const activeOrdersSnap = await firebase
    .db()
    .collection(COLLECTIONS.ORDERS)
    .where("userId", "==", targetUid)
    .where("status", "in", ACTIVE_ORDER_STATUSES)
    .limit(1)
    .get();

  if (!activeOrdersSnap.empty && !options.forceAdmin) {
    const err = new Error(
      "Cannot delete account while you have active orders in progress. Please wait until your orders are delivered or cancelled."
    );
    err.statusCode = 400;
    throw err;
  }

  // Mark deletion in progress on user doc
  await firebase
    .db()
    .collection(COLLECTIONS.USERS)
    .doc(targetUid)
    .update({ deletionInProgress: true, deletionRequestedAt: Date.now() });

  const summary = {
    uid: targetUid,
    ordersAnonymized: 0,
    addressesDeleted: 0,
    shoppingListsDeleted: 0,
    notificationsDeleted: 0,
    cartDeleted: false,
    avatarDeleted: false,
    userDocDeleted: false,
    authDeleted: false,
    errors: [],
  };

  const firestore = firebase.db();

  // 1. Anonymize Orders (Legal & accounting record retention)
  try {
    const orderSnap = await firestore
      .collection(COLLECTIONS.ORDERS)
      .where("userId", "==", targetUid)
      .get();

    if (!orderSnap.empty) {
      const batchSize = 400;
      let batch = firestore.batch();
      let count = 0;

      for (const doc of orderSnap.docs) {
        batch.update(doc.ref, {
          userName: "Deleted Customer",
          userEmail: null,
          userPhone: null,
          notes: null,
          "addressSnapshot.contactName": "Deleted Customer",
          "addressSnapshot.mobile": null,
          "addressSnapshot.houseNo": "Redacted",
          "addressSnapshot.street": "Redacted",
          "addressSnapshot.landmark": null,
          deliveryReview: null,
          hiddenFromUser: true,
          userAnonymized: true,
          anonymizedAt: Date.now(),
          updatedAt: Date.now(),
        });
        count++;
        if (count % batchSize === 0) {
          await batch.commit();
          batch = firestore.batch();
        }
      }
      if (count % batchSize !== 0) {
        await batch.commit();
      }
      summary.ordersAnonymized = count;
    }
  } catch (err) {
    console.error(`[AccountDeletion] Order anonymization failed for ${targetUid}:`, err);
    summary.errors.push({ step: "ordersAnonymization", error: err.message });
  }

  // 2. Delete Addresses subcollection
  try {
    const addrSnap = await firestore
      .collection(COLLECTIONS.USERS)
      .doc(targetUid)
      .collection("addresses")
      .get();

    if (!addrSnap.empty) {
      const batch = firestore.batch();
      addrSnap.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      summary.addressesDeleted = addrSnap.docs.length;
    }
  } catch (err) {
    console.error(`[AccountDeletion] Addresses deletion failed for ${targetUid}:`, err);
    summary.errors.push({ step: "addressesDeletion", error: err.message });
  }

  // Saved lists are private account data and must be removed with the account.
  try {
    const lists = await firestore.collection(COLLECTIONS.USERS).doc(targetUid).collection("shoppingLists").get();
    for (let offset = 0; offset < lists.docs.length; offset += 450) {
      const batch = firestore.batch();
      lists.docs.slice(offset, offset + 450).forEach(doc => batch.delete(doc.ref));
      await batch.commit();
    }
    summary.shoppingListsDeleted = lists.docs.length;
  } catch (err) {
    summary.errors.push({ step: "shoppingListsDeletion", error: err.message });
  }

  // 3. Delete Notifications subcollection
  try {
    const notifSnap = await firestore
      .collection(COLLECTIONS.USERS)
      .doc(targetUid)
      .collection("notifications")
      .get();

    if (!notifSnap.empty) {
      const batch = firestore.batch();
      notifSnap.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      summary.notificationsDeleted = notifSnap.docs.length;
    }
  } catch (err) {
    console.error(`[AccountDeletion] Notifications deletion failed for ${targetUid}:`, err);
    summary.errors.push({ step: "notificationsDeletion", error: err.message });
  }

  // 4. Delete Cart document
  try {
    await firestore.collection(COLLECTIONS.CARTS).doc(targetUid).delete();
    summary.cartDeleted = true;
  } catch (err) {
    console.error(`[AccountDeletion] Cart deletion failed for ${targetUid}:`, err);
    summary.errors.push({ step: "cartDeletion", error: err.message });
  }

  // 5. Delete Cloudinary Profile Image (if any)
  if (user.profileImage) {
    const publicId = extractCloudinaryPublicId(user.profileImage);
    if (publicId) {
      try {
        await storageService.destroy(publicId);
        summary.avatarDeleted = true;
      } catch (err) {
        console.error(`[AccountDeletion] Cloudinary avatar destroy failed for ${publicId}:`, err);
        summary.errors.push({ step: "cloudinaryAvatar", error: err.message });
      }
    }
  }

  // 6. Delete Delivery Partner doc if role is partner or document exists
  try {
    const dpRef = firestore.collection(COLLECTIONS.DELIVERY_PARTNERS).doc(targetUid);
    const dpSnap = await dpRef.get();
    if (dpSnap.exists) {
      await dpRef.delete();
      summary.deliveryPartnerDocDeleted = true;
    }
  } catch (err) {
    console.error(`[AccountDeletion] Delivery partner cleanup failed for ${targetUid}:`, err);
  }

  // 7. Delete Firestore User Document
  try {
    await firestore.collection(COLLECTIONS.USERS).doc(targetUid).delete();
    summary.userDocDeleted = true;
  } catch (err) {
    console.error(`[AccountDeletion] User doc deletion failed for ${targetUid}:`, err);
    summary.errors.push({ step: "userDocDeletion", error: err.message });
  }

  // 8. Delete Firebase Authentication user
  try {
    await firebase.authAdmin().deleteUser(targetUid);
    summary.authDeleted = true;
  } catch (err) {
    if (err.code === "auth/user-not-found") {
      summary.authDeleted = true; // Not mirrored or already removed
    } else {
      console.error(`[AccountDeletion] Firebase Auth deletion failed for ${targetUid}:`, err);
      summary.errors.push({ step: "firebaseAuthDeletion", error: err.message });
    }
  }

  return {
    success: true,
    message: "Your account and associated personal data have been permanently deleted.",
    summary,
  };
}

module.exports = {
  deleteUserAccount,
  extractCloudinaryPublicId,
};
