const test = require("node:test");
const assert = require("node:assert/strict");
const Joi = require("joi");
const firebase = require("../src/config/firebase");

// Build 55 mock product records
const mockProducts = [];
for (let i = 1; i <= 55; i++) {
  mockProducts.push({
    id: `prod_${String(i).padStart(3, "0")}`,
    name: `Product ${i}`,
    categoryId: i % 2 === 0 ? "cat_even" : "cat_odd",
    price: i * 10,
    createdAt: 1000 + i,
  });
}

function createMockCollection(records, simulateIndexError = false) {
  function queryBuilder(filteredRecords, limitCount = null, orderConfig = null, startAfterDoc = null) {
    return {
      where(field, op, value) {
        const next = filteredRecords.filter((doc) => {
          if (op === "==") return doc[field] === value;
          if (op === "in") return Array.isArray(value) && value.includes(doc[field]);
          return true;
        });
        return queryBuilder(next, limitCount, orderConfig, startAfterDoc);
      },
      orderBy(field, dir = "asc") {
        return queryBuilder(filteredRecords, limitCount, { field, dir }, startAfterDoc);
      },
      startAfter(docSnap) {
        return queryBuilder(filteredRecords, limitCount, orderConfig, docSnap);
      },
      limit(n) {
        return queryBuilder(filteredRecords, n, orderConfig, startAfterDoc);
      },
      doc(id) {
        const doc = records.find((r) => r.id === id);
        return {
          get: async () => ({
            id,
            exists: !!doc,
            data: () => doc,
          }),
        };
      },
      get: async () => {
        if (simulateIndexError && orderConfig) {
          const err = new Error("The query requires an index.");
          err.code = 9;
          throw err;
        }

        let result = [...filteredRecords];
        if (orderConfig) {
          result.sort((a, b) => {
            const valA = a[orderConfig.field] || 0;
            const valB = b[orderConfig.field] || 0;
            return orderConfig.dir === "desc" ? (valB > valA ? 1 : valB < valA ? -1 : 0) : (valA > valB ? 1 : valA < valB ? -1 : 0);
          });
        }

        if (startAfterDoc && startAfterDoc.exists) {
          const startData = startAfterDoc.data();
          const startIndex = result.findIndex((r) => r.id === startAfterDoc.id);
          if (startIndex !== -1) {
            result = result.slice(startIndex + 1);
          }
        }

        if (limitCount !== null) {
          result = result.slice(0, limitCount);
        }

        return {
          docs: result.map((r) => ({
            id: r.id,
            data: () => ({ ...r }),
          })),
          size: result.length,
        };
      },
    };
  }

  return queryBuilder(records);
}

let mockError = false;
firebase.db = () => ({
  collection: (name) => createMockCollection(mockProducts, mockError),
});

const Repository = require("../src/models/Repository");

test("Repository.paginate tests", async (t) => {
  const schema = Joi.object({
    name: Joi.string().required(),
    categoryId: Joi.string().required(),
    price: Joi.number().required(),
    createdAt: Joi.number().required(),
  });

  t.beforeEach(() => {
    mockError = false;
  });

  await t.test("Default limit is 20 and limits the query result to 20 documents", async () => {
    const repo = new Repository("products", schema);
    const res = await repo.paginate();
    assert.equal(res.items.length, 20);
    assert.equal(res.hasMore, true);
    assert.equal(res.cursor, res.items[19].id);
  });

  await t.test("Custom limit=40 returns no more than 40 documents", async () => {
    const repo = new Repository("products", schema);
    const res = await repo.paginate({ limit: 40 });
    assert.equal(res.items.length, 40);
    assert.equal(res.hasMore, true);
    assert.equal(res.cursor, res.items[39].id);
  });

  await t.test("Invalid or missing limits safely default to 20", async () => {
    const repo = new Repository("products", schema);
    const resNegative = await repo.paginate({ limit: -5 });
    assert.equal(resNegative.items.length, 20);

    const resZero = await repo.paginate({ limit: 0 });
    assert.equal(resZero.items.length, 20);

    const resNaN = await repo.paginate({ limit: "invalid" });
    assert.equal(resNaN.items.length, 20);
  });

  await t.test("String numbers are parsed correctly (e.g. limit='15')", async () => {
    const repo = new Repository("products", schema);
    const res = await repo.paginate({ limit: "15" });
    assert.equal(res.items.length, 15);
    assert.equal(res.hasMore, true);
  });

  await t.test("Pagination across consecutive pages retrieves all documents without skipping or duplicating", async () => {
    const repo = new Repository("products", schema);
    const page1 = await repo.paginate({ limit: 20, orderBy: { field: "createdAt", dir: "asc" } });
    assert.equal(page1.items.length, 20);
    assert.equal(page1.hasMore, true);
    assert.ok(page1.cursor);

    const page2 = await repo.paginate({
      limit: 20,
      orderBy: { field: "createdAt", dir: "asc" },
      startAfter: page1.cursor,
    });
    assert.equal(page2.items.length, 20);
    assert.equal(page2.hasMore, true);
    assert.ok(page2.cursor);

    const page3 = await repo.paginate({
      limit: 20,
      orderBy: { field: "createdAt", dir: "asc" },
      startAfter: page2.cursor,
    });
    assert.equal(page3.items.length, 15); // 55 total - 40 = 15 remaining
    assert.equal(page3.hasMore, false);
    assert.equal(page3.cursor, null);

    // Verify all 55 unique IDs are retrieved without overlap
    const allIds = [
      ...page1.items.map((i) => i.id),
      ...page2.items.map((i) => i.id),
      ...page3.items.map((i) => i.id),
    ];
    assert.equal(allIds.length, 55);
    const uniqueIds = new Set(allIds);
    assert.equal(uniqueIds.size, 55);
  });

  await t.test("Where filters are applied alongside limit", async () => {
    const repo = new Repository("products", schema);
    const res = await repo.paginate({
      where: [["categoryId", "==", "cat_even"]],
      limit: 10,
    });
    assert.equal(res.items.length, 10);
    for (const item of res.items) {
      assert.equal(item.categoryId, "cat_even");
    }
    assert.equal(res.hasMore, true);
  });

  await t.test("Missing-index fallback (error code 9) handles limit and returns in-memory sorted items", async () => {
    mockError = true;
    const repo = new Repository("products", schema);
    const res = await repo.paginate({
      where: [["categoryId", "==", "cat_odd"]],
      orderBy: { field: "price", dir: "desc" },
      limit: 10,
    });
    assert.equal(res.items.length, 10);
    assert.equal(res.hasMore, false);
    assert.equal(res.cursor, null);
    // Verify descending order
    for (let i = 0; i < res.items.length - 1; i++) {
      assert.ok(res.items[i].price >= res.items[i + 1].price);
    }
  });
});
