const test = require("node:test");
const assert = require("node:assert");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const app = require("../src/server");
const { ROLES } = require("../src/config/constants");

const JWT_SECRET = process.env.JWT_SECRET || "dev-jwt-secret";

function createToken(uid, role = ROLES.CUSTOMER) {
  return jwt.sign({ uid, role }, JWT_SECRET, { expiresIn: "1h" });
}

test("Account Deletion HTTP API Endpoints", async (t) => {
  let server;
  let baseUrl;

  test.before(() => {
    return new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  test.after(() => {
    if (server) {
      server.close();
    }
  });

  await t.test("DELETE /api/users/me: requires authentication", async () => {
    const res = await fetch(`${baseUrl}/api/users/me`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "some-password" }),
    });

    assert.strictEqual(res.status, 401);
    const body = await res.json();
    assert.strictEqual(body.error, "Missing token");
  });

  await t.test("DELETE /api/users/me: rejects invalid token", async () => {
    const res = await fetch(`${baseUrl}/api/users/me`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer invalid-token",
      },
      body: JSON.stringify({ password: "some-password" }),
    });

    assert.strictEqual(res.status, 401);
    const body = await res.json();
    assert.strictEqual(body.error, "Invalid token");
  });

  await t.test("POST /api/users/me/delete-otp: requires authentication", async () => {
    const res = await fetch(`${baseUrl}/api/users/me/delete-otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    assert.strictEqual(res.status, 401);
  });

  await t.test("GET /api/users/me/deletion-status: requires authentication", async () => {
    const res = await fetch(`${baseUrl}/api/users/me/deletion-status`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    assert.strictEqual(res.status, 401);
  });

  await t.test("DELETE /api/users/me: rejects request without otp or password", async () => {
    const userToken = createToken("cust-tester", ROLES.CUSTOMER);
    // Mock user exists in database for this call
    const Users = require("../src/models").Users;
    const origFindById = Users.findById;
    Users.findById = async () => ({ id: "cust-tester", email: "test@example.com" });
    try {
      const res = await fetch(`${baseUrl}/api/users/me`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({}),
      });
      assert.strictEqual(res.status, 400);
      const body = await res.json();
      assert.ok(body.error && body.error.includes("Confirmation code or password is required"));
    } finally {
      Users.findById = origFindById;
    }
  });

  await t.test("DELETE /api/users/:uid: customer cannot delete another user (403 Forbidden)", async () => {
    const attackerToken = createToken("cust-attacker", ROLES.CUSTOMER);
    const res = await fetch(`${baseUrl}/api/users/victim-uid`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${attackerToken}`,
      },
      body: JSON.stringify({ password: "some-password" }),
    });

    assert.strictEqual(res.status, 403);
    const body = await res.json();
    assert.ok(body.error && body.error.includes("You cannot delete another user's account"));
  });
});
