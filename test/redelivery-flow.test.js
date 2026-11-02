require("dotenv").config();
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const app = require("../src/server");
const { db } = require("../src/config/firebase");
const { COLLECTIONS, ORDER_STATUS, ROLES } = require("../src/config/constants");

test("Free Replacement and Redelivery Workflow Test Suite", async (t) => {
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

  const adminToken = jwt.sign(
    { uid: "admin-redeliv-test", role: ROLES.ADMIN, email: "admin@supamart.test" },
    process.env.JWT_SECRET
  );

  const customerId = `cust-redeliv-${Date.now()}`;
  const customerToken = jwt.sign(
    { uid: customerId, role: ROLES.CUSTOMER, email: "cust@supamart.test" },
    process.env.JWT_SECRET
  );

  const createBaseOrder = (orderNo) => ({
    orderNo,
    originalOrderId: "orig-123",
    originalOrderNo: 8010,
    userId: customerId,
    userName: "Jane Customer",
    userEmail: "cust@supamart.test",
    userPhone: "9876543210",
    items: [
      {
        productId: "prod-corn",
        variantId: "default",
        name: "Sweet Corn",
        variantLabel: "1 unit",
        price: 50,
        originalPrice: 50,
        unitPrice: 50,
        qty: 2,
        isFreeReplacement: true,
      },
      {
        productId: "prod-talc",
        variantId: "default",
        name: "Yardley Talc",
        variantLabel: "1 unit",
        price: 85,
        originalPrice: 85,
        unitPrice: 85,
        qty: 1,
        isFreeReplacement: true,
      },
    ],
    itemsTotalValue: 185,
    subtotal: 185,
    discount: 185,
    replacementDiscount: 185,
    deliveryFee: 0,
    deliveryCharge: 0,
    total: 0,
    distanceKm: 2.5,
    addressSnapshot: {
      houseNo: "404",
      street: "Main Market",
      pincode: "695001",
      lat: 8.5241,
      lng: 76.9366,
    },
    paymentMethod: "FREE_REPLACEMENT",
    paymentStatus: "PAID",
    isRedelivery: true,
    redeliveryStatus: "AWAITING_CUSTOMER_CONFIRMATION",
    status: ORDER_STATUS.PLACED,
    statusHistory: [{ status: ORDER_STATUS.PLACED, at: Date.now() }],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  await t.test("Redelivery order retains item values, charges customer ₹0, and starts in AWAITING_CUSTOMER_CONFIRMATION", async () => {
    const origOrderNo = 8010;
    const redelivOrderNo = 8011;
    const orderId = `redeliv-order-${Date.now()}`;

    await db().collection(COLLECTIONS.ORDERS).doc(orderId).set(createBaseOrder(redelivOrderNo));

    try {
      // 1. Verify item prices are preserved, total is 0
      const snap = await db().collection(COLLECTIONS.ORDERS).doc(orderId).get();
      const doc = snap.data();
      assert.equal(doc.items[0].price, 50);
      assert.equal(doc.items[1].price, 85);
      assert.equal(doc.total, 0);
      assert.equal(doc.itemsTotalValue, 185);
      assert.equal(doc.isRedelivery, true);
      assert.equal(doc.redeliveryStatus, "AWAITING_CUSTOMER_CONFIRMATION");

      // 2. Fetch via pending-redelivery route for customer
      const pendRes = await fetch(`${baseUrl}/api/orders/pending-redelivery`, {
        headers: { Authorization: `Bearer ${customerToken}` },
      });
      assert.equal(pendRes.status, 200);
      const pendBody = await pendRes.json();
      assert.ok(pendBody.order, "Should find pending redelivery order for customer");
      assert.equal(pendBody.order.orderNo, redelivOrderNo);

      // 3. Admin assignment is blocked while awaiting customer confirmation
      const assignRes = await fetch(`${baseUrl}/api/orders/${orderId}/assign`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ partnerId: "partner-test-1" }),
      });
      assert.equal(assignRes.status, 422);
      const assignErr = await assignRes.json();
      assert.equal(assignErr.code, "AWAITING_CUSTOMER_CONFIRMATION");

      // 4. Admin sends reminder
      const remindRes = await fetch(`${baseUrl}/api/orders/${orderId}/redelivery/reminder`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.equal(remindRes.status, 200);
      const remindBody = await remindRes.json();
      assert.equal(remindBody.success, true);

      // 5. Customer confirms availability (YES)
      const confRes = await fetch(`${baseUrl}/api/orders/${orderId}/redelivery/respond`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${customerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "CONFIRM" }),
      });
      assert.equal(confRes.status, 200);
      const confBody = await confRes.json();
      assert.equal(confBody.redeliveryStatus, "CONFIRMED");
      assert.equal(confBody.status, ORDER_STATUS.ORDER_ACCEPTED);

      // 6. Verify admin alert was sent for confirmation
      const alertSnap = await db()
        .collection(COLLECTIONS.ADMIN_ALERTS || "adminAlerts")
        .where("orderId", "==", orderId)
        .where("type", "==", "REDELIVERY_CONFIRMED")
        .get();
      assert.ok(!alertSnap.empty, "Admin alert should have been recorded for REDELIVERY_CONFIRMED");
    } finally {
      await db().collection(COLLECTIONS.ORDERS).doc(orderId).delete().catch(() => {});
    }
  });

  await t.test("Customer selecting RESCHEDULE sets slot and alerts admin", async () => {
    const orderId = `redeliv-reschedule-${Date.now()}`;
    await db().collection(COLLECTIONS.ORDERS).doc(orderId).set(createBaseOrder(8012));

    try {
      const res = await fetch(`${baseUrl}/api/orders/${orderId}/redelivery/respond`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${customerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "RESCHEDULE",
          slot: "Tomorrow, 4:00 PM – 6:00 PM",
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.redeliveryStatus, "RESCHEDULED");
      assert.equal(body.rescheduledSlot, "Tomorrow, 4:00 PM – 6:00 PM");

      const alertSnap = await db()
        .collection(COLLECTIONS.ADMIN_ALERTS || "adminAlerts")
        .where("orderId", "==", orderId)
        .where("type", "==", "REDELIVERY_RESCHEDULED")
        .get();
      assert.ok(!alertSnap.empty, "Admin alert should have been recorded for REDELIVERY_RESCHEDULED");
    } finally {
      await db().collection(COLLECTIONS.ORDERS).doc(orderId).delete().catch(() => {});
    }
  });

  await t.test("Customer DECLINE marks redelivery declined, cancels order, and blocks partner dispatch", async () => {
    const orderId = `redeliv-decline-${Date.now()}`;
    await db().collection(COLLECTIONS.ORDERS).doc(orderId).set(createBaseOrder(8013));

    try {
      const res = await fetch(`${baseUrl}/api/orders/${orderId}/redelivery/respond`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${customerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "DECLINE",
          reason: "I prefer a refund instead",
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.redeliveryStatus, "DECLINED");
      assert.equal(body.status, ORDER_STATUS.CANCELLED);
      assert.ok(body.cancelReason.includes("I prefer a refund instead"));

      // Assignment is blocked when redelivery is DECLINED
      const assignRes = await fetch(`${baseUrl}/api/orders/${orderId}/assign`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ partnerId: "partner-test-1" }),
      });
      assert.equal(assignRes.status, 422);
      const assignErr = await assignRes.json();
      assert.ok(
        assignErr.code === "ORDER_CLOSED" || assignErr.code === "REDELIVERY_DECLINED",
        `Expected ORDER_CLOSED or REDELIVERY_DECLINED, got ${assignErr.code}`
      );
    } finally {
      await db().collection(COLLECTIONS.ORDERS).doc(orderId).delete().catch(() => {});
    }
  });

  await t.test("Admin initiating redelivery creates free replacement linked to original order", async () => {
    const origOrderId = `orig-order-test-${Date.now()}`;
    const origOrderNo = 9911;

    // Create an original delivered order
    await db().collection(COLLECTIONS.ORDERS).doc(origOrderId).set({
      orderNo: origOrderNo,
      userId: customerId,
      userName: "Jane Customer",
      userEmail: "cust@supamart.test",
      userPhone: "9876543210",
      items: [
        {
          productId: "prod-milk",
          name: "Organic Milk",
          variantLabel: "1L",
          price: 65,
          qty: 2,
        },
      ],
      total: 130,
      subtotal: 130,
      status: ORDER_STATUS.DELIVERED,
      createdAt: Date.now() - 3600000,
      updatedAt: Date.now() - 3600000,
    });

    let createdRedeliveryId = null;
    try {
      // Admin initiates redelivery
      const res = await fetch(`${baseUrl}/api/orders/${origOrderId}/redelivery`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          reason: "Items damaged in transit",
        }),
      });

      assert.equal(res.status, 201);
      const data = await res.json();
      assert.ok(data.id, "Should return created replacement order ID");
      createdRedeliveryId = data.id;

      // Assertions matching instructions:
      // 1. Free replacement record linked to original order
      assert.equal(data.isRedelivery, true);
      assert.equal(data.originalOrderId, origOrderId);
      assert.equal(data.originalOrderNo, origOrderNo);

      // 2. Customer must NOT be charged again (total: 0, paymentMethod: FREE_REPLACEMENT)
      assert.equal(data.total, 0);
      assert.equal(data.deliveryCharge, 0);
      assert.equal(data.tax, 0);
      assert.equal(data.paymentMethod, "FREE_REPLACEMENT");
      assert.equal(data.paymentStatus, "PAID");

      // 3. Status starts in AWAITING_CUSTOMER_CONFIRMATION, dispatch blocked
      assert.equal(data.redeliveryStatus, "AWAITING_CUSTOMER_CONFIRMATION");
      assert.equal(data.assignedPartnerId, null);
      assert.equal(data.customerAvailability?.status, "AWAITING");

      // 4. Original order is cross-referenced
      const origSnap = await db().collection(COLLECTIONS.ORDERS).doc(origOrderId).get();
      const origDoc = origSnap.data();
      assert.equal(origDoc.hasRedelivery, true);
      assert.equal(origDoc.replacementOrderId, data.id);
      assert.equal(origDoc.replacementOrderNo, data.orderNo);
    } finally {
      await db().collection(COLLECTIONS.ORDERS).doc(origOrderId).delete().catch(() => {});
      if (createdRedeliveryId) {
        await db().collection(COLLECTIONS.ORDERS).doc(createdRedeliveryId).delete().catch(() => {});
      }
    }
  });
});
