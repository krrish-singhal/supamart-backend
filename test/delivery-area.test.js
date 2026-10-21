process.env.JWT_SECRET ||= 'delivery-policy-tests-only';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { STORE_LOCATION, SERVICE_RADIUS_KM, EARTH_RADIUS_KM, haversineKm, validCoordinates, evaluateServiceArea, withDeliveryArea } = require('../src/config/deliveryArea');
const { evaluateDelivery } = require('../src/services/geoService');
const { configSchema } = require('../src/schemas/config.schema');

// Independent spherical destination construction, in every direction around the shop.
function destination(km, bearingDegrees) {
  const lat = STORE_LOCATION.lat * Math.PI / 180;
  const lng = STORE_LOCATION.lng * Math.PI / 180;
  const bearing = bearingDegrees * Math.PI / 180;
  const arc = km / EARTH_RADIUS_KM;
  const endLat = Math.asin(Math.sin(lat) * Math.cos(arc) + Math.cos(lat) * Math.sin(arc) * Math.cos(bearing));
  const endLng = lng + Math.atan2(Math.sin(bearing) * Math.sin(arc) * Math.cos(lat), Math.cos(arc) - Math.sin(lat) * Math.sin(endLat));
  return { lat: endLat * 180 / Math.PI, lng: endLng * 180 / Math.PI };
}
const staleConfig = {
  storeLat: 28.6139, storeLng: 77.209, serviceRadiusKm: 999,
  minOrderValue: 100, taxPercent: 0, orderSeq: 1000,
  deliveryTiers: [{ maxKm: 2, charge: 20 }, { maxKm: 5, charge: 40 }],
  slots: [{ label: 'Morning', from: '09:00', to: '11:00', active: true }], updatedAt: 1,
};

test('the supplied Plus Code centre and inclusive radius are fixed', () => {
  assert.equal(STORE_LOCATION.lat, 8.5636625);
  assert.equal(STORE_LOCATION.lng, 76.860234375);
  assert.equal(STORE_LOCATION.plusCode, '6JWRHV76+F39');
  assert.equal(SERVICE_RADIUS_KM, 5);
  const effective = withDeliveryArea(staleConfig);
  assert.equal(effective.storeLat, STORE_LOCATION.lat);
  assert.equal(effective.storeLng, STORE_LOCATION.lng);
  assert.equal(effective.serviceRadiusKm, 5);
  assert.equal(effective.minOrderValue, staleConfig.minOrderValue);
});

test('all bearings include exactly 5 km, exclude points just beyond, and never use display rounding', () => {
  for (let bearing = 0; bearing < 360; bearing += 5) {
    for (const km of [0, 2, 4.999999, 5, 5.000001, 5.004, 5.049, 6]) {
      const point = destination(km, bearing);
      const result = evaluateServiceArea(point.lat, point.lng);
      assert(Math.abs(result.distanceKm - km) < 1e-8);
      assert.equal(result.withinRadius, km <= 5, `${km} km at bearing ${bearing}`);
      assert.equal(evaluateDelivery(staleConfig, point.lat, point.lng, 100000).withinRadius, km <= 5);
    }
  }
});

test('malformed coordinates fail closed; valid zeros are not replaced with guessed locations', () => {
  for (const pair of [[null, 76], [undefined, 76], ['', 76], ['8.56', 76], [false, 76], [NaN, 76], [Infinity, 76], [91, 76], [8, 181], [8, null], [8, -181]]) {
    assert.equal(validCoordinates(...pair), false);
    assert.equal(evaluateServiceArea(...pair).withinRadius, false);
    assert.equal(evaluateServiceArea(...pair).distanceKm, null);
  }
  assert.equal(validCoordinates(0, 0), true);
  assert.equal(evaluateServiceArea(0, 0).withinRadius, false);
  assert.equal(haversineKm(0, 0, 0, 0), 0);
  assert(Number.isFinite(haversineKm(0, 0, 0, 180)));
});

test('delivery tiers include their boundaries and free delivery never overrides serviceability', () => {
  for (const [km, expected] of [[0, 20], [2, 20], [2.001, 40], [5, 40]]) {
    const p = destination(km, 73);
    assert.equal(evaluateDelivery(staleConfig, p.lat, p.lng, 200).deliveryCharge, expected);
    assert.equal(evaluateDelivery(staleConfig, p.lat, p.lng, 2500).deliveryCharge, 0);
  }
  const outside = destination(5.01, 120);
  assert.equal(evaluateDelivery(staleConfig, outside.lat, outside.lng, 100000).withinRadius, false);
});

test('settings validation prevents accidental shop relocation or radius changes', () => {
  const current = withDeliveryArea(staleConfig);
  assert.equal(configSchema.validate(current).error, undefined);
  for (const patch of [{ storeLat: 0 }, { storeLng: 0 }, { serviceRadiusKm: 0 }, { serviceRadiusKm: 4.9 }, { serviceRadiusKm: 5.1 }]) {
    assert(configSchema.validate({ ...current, ...patch }).error);
  }
});

test('the customer app uses identical policy and billing matches backend distance and fees', async () => {
  const appFile = path.resolve(__dirname, '../../customer/src/config/deliveryArea.js');
  if (!fs.existsSync(appFile)) return; // Standalone backend deployments do not include the app repo.
  assert.equal(fs.readFileSync(appFile, 'utf8'), fs.readFileSync(path.resolve(__dirname, '../src/config/deliveryArea.js'), 'utf8'));
  const app = require(appFile);
  const pricingSource = fs.readFileSync(path.resolve(__dirname, '../../customer/src/utils/pricing.js'), 'utf8');
  const body = pricingSource.replace(/^import .*;\n/m, '').replace('export { haversineKm };', '').replaceAll('export ', '');
  const computeBill = Function('haversineKm', 'evaluateServiceArea', 'withinDistance', `${body}\nreturn computeBill;`)(app.haversineKm, app.evaluateServiceArea, app.withinDistance);
  for (const km of [0, 2, 2.001, 4.9999, 5, 5.000001, 5.04, 20]) {
    const address = destination(km, 135);
    for (const subtotal of [200, 2500]) {
      const server = evaluateDelivery(staleConfig, address.lat, address.lng, subtotal);
      const client = computeBill(subtotal, 0, 0, staleConfig, address);
      assert.equal(client.distanceKm, server.distanceKm);
      assert.equal(client.withinRadius, server.withinRadius);
      if (server.withinRadius) assert.equal(client.deliveryFee, server.deliveryCharge);
    }
  }
  assert.equal(computeBill(200, 0, 0, null, null).withinRadius, false);
});

// Exercise the real order service with an in-memory transaction: no live Firebase writes.
const firebase = require('../src/config/firebase');
const originalDb = firebase.db;
let writes = [];
function reference(parts) {
  return { path: parts.join('/'), id: parts.at(-1), get: async () => ({ exists: true, id: parts.at(-1), data: () => structuredClone(staleConfig) }), set: async data => writes.push({ path: parts.join('/'), data }), collection: name => ({ doc: id => reference([...parts, name, id || 'generated-order']) }) };
}
const fakeDb = {
  collection: name => ({ doc: id => reference([name, id || 'generated-order']) }),
  runTransaction: async callback => {
    writes = [];
    return callback({
      get: async ref => {
        let data;
        if (ref.path === 'config/global') data = structuredClone(staleConfig);
        if (ref.path === 'products/product-1') data = { name: 'Test product', availability: 'IN_STOCK', variants: [{ id: 'variant-1', label: '1 kg', price: 200, stock: 20 }] };
        if (ref.path === 'users/customer-1') data = { name: 'Customer' };
        return { exists: Boolean(data), id: ref.id, data: () => data };
      },
      set: (ref, data) => writes.push({ path: ref.path, data }),
      update: (ref, data) => writes.push({ path: ref.path, data }),
    });
  },
};
firebase.db = () => fakeDb;
const { placeOrder } = require('../src/services/orderService');
firebase.db = originalDb;
const orderArgs = address => ({ userId: 'customer-1', cartItems: [{ productId: 'product-1', variantId: 'variant-1', qty: 1 }], address: { houseNo: '1', street: 'Test street', pincode: '695582', ...address }, slot: { label: 'Morning' }, paymentMethod: 'UPI_MANUAL' });

test('the real order service accepts the boundary and rejects outside orders before any stock, order or payment writes', async () => {
  for (const km of [0, 4.9999, 5]) {
    const order = await placeOrder(orderArgs(destination(km, 80)));
    assert(order.distanceKm <= 5 + 1e-9);
    assert(writes.some(w => w.path.startsWith('orders/')));
  }
  for (const km of [5.000001, 5.04, 50]) {
    await assert.rejects(placeOrder(orderArgs(destination(km, 80))), err => err.statusCode === 422 && err.code === 'OUT_OF_SERVICE');
    assert.equal(writes.length, 0);
  }
  await assert.rejects(placeOrder(orderArgs({ lat: null, lng: null })), err => err.code === 'INVALID_DELIVERY_LOCATION');
  await assert.rejects(placeOrder(orderArgs({ lat: '8.56', lng: '76.86' })), err => err.code === 'INVALID_DELIVERY_LOCATION');
});


test('the public config API returns the same fixed policy and admin saves cannot widen the area', async () => {
  firebase.db = () => fakeDb;
  const router = require('../src/routes/config.routes');
  firebase.db = originalDb;
  const get = router.stack.find(layer => layer.route?.methods.get).route.stack.at(-1).handle;
  const put = router.stack.find(layer => layer.route?.methods.put).route.stack.at(-1).handle;
  let response;
  const res = { json: value => { response = value; }, status: () => res };
  const next = err => { throw err; };
  await get({}, res, next);
  assert.equal(response.storeLat, STORE_LOCATION.lat);
  assert.equal(response.storeLng, STORE_LOCATION.lng);
  assert.equal(response.serviceRadiusKm, 5);
  for (const body of [{ serviceRadiusKm: 50 }, { storeLat: 0 }, { storeLng: 0 }]) {
    writes = [];
    await assert.rejects(put({ body }, res, next), err => err.statusCode === 422);
    assert.equal(writes.length, 0);
  }
  await put({ body: { taxPercent: 5 } }, res, next);
  assert.equal(response.serviceRadiusKm, 5);
  assert.equal(response.storeLat, STORE_LOCATION.lat);
  assert.equal(response.taxPercent, 5);
});
