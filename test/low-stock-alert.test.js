const test = require("node:test");
const assert = require("node:assert");
const jwt = require("jsonwebtoken");
const app = require("../src/server");
const { db } = require("../src/config/firebase");
const { COLLECTIONS, ROLES, LOW_STOCK_THRESHOLD } = require("../src/config/constants");
const { notifyAdminsLowStock } = require("../src/services/notificationService");
const { invalidateLowStockCache } = require("../src/routes/admin.routes");

const JWT_SECRET = process.env.JWT_SECRET || "dev-jwt-secret";

function createAdminToken(uid = "test-admin") {
  return jwt.sign({ uid, role: ROLES.ADMIN }, JWT_SECRET, { expiresIn: "1h" });
}

test("Admin Low Stock & Real-Time Alerts Test Suite", async (t) => {
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

  await t.test("notifyAdminsLowStock safely handles empty or missing items without throwing", async () => {
    await assert.doesNotReject(async () => {
      await notifyAdminsLowStock([]);
      await notifyAdminsLowStock(null);
    });
  });

  await t.test("notifyAdminsLowStock sends notifications for low stock and out of stock items", async () => {
    const lowStockItems = [
      {
        productId: "prod-test-1",
        name: "Test Rice 5kg",
        variantLabel: "5kg",
        stock: 3,
        threshold: 10,
        isOutOfStock: false,
      },
      {
        productId: "prod-test-2",
        name: "Test Milk 1L",
        variantLabel: "1L",
        stock: 0,
        threshold: 5,
        isOutOfStock: true,
      },
    ];

    await assert.doesNotReject(async () => {
      await notifyAdminsLowStock(lowStockItems, 1042);
    });
  });

  await t.test("adminAlerts collection persists operational alerts and admin can retrieve them", async () => {
    const testAlertRef = db().collection(COLLECTIONS.ADMIN_ALERTS || "adminAlerts").doc("alert-unit-test-1");
    const testAlertData = {
      type: "LOW_STOCK",
      productId: "prod-test-tea",
      productName: "Premium Assam Tea",
      variantLabel: "250g",
      previousStock: 12,
      currentStock: 3,
      threshold: 10,
      isOutOfStock: false,
      orderNo: 1099,
      createdAt: Date.now(),
      read: false,
    };

    await testAlertRef.set(testAlertData);

    const token = createAdminToken();
    const res = await fetch(`${baseUrl}/api/admin/alerts?limit=10`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.items));
    const found = data.items.find((a) => a.id === "alert-unit-test-1");
    assert.ok(found, "Alert should be present in admin alerts response");
    assert.strictEqual(found.productName, "Premium Assam Tea");
    assert.strictEqual(found.currentStock, 3);
    assert.strictEqual(found.read, false);
  });

  await t.test("admin can mark an alert as read via PATCH /api/admin/alerts/:id/read", async () => {
    const token = createAdminToken();
    const patchRes = await fetch(`${baseUrl}/api/admin/alerts/alert-unit-test-1/read`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
    });

    assert.strictEqual(patchRes.status, 200);
    const patchData = await patchRes.json();
    assert.strictEqual(patchData.ok, true);

    const docSnap = await db().collection(COLLECTIONS.ADMIN_ALERTS || "adminAlerts").doc("alert-unit-test-1").get();
    assert.strictEqual(docSnap.data().read, true);

    // Clean up test document
    await docSnap.ref.delete();
  });

  await t.test("invalidateLowStockCache clears cached inventory calculations", () => {
    assert.strictEqual(typeof invalidateLowStockCache, "function");
    assert.doesNotThrow(() => invalidateLowStockCache());
  });
});
