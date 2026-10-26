const test = require("node:test");
const assert = require("node:assert");
const jwt = require("jsonwebtoken");
const app = require("../src/server");
const { Orders } = require("../src/models");
const { assertValidTransition } = require("../src/services/orderService");
const { ORDER_STATUS, ROLES } = require("../src/config/constants");

const JWT_SECRET = process.env.JWT_SECRET || "dev-jwt-secret";
function createToken(uid, role = ROLES.ADMIN) {
  return jwt.sign({ uid, role }, JWT_SECRET, { expiresIn: "1h" });
}

test("Order Immutability & Transparency Unit Tests", async (t) => {
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

  await t.test("assertValidTransition: forbids transition from DELIVERED to any status", () => {
    // Attempting to cancel a delivered order
    assert.throws(
      () => assertValidTransition(ORDER_STATUS.DELIVERED, ORDER_STATUS.CANCELLED),
      (err) => {
        assert.strictEqual(err.statusCode, 422);
        assert.strictEqual(err.code, "ORDER_CLOSED");
        assert.ok(err.message.includes("finalized"));
        return true;
      }
    );

    // Attempting to reopen a delivered order to active status
    assert.throws(
      () => assertValidTransition(ORDER_STATUS.DELIVERED, ORDER_STATUS.PLACED),
      (err) => {
        assert.strictEqual(err.statusCode, 422);
        assert.strictEqual(err.code, "ORDER_CLOSED");
        return true;
      }
    );
  });

  await t.test("assertValidTransition: forbids transition from CANCELLED to any status", () => {
    // Attempting to reopen a cancelled order
    assert.throws(
      () => assertValidTransition(ORDER_STATUS.CANCELLED, ORDER_STATUS.PLACED),
      (err) => {
        assert.strictEqual(err.statusCode, 422);
        assert.strictEqual(err.code, "ORDER_CLOSED");
        return true;
      }
    );

    // Attempting to re-cancel an already cancelled order
    assert.throws(
      () => assertValidTransition(ORDER_STATUS.CANCELLED, ORDER_STATUS.CANCELLED),
      (err) => {
        assert.strictEqual(err.statusCode, 422);
        assert.strictEqual(err.code, "ORDER_CLOSED");
        return true;
      }
    );
  });

  await t.test("assertValidTransition: allows forward transitions on active orders", () => {
    assert.strictEqual(
      assertValidTransition(ORDER_STATUS.PLACED, ORDER_STATUS.ACCEPTED),
      true
    );
    assert.strictEqual(
      assertValidTransition(ORDER_STATUS.ACCEPTED, ORDER_STATUS.OUT_FOR_DELIVERY),
      true
    );
    assert.strictEqual(
      assertValidTransition(ORDER_STATUS.PLACED, ORDER_STATUS.CANCELLED),
      true
    );
  });

  await t.test("PATCH /api/orders/:id/assign: rejects assigning partner to DELIVERED order", async () => {
    const origFindById = Orders.findById;
    Orders.findById = async (id) => ({
      id,
      orderNo: 1042,
      status: ORDER_STATUS.DELIVERED,
    });

    try {
      const adminToken = createToken("admin-1", ROLES.ADMIN);
      const res = await fetch(`${baseUrl}/api/orders/order-delivered-1/assign`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ partnerId: "partner-9" }),
      });

      assert.strictEqual(res.status, 422);
      const body = await res.json();
      assert.strictEqual(body.code, "ORDER_CLOSED");
      assert.ok(body.error.includes("closed (DELIVERED)"));
    } finally {
      Orders.findById = origFindById;
    }
  });

  await t.test("PATCH /api/orders/:id/assign: rejects assigning partner to CANCELLED order", async () => {
    const origFindById = Orders.findById;
    Orders.findById = async (id) => ({
      id,
      orderNo: 1043,
      status: ORDER_STATUS.CANCELLED,
    });

    try {
      const adminToken = createToken("admin-1", ROLES.ADMIN);
      const res = await fetch(`${baseUrl}/api/orders/order-cancelled-1/assign`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ partnerId: "partner-9" }),
      });

      assert.strictEqual(res.status, 422);
      const body = await res.json();
      assert.strictEqual(body.code, "ORDER_CLOSED");
      assert.ok(body.error.includes("closed (CANCELLED)"));
    } finally {
      Orders.findById = origFindById;
    }
  });

  await t.test("PATCH /api/orders/:id/assign: stores partner details on order and unassigns cleanly", async () => {
    const origOrderFind = Orders.findById;
    const origOrderUpdate = Orders.update;
    const { DeliveryPartners } = require("../src/models");
    const origPartnerFind = DeliveryPartners.findById;

    let updatedPayload = null;
    Orders.findById = async (id) => ({
      id,
      orderNo: 1044,
      status: ORDER_STATUS.PLACED,
      userId: "user-1",
    });
    DeliveryPartners.findById = async (id) => ({
      id,
      name: "Suresh Patil",
      phone: "9812345678",
      mobile: "9812345678",
    });
    Orders.update = async (id, payload) => {
      updatedPayload = payload;
      return { id, ...payload };
    };

    try {
      const adminToken = createToken("admin-1", ROLES.ADMIN);
      // Assign partner
      const res = await fetch(`${baseUrl}/api/orders/order-placed-1/assign`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ partnerId: "partner-test-1" }),
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(updatedPayload.assignedPartnerId, "partner-test-1");
      assert.strictEqual(updatedPayload.deliveryBoyName, "Suresh Patil");
      assert.strictEqual(updatedPayload.deliveryBoyPhone, "9812345678");
      assert.deepStrictEqual(updatedPayload.deliveryPartner, {
        id: "partner-test-1",
        name: "Suresh Patil",
        phone: "9812345678",
      });

      // Unassign partner
      const unassignRes = await fetch(`${baseUrl}/api/orders/order-placed-1/assign`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ partnerId: null }),
      });

      assert.strictEqual(unassignRes.status, 200);
      assert.strictEqual(updatedPayload.assignedPartnerId, null);
      assert.strictEqual(updatedPayload.deliveryBoyName, null);
      assert.strictEqual(updatedPayload.deliveryBoyPhone, null);
      assert.strictEqual(updatedPayload.deliveryPartner, null);
    } finally {
      Orders.findById = origOrderFind;
      Orders.update = origOrderUpdate;
      DeliveryPartners.findById = origPartnerFind;
    }
  });

  await t.test("PATCH /api/orders/:id/reject-assignment: partner rejection and GET /api/orders filtering", async () => {
    const origOrderFind = Orders.findById;
    const origOrderUpdate = Orders.update;
    const origOrderPaginate = Orders.paginate;

    let updatedPayload = null;
    Orders.findById = async (id) => ({
      id,
      orderNo: 1045,
      status: ORDER_STATUS.ACCEPTED,
      assignedPartnerId: "partner-1",
      deliveryBoyName: "Ramesh Rider",
      deliveryAcceptanceStatus: "PENDING",
    });
    Orders.update = async (id, update) => {
      updatedPayload = update;
      return { id, ...update };
    };

    try {
      const partnerToken = createToken("partner-1", ROLES.PARTNER);
      const res = await fetch(`${baseUrl}/api/orders/order-placed-2/reject-assignment`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${partnerToken}`,
        },
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(updatedPayload.deliveryAcceptanceStatus, "REJECTED");
      assert.strictEqual(updatedPayload.rejectedByPartnerId, "partner-1");
      assert.strictEqual(updatedPayload.rejectedByPartnerName, "Ramesh Rider");

      // Now verify GET /api/orders excludes this order for the partner
      Orders.paginate = async () => ({
        items: [
          { id: "o1", orderNo: 1045, deliveryAcceptanceStatus: "REJECTED", assignedPartnerId: "partner-1" },
          { id: "o2", orderNo: 1046, deliveryAcceptanceStatus: "ACCEPTED", assignedPartnerId: "partner-1" },
        ],
        total: 2,
      });

      const getRes = await fetch(`${baseUrl}/api/orders`, {
        headers: { Authorization: `Bearer ${partnerToken}` },
      });
      assert.strictEqual(getRes.status, 200);
      const data = await getRes.json();
      assert.strictEqual(data.items.length, 1);
      assert.strictEqual(data.items[0].id, "o2");
      assert.strictEqual(data.items[0].deliveryAcceptanceStatus, "ACCEPTED");
    } finally {
      Orders.findById = origOrderFind;
      Orders.update = origOrderUpdate;
      Orders.paginate = origOrderPaginate;
    }
  });

  await t.test("PATCH /api/orders/:id/status: delivery partner cannot directly mark DELIVERED", async () => {
    const { db } = require("../src/config/firebase");
    const orderRef = db().collection("orders").doc("test-partner-delivered-lock");
    await orderRef.set({
      orderNo: 1048,
      status: ORDER_STATUS.OUT_FOR_DELIVERY,
      assignedPartnerId: "partner-1",
      userId: "user-1",
      paymentMethod: "ONLINE",
      paymentStatus: "PAID",
      statusHistory: [],
      createdAt: Date.now(),
    });

    try {
      const partnerToken = createToken("partner-1", ROLES.PARTNER);
      const res = await fetch(`${baseUrl}/api/orders/test-partner-delivered-lock/status`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${partnerToken}`,
        },
        body: JSON.stringify({ status: ORDER_STATUS.DELIVERED }),
      });

      // Status update directly to DELIVERED by PARTNER must be rejected
      assert.strictEqual(res.status, 403);
      const body = await res.json();
      assert.ok(body.error.includes("Partners cannot mark orders as completed directly"));
    } finally {
      await orderRef.delete().catch(() => {});
    }
  });

  await t.test("PATCH /api/orders/:id/assign: admin reassignment resets acceptance status and clears rejection info", async () => {
    const origOrderFind = Orders.findById;
    const origOrderUpdate = Orders.update;
    const { DeliveryPartners } = require("../src/models");
    const origPartnerFind = DeliveryPartners.findById;

    let updatedPayload = null;
    Orders.findById = async (id) => ({
      id,
      orderNo: 1047,
      status: ORDER_STATUS.ACCEPTED,
      assignedPartnerId: "partner-1",
      deliveryBoyName: "Ramesh Rider",
      deliveryAcceptanceStatus: "REJECTED",
      rejectedByPartnerId: "partner-1",
      rejectedByPartnerName: "Ramesh Rider",
    });
    Orders.update = async (id, update) => {
      updatedPayload = update;
      return { id, ...update };
    };
    DeliveryPartners.findById = async (id) => ({
      id,
      name: "Suresh Patil",
      phone: "9812345678",
      isOnDuty: true,
      isActive: true,
    });

    try {
      const adminToken = createToken("admin-1", ROLES.ADMIN);
      const res = await fetch(`${baseUrl}/api/orders/order-placed-3/assign`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ partnerId: "partner-2" }),
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(updatedPayload.assignedPartnerId, "partner-2");
      assert.strictEqual(updatedPayload.deliveryAcceptanceStatus, "PENDING");
      assert.strictEqual(updatedPayload.rejectedByPartnerId, null);
      assert.strictEqual(updatedPayload.rejectedByPartnerName, null);
      assert.strictEqual(updatedPayload.deliveryBoyName, "Suresh Patil");
    } finally {
      Orders.findById = origOrderFind;
      Orders.update = origOrderUpdate;
      DeliveryPartners.findById = origPartnerFind;
    }
  });
});

