const test = require("node:test");
const assert = require("node:assert");
const bcrypt = require("bcryptjs");
const { deleteUserAccount, extractCloudinaryPublicId } = require("../src/services/accountDeletionService");
const { ROLES, ORDER_STATUS, COLLECTIONS } = require("../src/config/constants");

// Mock harness for testing account deletion logic without touching production
test("Account Deletion Service Unit Tests", async (t) => {
  await t.test("extractCloudinaryPublicId: extracts public ID correctly", () => {
    assert.strictEqual(
      extractCloudinaryPublicId("https://res.cloudinary.com/demo/image/upload/v1234567890/avatars/user_pic.jpg"),
      "avatars/user_pic"
    );
    assert.strictEqual(
      extractCloudinaryPublicId("https://res.cloudinary.com/demo/image/upload/avatars/sample.png"),
      "avatars/sample"
    );
    assert.strictEqual(extractCloudinaryPublicId("https://example.com/not-cloudinary.jpg"), null);
    assert.strictEqual(extractCloudinaryPublicId(null), null);
    assert.strictEqual(extractCloudinaryPublicId(""), null);
  });

  await t.test("deleteUserAccount: rejects unauthenticated or unauthorized deletion", async () => {
    // Missing targetUid
    await assert.rejects(
      async () => deleteUserAccount(null, { uid: "user-1", role: ROLES.CUSTOMER }),
      (err) => err.statusCode === 400 && err.message.includes("User ID is required")
    );

    // Customer trying to delete someone else's account
    await assert.rejects(
      async () => deleteUserAccount("victim-user", { uid: "attacker-user", role: ROLES.CUSTOMER }),
      (err) => err.statusCode === 403 && err.message.includes("You cannot delete another user's account")
    );
  });

  await t.test("deleteUserAccount: requires and validates password for customer", async () => {
    const passwordHash = await bcrypt.hash("CorrectPassword123", 10);

    // We mock Users.findById
    const Users = require("../src/models").Users;
    const origFindById = Users.findById;

    Users.findById = async (id) => {
      if (id === "cust-1") {
        return {
          id: "cust-1",
          email: "cust1@example.com",
          name: "Test User",
          passwordHash,
        };
      }
      return null;
    };

    try {
      // 1. Password omitted
      await assert.rejects(
        async () => deleteUserAccount("cust-1", { uid: "cust-1", role: ROLES.CUSTOMER }, {}),
        (err) => err.statusCode === 400 && err.message.includes("Password is required")
      );

      // 2. Incorrect password
      await assert.rejects(
        async () => deleteUserAccount("cust-1", { uid: "cust-1", role: ROLES.CUSTOMER }, { password: "WrongPassword" }),
        (err) => err.statusCode === 401 && err.message.includes("Incorrect account password")
      );
    } finally {
      Users.findById = origFindById;
    }
  });

  await t.test("deleteUserAccount: prevents deletion when active order is in progress", async () => {
    const passwordHash = await bcrypt.hash("Password123", 10);
    const Users = require("../src/models").Users;
    const firebase = require("../src/config/firebase");
    const origFindById = Users.findById;
    const origDb = firebase.db;

    Users.findById = async () => ({
      id: "cust-active",
      passwordHash,
      deletionInProgress: false,
    });

    firebase.db = () => ({
      collection: (col) => {
        if (col === COLLECTIONS.ORDERS) {
          return {
            where: () => ({
              where: () => ({
                limit: () => ({
                  get: async () => ({ empty: false, docs: [{ id: "order-in-progress" }] }),
                }),
              }),
            }),
          };
        }
        return {};
      },
    });

    try {
      await assert.rejects(
        async () => deleteUserAccount("cust-active", { uid: "cust-active", role: ROLES.CUSTOMER }, { password: "Password123" }),
        (err) => err.statusCode === 400 && err.message.includes("active orders in progress")
      );
    } finally {
      Users.findById = origFindById;
      firebase.db = origDb;
    }
  });

  await t.test("deleteUserAccount: prevents concurrent duplicate deletion", async () => {
    const passwordHash = await bcrypt.hash("Password123", 10);
    const Users = require("../src/models").Users;
    const origFindById = Users.findById;

    Users.findById = async () => ({
      id: "cust-locked",
      passwordHash,
      deletionInProgress: true,
    });

    try {
      await assert.rejects(
        async () => deleteUserAccount("cust-locked", { uid: "cust-locked", role: ROLES.CUSTOMER }, { password: "Password123" }),
        (err) => err.statusCode === 409 && err.message.includes("already in progress")
      );
    } finally {
      Users.findById = origFindById;
    }
  });

  await t.test("deleteUserAccount: performs complete cleanup and anonymization", async () => {
    const passwordHash = await bcrypt.hash("Password123", 10);
    const Users = require("../src/models").Users;
    const firebase = require("../src/config/firebase");
    const storageService = require("../src/services/storageService");

    const origFindById = Users.findById;
    const origDb = firebase.db;
    const origAuthAdmin = firebase.authAdmin;
    const origDestroy = storageService.destroy;

    let destroyedCloudinaryId = null;
    let deletedAuthUid = null;
    let deletedUserDoc = null;
    let deletedCartDoc = null;
    let anonymizedOrders = [];
    let deletedAddresses = [];
    let deletedNotifications = [];

    storageService.destroy = async (id) => {
      destroyedCloudinaryId = id;
    };

    Users.findById = async () => ({
      id: "cust-complete",
      passwordHash,
      profileImage: "https://res.cloudinary.com/supamart/image/upload/v1234/avatars/user-avatar.jpg",
      deletionInProgress: false,
    });

    const mockBatch = {
      update: (ref, data) => anonymizedOrders.push({ ref: ref.id, data }),
      delete: (ref) => {
        if (ref.type === "address") deletedAddresses.push(ref.id);
        if (ref.type === "notification") deletedNotifications.push(ref.id);
      },
      commit: async () => {},
    };

    firebase.authAdmin = () => ({
      deleteUser: async (uid) => {
        deletedAuthUid = uid;
      },
    });

    firebase.db = () => ({
      batch: () => mockBatch,
      collection: (col) => {
        if (col === COLLECTIONS.USERS) {
          return {
            doc: (uid) => ({
              update: async () => {},
              delete: async () => {
                deletedUserDoc = uid;
              },
              collection: (subCol) => {
                if (subCol === "addresses") {
                  return {
                    get: async () => ({
                      empty: false,
                      docs: [
                        { id: "addr-1", ref: { id: "addr-1", type: "address" } },
                        { id: "addr-2", ref: { id: "addr-2", type: "address" } },
                      ],
                    }),
                  };
                }
                if (subCol === "notifications") {
                  return {
                    get: async () => ({
                      empty: false,
                      docs: [
                        { id: "notif-1", ref: { id: "notif-1", type: "notification" } },
                      ],
                    }),
                  };
                }
                return { get: async () => ({ empty: true, docs: [] }) };
              },
            }),
          };
        }
        if (col === COLLECTIONS.ORDERS) {
          return {
            where: (field, op, val) => {
              if (field === "userId") {
                return {
                  where: () => ({
                    limit: () => ({
                      get: async () => ({ empty: true, docs: [] }), // No active orders
                    }),
                  }),
                  get: async () => ({
                    empty: false,
                    docs: [
                      {
                        id: "order-old-1",
                        ref: { id: "order-old-1" },
                        data: () => ({ orderNo: 101, total: 500, userName: "Customer", userEmail: "c@c.com" }),
                      },
                    ],
                  }),
                };
              }
              return { get: async () => ({ empty: true, docs: [] }) };
            },
          };
        }
        if (col === COLLECTIONS.CARTS) {
          return {
            doc: (uid) => ({
              delete: async () => {
                deletedCartDoc = uid;
              },
            }),
          };
        }
        if (col === COLLECTIONS.DELIVERY_PARTNERS) {
          return {
            doc: () => ({
              get: async () => ({ exists: false }),
            }),
          };
        }
        return {};
      },
    });

    try {
      const res = await deleteUserAccount(
        "cust-complete",
        { uid: "cust-complete", role: ROLES.CUSTOMER },
        { password: "Password123" }
      );

      assert.strictEqual(res.success, true);
      assert.strictEqual(res.summary.userDocDeleted, true);
      assert.strictEqual(res.summary.authDeleted, true);
      assert.strictEqual(res.summary.cartDeleted, true);
      assert.strictEqual(res.summary.avatarDeleted, true);
      assert.strictEqual(res.summary.ordersAnonymized, 1);
      assert.strictEqual(res.summary.addressesDeleted, 2);
      assert.strictEqual(res.summary.notificationsDeleted, 1);

      // Verify specific side effects
      assert.strictEqual(deletedUserDoc, "cust-complete");
      assert.strictEqual(deletedCartDoc, "cust-complete");
      assert.strictEqual(deletedAuthUid, "cust-complete");
      assert.strictEqual(destroyedCloudinaryId, "avatars/user-avatar");
      assert.strictEqual(deletedAddresses.length, 2);
      assert.strictEqual(deletedNotifications.length, 1);

      // Verify order anonymization fields
      assert.strictEqual(anonymizedOrders.length, 1);
      const orderUpdate = anonymizedOrders[0].data;
      assert.strictEqual(orderUpdate.userName, "Deleted Customer");
      assert.strictEqual(orderUpdate.userEmail, null);
      assert.strictEqual(orderUpdate.userPhone, null);
      assert.strictEqual(orderUpdate.hiddenFromUser, true);
      assert.strictEqual(orderUpdate.userAnonymized, true);
      assert.strictEqual(orderUpdate["addressSnapshot.contactName"], "Deleted Customer");
      assert.strictEqual(orderUpdate["addressSnapshot.houseNo"], "Redacted");
    } finally {
      Users.findById = origFindById;
      firebase.db = origDb;
      firebase.authAdmin = origAuthAdmin;
      storageService.destroy = origDestroy;
    }
  });
});
