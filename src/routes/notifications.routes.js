const express = require("express");
const { asyncHandler } = require("../middleware/error");
const { authenticate } = require("../middleware/auth");
const { db } = require("../config/firebase");
const { COLLECTIONS } = require("../config/constants");

const router = express.Router();

// PATCH /api/notifications/mark-all-read — customer marks their own notification
// inbox read. Firestore rules deny ALL client writes to users/{uid}/notifications
// (`allow write: if false` — see backend/firebase/firestore.rules) so the client
// can never do this write directly; this Admin-SDK route is the only way it happens.
router.patch(
  "/mark-all-read",
  authenticate,
  asyncHandler(async (req, res) => {
    const uid = req.user.uid;
    const unreadSnap = await db()
      .collection(COLLECTIONS.USERS)
      .doc(uid)
      .collection("notifications")
      .where("read", "==", false)
      .get();

    if (unreadSnap.empty) return res.json({ updated: 0 });

    // Firestore batch cap is 500 ops.
    const chunks = [];
    for (let i = 0; i < unreadSnap.docs.length; i += 450) chunks.push(unreadSnap.docs.slice(i, i + 450));
    for (const chunk of chunks) {
      const batch = db().batch();
      chunk.forEach((doc) => batch.update(doc.ref, { read: true }));
      await batch.commit();
    }

    res.json({ updated: unreadSnap.size });
  })
);

module.exports = router;
