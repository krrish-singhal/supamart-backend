process.env.JWT_SECRET = 'coupon-tests-jwt-secret';
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const records = new Map([
  ['offers/WELCOME50', {
    id: 'WELCOME50',
    code: 'WELCOME50',
    kind: 'FLAT',
    value: 50,
    minValue: 100,
    isActive: true,
    validFrom: 0,
    validTo: Date.now() + 1000000,
    usedCount: 0,
  }],
  ['offers/EXPIRED10', {
    id: 'EXPIRED10',
    code: 'EXPIRED10',
    kind: 'FLAT',
    value: 10,
    minValue: 50,
    isActive: true,
    validFrom: 0,
    validTo: 100, // expired
    usedCount: 0,
  }],
  ['products/prod-1', {
    name: 'Sample Item',
    availability: 'AVAILABLE',
    variants: [{ id: 'default', label: '1 Unit', price: 150, offerPrice: 150, stock: 10 }],
  }],
  ['config/global', {
    minOrderValue: 50,
    taxPercent: 0,
    orderSeq: 1000,
    storeHours: { open: '00:00', close: '23:59' },
    deliveryArea: { center: { lat: 8.5, lng: 76.9 }, maxRadiusKm: 10 },
  }],
  ['users/user-1', {
    name: 'Test Customer',
    email: 'test@example.com',
    role: 'CUSTOMER',
    usedCoupons: [],
  }],
  ['users/user-2', {
    name: 'Second Customer',
    email: 'user2@example.com',
    role: 'CUSTOMER',
    usedCoupons: ['WELCOME50'],
  }],
  ['carts/user-1', {
    items: [{ productId: 'prod-1', variantId: 'default', qty: 1 }],
    couponCode: null,
  }],
  ['carts/user-2', {
    items: [{ productId: 'prod-1', variantId: 'default', qty: 1 }],
    couponCode: 'WELCOME50',
  }],
]);

const snapshot = (path) => ({
  id: path.split('/').at(-1),
  exists: records.has(path),
  data: () => (records.has(path) ? structuredClone(records.get(path)) : undefined),
  ref: reference(path),
});

function reference(path) {
  return {
    path,
    id: path.split('/').at(-1),
    collection: (name) => collection(`${path}/${name}`),
    get: async () => snapshot(path),
    set: async (value, opts) => {
      const prev = records.get(path) || {};
      const baseObj = opts?.merge ? { ...prev } : {};
      for (const [k, v] of Object.entries(value)) {
        if (v && v.constructor?.name === 'ArrayUnionTransform') {
          const arr = Array.isArray(baseObj[k]) ? [...baseObj[k]] : [];
          for (const el of v.elements) {
            if (!arr.includes(el)) arr.push(el);
          }
          baseObj[k] = arr;
        } else if (v && v.constructor?.name === 'ArrayRemoveTransform') {
          const arr = Array.isArray(baseObj[k]) ? [...baseObj[k]] : [];
          baseObj[k] = arr.filter((el) => !v.elements.includes(el));
        } else if (v && v.constructor?.name === 'NumericIncrementTransform') {
          baseObj[k] = (Number(baseObj[k]) || 0) + v.operand;
        } else {
          baseObj[k] = v;
        }
      }
      records.set(path, baseObj);
    },
    update: async (patch) => {
      const prev = records.get(path) || {};
      records.set(path, { ...prev, ...patch });
    },
    delete: async () => records.delete(path),
  };
}

function collection(path, filters = []) {
  return {
    doc: (id) => reference(`${path}/${id}`),
    where: (field, op, value) => collection(path, [...filters, [field, op, value]]),
    limit: () => collection(path, filters),
    get: async () => {
      const prefix = `${path}/`;
      const docs = [...records.keys()]
        .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
        .filter((key) => {
          const docData = records.get(key);
          if (!docData) return false;
          return filters.every(([field, op, val]) => {
            if (op === '==' || op === undefined) return docData[field] === val;
            if (op === '>=') return docData[field] >= val;
            if (op === '<=') return docData[field] <= val;
            return true;
          });
        })
        .map(snapshot);
      return { docs, empty: !docs.length, size: docs.length, forEach: (fn) => docs.forEach(fn) };
    },
  };
}

const firebase = require('../src/config/firebase');
firebase.db = () => ({
  collection,
  runTransaction: async (callback) =>
    callback({
      get: async (ref) => snapshot(ref.path),
      set: (ref, value, opts) => ref.set(value, opts),
      update: (ref, data) => ref.update(data),
      delete: (ref) => ref.delete(),
    }),
});

const { hasUserUsedCoupon, getUserUsedCoupons, markCouponUsedInTx, releaseCouponInTx } = require('../src/services/couponService');

test('hasUserUsedCoupon returns false for unused coupon and true for used coupon', async () => {
  assert.equal(await hasUserUsedCoupon('user-1', 'WELCOME50'), false);
  assert.equal(await hasUserUsedCoupon('user-2', 'WELCOME50'), true);
  assert.equal(await hasUserUsedCoupon(null, 'WELCOME50'), false);
  assert.equal(await hasUserUsedCoupon('user-1', null), false);
});

test('hasUserUsedCoupon detects coupon in user subcollection', async () => {
  records.set('users/user-sub/usedCoupons/WELCOME50', { code: 'WELCOME50', usedAt: Date.now() });
  assert.equal(await hasUserUsedCoupon('user-sub', 'WELCOME50'), true);
  assert.equal(await hasUserUsedCoupon('user-sub', 'OTHER'), false);
});

test('hasUserUsedCoupon detects coupon in past non-cancelled orders', async () => {
  records.set('orders/ord-past-1', {
    userId: 'user-orders',
    couponCode: 'WELCOME50',
    status: 'DELIVERED',
    paymentStatus: 'PAID',
  });
  assert.equal(await hasUserUsedCoupon('user-orders', 'WELCOME50'), true);

  // But if order was cancelled and payment failed, coupon is not counted as used
  records.set('orders/ord-past-cancelled', {
    userId: 'user-cancelled',
    couponCode: 'WELCOME50',
    status: 'CANCELLED',
    paymentStatus: 'FAILED',
  });
  assert.equal(await hasUserUsedCoupon('user-cancelled', 'WELCOME50'), false);
});

test('getUserUsedCoupons aggregates all used coupons for user', async () => {
  const used = await getUserUsedCoupons('user-2');
  assert(used.has('WELCOME50'));
  assert.equal(used.has('NONEXISTENT'), false);
});

// Setup Express app to test HTTP routes
const express = require('express');
const { errorHandler } = require('../src/middleware/error');
const app = express();
app.use(express.json());
app.use('/api/offers', require('../src/routes/offers.routes'));
app.use('/api/cart', require('../src/routes/cart.routes'));
app.use(errorHandler);

let server, base;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(() => server.close());

const tokenUser1 = jwt.sign({ uid: 'user-1', role: 'CUSTOMER' }, process.env.JWT_SECRET);
const tokenUser2 = jwt.sign({ uid: 'user-2', role: 'CUSTOMER' }, process.env.JWT_SECRET);

async function request(path, method = 'GET', body, token = null) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}

test('POST /api/offers/validate: validates coupon for fresh user and rejects already used coupon', async () => {
  // User 1 has NOT used WELCOME50
  const validRes = await request(
    '/offers/validate',
    'POST',
    { code: 'WELCOME50', subtotal: 200, items: [{ productId: 'prod-1', qty: 1 }] },
    tokenUser1
  );
  assert.equal(validRes.status, 200);
  assert.equal(validRes.body.code, 'WELCOME50');
  assert.equal(validRes.body.evaluatedDiscount, 50);

  // User 2 HAS already used WELCOME50
  const usedRes = await request(
    '/offers/validate',
    'POST',
    { code: 'WELCOME50', subtotal: 200, items: [{ productId: 'prod-1', qty: 1 }] },
    tokenUser2
  );
  assert.equal(usedRes.status, 422);
  assert(usedRes.body.error.includes('already used'));
  assert.equal(usedRes.body.code, 'COUPON_ALREADY_USED');
});

test('PATCH /api/cart/coupon: rejects already used coupon', async () => {
  // User 2 attempts to apply already used coupon
  const patchRes = await request('/cart/coupon', 'PATCH', { code: 'WELCOME50' }, tokenUser2);
  assert.equal(patchRes.status, 422);
  assert(patchRes.body.error.includes('already used'));

  // User 1 applies valid unused coupon
  const patchOk = await request('/cart/coupon', 'PATCH', { code: 'WELCOME50' }, tokenUser1);
  assert.equal(patchOk.status, 200);
  assert.equal(patchOk.body.couponCode, 'WELCOME50');
});

test('GET /api/cart: self-heals by removing already used coupon', async () => {
  // User 2 had WELCOME50 in their cart doc (e.g. from an old session)
  const cartRes = await request('/cart', 'GET', null, tokenUser2);
  assert.equal(cartRes.status, 200);
  // Should have cleared couponCode and given discount 0
  assert.equal(cartRes.body.couponCode, null);
  assert.equal(cartRes.body.discount, 0);
});

test('GET /api/offers/active: annotates offers with isUsed: true for user who used it', async () => {
  const activeResUser2 = await request('/offers/active', 'GET', null, tokenUser2);
  assert.equal(activeResUser2.status, 200);
  const welcomeOffer = activeResUser2.body.items.find((o) => o.code === 'WELCOME50');
  assert(welcomeOffer, 'WELCOME50 offer should be present');
  assert.equal(welcomeOffer.isUsed, true);
  assert.equal(welcomeOffer.alreadyUsed, true);

  const activeResUser1 = await request('/offers/active', 'GET', null, tokenUser1);
  const welcomeOfferUser1 = activeResUser1.body.items.find((o) => o.code === 'WELCOME50');
  assert(welcomeOfferUser1, 'WELCOME50 offer should be present');
  assert.equal(welcomeOfferUser1.isUsed, false);
  assert.equal(welcomeOfferUser1.alreadyUsed, false);
});

test('markCouponUsedInTx and releaseCouponInTx correctly record and revert usage', async () => {
  const userId = 'tx-user';
  records.set(`users/${userId}`, { usedCoupons: [] });
  records.set('offers/OFFER1', { usedCount: 0 });

  await firebase.db().runTransaction(async (tx) => {
    markCouponUsedInTx(tx, userId, 'OFFER1', 'ord-101', 'OFFER1', 50);
  });

  // Verify marked
  const userAfterMark = records.get(`users/${userId}`);
  assert(userAfterMark.usedCoupons.includes('OFFER1'));
  const subAfterMark = records.get(`users/${userId}/usedCoupons/OFFER1`);
  assert.equal(subAfterMark?.code, 'OFFER1');
  assert.equal(records.get('offers/OFFER1')?.usedCount, 1);

  // Now release
  await firebase.db().runTransaction(async (tx) => {
    releaseCouponInTx(tx, userId, 'OFFER1', 'OFFER1');
  });

  const userAfterRelease = records.get(`users/${userId}`);
  assert.equal(userAfterRelease.usedCoupons.includes('OFFER1'), false);
  assert.equal(records.has(`users/${userId}/usedCoupons/OFFER1`), false);
  assert.equal(records.get('offers/OFFER1')?.usedCount, 0);
});

