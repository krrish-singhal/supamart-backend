const test = require("node:test");
const assert = require("node:assert");
const jwt = require("jsonwebtoken");
const app = require("../src/server");
const { ROLES } = require("../src/config/constants");

const JWT_SECRET = process.env.JWT_SECRET || "dev-jwt-secret";

function createToken(uid, role = ROLES.CUSTOMER) {
  return jwt.sign({ uid, role }, JWT_SECRET, { expiresIn: "1h" });
}

test("Application Regression Test Suite", async (t) => {
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

  await t.test("Health check and public info endpoints remain accessible", async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.status, "ok");

    const rootRes = await fetch(`${baseUrl}/`);
    assert.strictEqual(rootRes.status, 200);
    const rootData = await rootRes.json();
    assert.ok(rootData.status.includes("MS Traders API is running"));
  });

  await t.test("Auth: registration validates input properly without regression", async () => {
    const res = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.strictEqual(res.status, 422);
    const body = await res.json();
    assert.ok(body.error.includes("required"));
  });

  await t.test("Auth: login validates missing credentials", async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "test@example.com" }),
    });
    assert.strictEqual(res.status, 422);
    const body = await res.json();
    assert.ok(body.error.includes("password are required"));
  });

  await t.test("Cart: requires authentication", async () => {
    const res = await fetch(`${baseUrl}/api/cart`);
    assert.strictEqual(res.status, 401);
  });

  await t.test("Orders: /mine requires authentication", async () => {
    const res = await fetch(`${baseUrl}/api/orders/mine`);
    assert.strictEqual(res.status, 401);
  });

  await t.test("Orders: /:id requires authentication", async () => {
    const res = await fetch(`${baseUrl}/api/orders/order-123`);
    assert.strictEqual(res.status, 401);
  });

  await t.test("Admin: routes reject customer access with 403 Forbidden", async () => {
    const customerToken = createToken("cust-1", ROLES.CUSTOMER);
    const res = await fetch(`${baseUrl}/api/admin/cloudinary-signature`, {
      headers: { Authorization: `Bearer ${customerToken}` },
    });
    assert.strictEqual(res.status, 403);
  });

  await t.test("Firebase custom token: requires authentication", async () => {
    const res = await fetch(`${baseUrl}/api/auth/firebase-token`);
    assert.strictEqual(res.status, 401);
  });

  await t.test("Delivery delay: requires partner or admin role", async () => {
    const customerToken = createToken("cust-1", ROLES.CUSTOMER);
    const res = await fetch(`${baseUrl}/api/orders/order-123/delivery-delay`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${customerToken}`,
      },
      body: JSON.stringify({ newEstimatedTime: "25 mins", delayReason: "Traffic" }),
    });
    assert.strictEqual(res.status, 403);
  });

  await t.test("Delivery delay: validates mandatory time and reason for partner", async () => {
    const partnerToken = createToken("partner-1", ROLES.PARTNER);
    const res = await fetch(`${baseUrl}/api/orders/order-123/delivery-delay`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${partnerToken}`,
      },
      body: JSON.stringify({ newEstimatedTime: "" }),
    });
    assert.strictEqual(res.status, 422);
  });

  await t.test("Delivery delay: handles non-existent order safely without 500 error", async () => {
    const partnerToken = createToken("partner-1", ROLES.PARTNER);
    const res = await fetch(`${baseUrl}/api/orders/non-existent-order/delivery-delay`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${partnerToken}`,
      },
      body: JSON.stringify({ newEstimatedTime: "30 mins", delayReason: "Heavy Rain" }),
    });
    assert.strictEqual(res.status, 404);
  });

  await t.test("FCM Token: POST /fcm-token requires auth and validates input", async () => {
    const noAuthRes = await fetch(`${baseUrl}/api/auth/fcm-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "sample-fcm-token" }),
    });
    assert.strictEqual(noAuthRes.status, 401);

    const customerToken = createToken("cust-1", ROLES.CUSTOMER);
    const missingTokenRes = await fetch(`${baseUrl}/api/auth/fcm-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${customerToken}`,
      },
      body: JSON.stringify({}),
    });
    assert.strictEqual(missingTokenRes.status, 422);
  });
});
