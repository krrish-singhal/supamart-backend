require("dotenv").config();
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
const test = require("node:test");
const assert = require("node:assert/strict");
const { db } = require("../src/config/firebase");
const { COLLECTIONS, ORDER_STATUS, ISSUE_STATUS } = require("../src/config/constants");
const { updateStatus } = require("../src/services/orderService");

test("Order cancellation with reason and notifications", async (t) => {
  const orderId = `test-order-cancel-${Date.now()}`;
  const userId = `test-user-${Date.now()}`;
  const now = Date.now();

  const orderData = {
    orderNo: 9988,
    userId,
    status: ORDER_STATUS.PLACED,
    statusHistory: [{ status: ORDER_STATUS.PLACED, at: now }],
    items: [],
    total: 350,
    paymentMethod: "COD",
    paymentStatus: "PENDING",
    createdAt: now,
    updatedAt: now,
  };

  await db().collection(COLLECTIONS.ORDERS).doc(orderId).set(orderData);

  await t.test("cancelling order with reason persists cancelReason and adds adminAlert", async () => {
    const cancelReason = "Items out of stock in warehouse";
    const result = await updateStatus(orderId, ORDER_STATUS.CANCELLED, { role: "ADMIN" }, { reason: cancelReason });

    assert.equal(result.status, ORDER_STATUS.CANCELLED);

    const doc = await db().collection(COLLECTIONS.ORDERS).doc(orderId).get();
    const data = doc.data();

    assert.equal(data.status, ORDER_STATUS.CANCELLED);
    assert.equal(data.cancelReason, cancelReason);
    assert.equal(data.cancellationReason, cancelReason);

    // Verify last history item has the reason
    const lastHistory = data.statusHistory[data.statusHistory.length - 1];
    assert.equal(lastHistory.status, ORDER_STATUS.CANCELLED);
    assert.equal(lastHistory.reason, cancelReason);

    // Verify in-app notification sent to user contains cancellation reason
    const notifsSnap = await db().collection(COLLECTIONS.USERS).doc(userId).collection("notifications").get();
    assert.ok(!notifsSnap.empty, "Customer should have received a notification");
    const lastNotif = notifsSnap.docs[notifsSnap.docs.length - 1].data();
    assert.equal(lastNotif.title, "Order Cancelled");
    assert.ok(lastNotif.body.includes(cancelReason), `Notification body should contain reason: ${lastNotif.body}`);

    // Verify operational alert was recorded in adminAlerts
    const alertsSnap = await db().collection(COLLECTIONS.ADMIN_ALERTS || "adminAlerts")
      .where("orderId", "==", orderId)
      .where("type", "==", "ORDER_CANCELLED")
      .get();
    assert.ok(!alertsSnap.empty, "adminAlerts should have recorded ORDER_CANCELLED alert");
    const alert = alertsSnap.docs[0].data();
    assert.equal(alert.reason, cancelReason);
  });
});

test("Dynamic issue resolution for REDELIVER vs REFUND and admin note", async (t) => {
  const jwt = require("jsonwebtoken");
  const app = require("../src/server");
  const { ROLES } = require("../src/config/constants");

  let server;
  let baseUrl;

  test.before(() => {
    return new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  test.after(() => {
    if (server) server.close();
  });

  const adminToken = jwt.sign({ uid: "admin-tester", role: ROLES.ADMIN }, process.env.JWT_SECRET || "dev-jwt-secret", { expiresIn: "1h" });

  await t.test("REDELIVER resolution sets status, does not grant refund, and notifies redelivery", async () => {
    const issueId = `issue-redeliver-${Date.now()}`;
    const refundId = `refund-redeliver-${Date.now()}`;
    const userId = `user-redeliver-${Date.now()}`;
    const now = Date.now();

    await db().collection(COLLECTIONS.REFUNDS).doc(refundId).set({
      orderId: "ord-redeliver-1",
      orderNo: 4040,
      userId,
      status: "PENDING_APPROVAL",
      totalRefund: 150,
      createdAt: now,
    });

    await db().collection(COLLECTIONS.ISSUES).doc(issueId).set({
      orderId: "ord-redeliver-1",
      orderNo: 4040,
      userId,
      status: "OPEN",
      refundId,
      resolutionType: "REDELIVER",
      createdAt: now,
    });

    const res = await fetch(`${baseUrl}/api/issues/${issueId}/status`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        status: "RESOLVED",
        resolutionType: "REDELIVER",
        resolutionNotes: "Dispatched redelivery with driver Mohan",
      }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.resolutionType, "REDELIVER");

    // Check issue doc
    const issueDoc = await db().collection(COLLECTIONS.ISSUES).doc(issueId).get();
    assert.equal(issueDoc.data().resolutionType, "REDELIVER");
    assert.equal(issueDoc.data().status, "RESOLVED");

    // Check refund doc - must NOT be REFUND_GRANTED!
    const refundDoc = await db().collection(COLLECTIONS.REFUNDS).doc(refundId).get();
    assert.equal(refundDoc.data().status, "RESOLVED_REDELIVER");

    // Check user notification
    const userNotifs = await db().collection(COLLECTIONS.USERS).doc(userId).collection("notifications").get();
    assert.ok(!userNotifs.empty);
    const last = userNotifs.docs[userNotifs.docs.length - 1].data();
    assert.equal(last.title, "Redelivery Arranged");
    assert.ok(last.body.includes("Dispatched redelivery with driver Mohan"));
  });

  await t.test("admin note route PATCH /api/orders/:id/note saves internal note", async () => {
    const orderId = `order-note-test-${Date.now()}`;
    await db().collection(COLLECTIONS.ORDERS).doc(orderId).set({
      orderNo: 7777,
      status: ORDER_STATUS.PLACED,
      createdAt: Date.now(),
    });

    const res = await fetch(`${baseUrl}/api/orders/${orderId}/note`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ adminNote: "Customer requested contactless dropoff behind flower pot" }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.adminNote, "Customer requested contactless dropoff behind flower pot");

    const orderDoc = await db().collection(COLLECTIONS.ORDERS).doc(orderId).get();
    assert.equal(orderDoc.data().adminNote, "Customer requested contactless dropoff behind flower pot");
  });
});

