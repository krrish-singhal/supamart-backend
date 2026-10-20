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
});
