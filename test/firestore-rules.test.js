const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require("@firebase/rules-unit-testing");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

const PROJECT_ID = "ms-traders-security-test";
const RULES_PATH = path.resolve(__dirname, "../firebase/firestore.rules");

test("Firestore Security Rules Suite", async (t) => {
  let testEnv;

  test.before(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        rules: fs.readFileSync(RULES_PATH, "utf8"),
        host: "127.0.0.1",
        port: 8088,
      },
    });

    // Seed test fixtures using admin context with rules bypassed
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();

      // Seed catalog
      await db.collection("products").doc("prod-1").set({
        name: "Fresh Tomatoes 1kg",
        price: 40,
        isActive: true,
      });
      await db.collection("categories").doc("cat-1").set({
        name: "Vegetables",
        isActive: true,
      });

      // Seed customer A data
      await db.collection("users").doc("cust-A").set({
        name: "Customer A",
        email: "custA@example.com",
        role: "CUSTOMER",
      });
      await db.collection("users").doc("cust-A").collection("addresses").doc("addr-A").set({
        houseNo: "12A",
        street: "Green Park",
        pincode: "695582",
      });
      await db.collection("users").doc("cust-A").collection("notifications").doc("notif-A").set({
        title: "Order update",
        read: false,
      });
      await db.collection("carts").doc("cust-A").set({
        items: [{ productId: "prod-1", qty: 2 }],
      });

      // Seed customer B data
      await db.collection("users").doc("cust-B").set({
        name: "Customer B",
        email: "custB@example.com",
        role: "CUSTOMER",
      });
      await db.collection("users").doc("cust-B").collection("addresses").doc("addr-B").set({
        houseNo: "99B",
        street: "Sunset Ave",
        pincode: "695582",
      });

      // Seed orders
      // Order 1: owned by cust-A, assigned to partner-1
      await db.collection("orders").doc("order-1").set({
        orderNo: 1001,
        userId: "cust-A",
        userName: "Customer A",
        userEmail: "custA@example.com",
        userPhone: "9876543210",
        total: 120,
        status: "ORDER_PLACED",
        assignedPartnerId: "partner-1",
      });

      // Order 2: owned by cust-B, unassigned
      await db.collection("orders").doc("order-2").set({
        orderNo: 1002,
        userId: "cust-B",
        userName: "Customer B",
        userEmail: "custB@example.com",
        userPhone: "9876543211",
        total: 250,
        status: "ORDER_PLACED",
      });

      // Order 3: owned by cust-B, assigned to partner-2
      await db.collection("orders").doc("order-3").set({
        orderNo: 1003,
        userId: "cust-B",
        total: 300,
        status: "OUT_FOR_DELIVERY",
        assignedPartnerId: "partner-2",
      });
    });
  });

  test.after(async () => {
    if (testEnv) {
      await testEnv.cleanup();
    }
  });

  await t.test("Catalog: public read is allowed, client write is denied", async () => {
    const unauthDb = testEnv.unauthenticatedContext().firestore();
    const custDb = testEnv.authenticatedContext("cust-A").firestore();

    // Public read
    await assertSucceeds(unauthDb.collection("products").doc("prod-1").get());
    await assertSucceeds(unauthDb.collection("categories").doc("cat-1").get());

    // Client write denied
    await assertFails(unauthDb.collection("products").doc("prod-new").set({ name: "Hacked" }));
    await assertFails(custDb.collection("products").doc("prod-1").update({ price: 0 }));
  });

  await t.test("Orders: unauthenticated read is denied", async () => {
    const unauthDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(unauthDb.collection("orders").doc("order-1").get());
    await assertFails(unauthDb.collection("orders").get());
  });

  await t.test("Orders: Customer A can read their own order but NOT Customer B's order", async () => {
    const custADb = testEnv.authenticatedContext("cust-A", { role: "CUSTOMER" }).firestore();

    // Can read own order
    await assertSucceeds(custADb.collection("orders").doc("order-1").get());

    // CANNOT read other customer's order
    await assertFails(custADb.collection("orders").doc("order-2").get());
    await assertFails(custADb.collection("orders").doc("order-3").get());
  });

  await t.test("Orders: Customer A can query only their own orders", async () => {
    const custADb = testEnv.authenticatedContext("cust-A", { role: "CUSTOMER" }).firestore();

    // Query scoped to own userId succeeds
    await assertSucceeds(custADb.collection("orders").where("userId", "==", "cust-A").get());

    // Query across all orders (unscoped) fails
    await assertFails(custADb.collection("orders").get());

    // Query scoped to another customer fails
    await assertFails(custADb.collection("orders").where("userId", "==", "cust-B").get());
  });

  await t.test("Orders: Delivery partner access is restricted to assigned orders", async () => {
    const partner1Db = testEnv.authenticatedContext("partner-1", { role: "PARTNER" }).firestore();
    const partner2Db = testEnv.authenticatedContext("partner-2", { role: "PARTNER" }).firestore();

    // Partner 1 can read order-1 (assigned to partner-1)
    await assertSucceeds(partner1Db.collection("orders").doc("order-1").get());

    // Partner 1 CANNOT read order-2 (unassigned) or order-3 (assigned to partner-2)
    await assertFails(partner1Db.collection("orders").doc("order-2").get());
    await assertFails(partner1Db.collection("orders").doc("order-3").get());

    // Partner 2 can read order-3 (assigned to partner-2) but NOT order-1
    await assertSucceeds(partner2Db.collection("orders").doc("order-3").get());
    await assertFails(partner2Db.collection("orders").doc("order-1").get());
  });

  await t.test("Orders: Admin can read any order and run queries", async () => {
    const adminDb = testEnv.authenticatedContext("admin-1", { role: "ADMIN" }).firestore();

    await assertSucceeds(adminDb.collection("orders").doc("order-1").get());
    await assertSucceeds(adminDb.collection("orders").doc("order-2").get());
    await assertSucceeds(adminDb.collection("orders").doc("order-3").get());
    await assertSucceeds(adminDb.collection("orders").get());
  });

  await t.test("Orders: Direct client writes are strictly denied for all roles", async () => {
    const custADb = testEnv.authenticatedContext("cust-A", { role: "CUSTOMER" }).firestore();
    const partner1Db = testEnv.authenticatedContext("partner-1", { role: "PARTNER" }).firestore();
    const adminDb = testEnv.authenticatedContext("admin-1", { role: "ADMIN" }).firestore();

    // Customer cannot create or modify orders directly via client SDK
    await assertFails(custADb.collection("orders").doc("order-1").update({ total: 10 }));
    await assertFails(custADb.collection("orders").doc("order-new").set({ total: 50 }));

    // Partner cannot modify status directly via client SDK (must go through backend)
    await assertFails(partner1Db.collection("orders").doc("order-1").update({ status: "DELIVERED" }));

    // Admin client SDK writes are denied (backend Admin SDK bypasses rules and executes safely)
    await assertFails(adminDb.collection("orders").doc("order-1").update({ status: "CANCELLED" }));
  });

  await t.test("Users and subcollections: privacy and role protection", async () => {
    const custADb = testEnv.authenticatedContext("cust-A", { role: "CUSTOMER" }).firestore();
    const custBDb = testEnv.authenticatedContext("cust-B", { role: "CUSTOMER" }).firestore();
    const adminDb = testEnv.authenticatedContext("admin-1", { role: "ADMIN" }).firestore();

    // Cust A can read own doc, address, notification, cart
    await assertSucceeds(custADb.collection("users").doc("cust-A").get());
    await assertSucceeds(custADb.collection("users").doc("cust-A").collection("addresses").doc("addr-A").get());
    await assertSucceeds(custADb.collection("users").doc("cust-A").collection("notifications").doc("notif-A").get());
    await assertSucceeds(custADb.collection("carts").doc("cust-A").get());

    // Cust A CANNOT read Cust B's doc, address, or cart
    await assertFails(custADb.collection("users").doc("cust-B").get());
    await assertFails(custADb.collection("users").doc("cust-B").collection("addresses").doc("addr-B").get());
    await assertFails(custADb.collection("carts").doc("cust-B").get());

    // Cust A CANNOT write to own doc to escalate role to ADMIN
    await assertFails(custADb.collection("users").doc("cust-A").update({ role: "ADMIN" }));

    // Cust A CANNOT write to own addresses or cart directly via client SDK
    await assertFails(custADb.collection("users").doc("cust-A").collection("addresses").doc("addr-new").set({ houseNo: "9" }));
    await assertFails(custADb.collection("carts").doc("cust-A").set({ items: [] }));

    // Admin can read customer data
    await assertSucceeds(adminDb.collection("users").doc("cust-A").get());
    await assertSucceeds(adminDb.collection("users").doc("cust-A").collection("addresses").doc("addr-A").get());
  });

  await t.test("Default deny: unmapped collections are blocked", async () => {
    const custADb = testEnv.authenticatedContext("cust-A").firestore();
    const unauthDb = testEnv.unauthenticatedContext().firestore();

    await assertFails(unauthDb.collection("secret_data").doc("d1").get());
    await assertFails(custADb.collection("secret_data").doc("d1").get());
    await assertFails(custADb.collection("orderIdempotency").doc("key1").get());
  });
});
