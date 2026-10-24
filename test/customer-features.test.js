process.env.JWT_SECRET = 'customer-features-tests-only';
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { validateOrderRatings, boughtProducts } = require('../src/services/customerFeatures');
const delivered = { userId: 'customer', status: 'DELIVERED', createdAt: 100, items: [{ productId: 'tomato', variantId: '500g' }] };
test('ratings require delivery, ownership, integer stars and purchased products', () => {
  const input = { orderRating: 5, productRatings: [{ productId: 'tomato', rating: 4 }] };
  assert.equal(validateOrderRatings(delivered, 'customer', input).orderRating, 5);
  for (const [order, user, body, code] of [
    [delivered, 'other', input, 403], [{ ...delivered, status: 'PLACED' }, 'customer', input, 409],
    [delivered, 'customer', { ...input, orderRating: 6 }, 422], [delivered, 'customer', { ...input, orderRating: 2.5 }, 422],
    [delivered, 'customer', { ...input, productRatings: [{ productId: 'rice', rating: 5 }] }, 422],
    [delivered, 'customer', { ...input, productRatings: [input.productRatings[0], input.productRatings[0]] }, 422],
  ]) assert.throws(() => validateOrderRatings(order, user, body), error => error.statusCode === code);
});
test('buy again includes purchases beyond twenty orders, deduplicates packs and excludes cancelled purchases', () => {
  const orders = Array.from({ length: 30 }, (_, i) => ({ ...delivered, createdAt: i, items: [{ productId: `product-${i}`, variantId: '1kg' }] }));
  orders.push(delivered, delivered, { ...delivered, status: 'CANCELLED', items: [{ productId: 'cancelled', variantId: '1kg' }] });
  const items = boughtProducts(orders);
  assert.equal(items.length, 31);
  assert(items.some(item => item.productId === 'product-0'));
  assert(!items.some(item => item.productId === 'cancelled'));
  assert.deepEqual(boughtProducts([]), []);
});
const records = new Map([
  ['products/tomato', { name: 'Tomato (Local)', variants: [{ id: '500g', label: '500g', price: 20, stock: 10 }] }],
  ['products/toor', { name: 'Toor Dal', variants: [{ id: '1kg', label: '1kg', price: 100, stock: 10 }] }],
  ['products/rice', { name: 'Rice', variants: [{ id: '1kg', label: '1kg', price: 50, stock: 10 }] }],
  ['orders/order-1', delivered], ['orders/other', { ...delivered, userId: 'other', items: [{ productId: 'rice', variantId: '1kg' }] }],
]);
let sequence = 0;
const snapshot = path => ({ id: path.split('/').at(-1), exists: records.has(path), data: () => structuredClone(records.get(path)), ref: reference(path) });
function reference(path) { return { path, id: path.split('/').at(-1), collection: name => collection(`${path}/${name}`), get: async () => snapshot(path), set: async value => records.set(path, value), delete: async () => records.delete(path) }; }
function collection(path, filters = []) { return {
  doc: id => reference(`${path}/${id}`), where: (field, op, value) => collection(path, [...filters, [field, value]]),
  get: async () => { const docs = [...records.keys()].filter(key => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/')).filter(key => filters.every(([field, value]) => records.get(key)[field] === value)).map(snapshot); return { docs, empty: !docs.length, size: docs.length }; },
  add: async value => { const ref = reference(`${path}/list-${++sequence}`); await ref.set(value); return ref; },
}; }
const firebase = require('../src/config/firebase');
firebase.db = () => ({ collection, runTransaction: async callback => callback({ get: async ref => snapshot(ref.path), update: (ref, data) => records.set(ref.path, { ...records.get(ref.path), ...data }) }) });
const express = require('express');
const { errorHandler } = require('../src/middleware/error');
const app = express(); app.use(express.json());
app.use('/api/users/:uid/shopping-lists', require('../src/routes/shoppingLists.routes'));
app.use('/api/products', require('../src/routes/products.routes'));
app.use('/api/orders', require('../src/routes/orders.routes'));
app.use(errorHandler);
let server, base;
test.before(async () => { server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}/api`; });
test.after(() => server.close());
const token = jwt.sign({ uid: 'customer', role: 'CUSTOMER' }, process.env.JWT_SECRET);
async function request(path, method = 'GET', body, auth = true) {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json() };
}
test('search suggests tomato from t, To and tom', async () => {
  for (const q of ['t', 'To', 'tom']) {
    const response = await request(`/products/search?q=${q}&limit=4`, 'GET', null, false);
    assert.equal(response.status, 200);
    assert(response.body.items.some(item => item.name === 'Tomato (Local)'), q);
    assert(!response.body.items.some(item => item.name === 'Rice'));
  }
});
test('shopping lists persist per account and reject other-account access', async () => {
  const payload = { name: 'Monthly groceries', items: [{ productId: 'tomato', variantId: '500g', qty: 3 }] };
  assert.equal((await request('/users/customer/shopping-lists', 'GET', null, false)).status, 401);
  assert.equal((await request('/users/other/shopping-lists')).status, 403);
  assert.equal((await request('/users/other/shopping-lists', 'POST', payload)).status, 403);
  assert.equal((await request('/users/customer/shopping-lists', 'POST', { ...payload, items: [{ ...payload.items[0], qty: 0 }] })).status, 422);
  const saved = await request('/users/customer/shopping-lists', 'POST', payload);
  assert.equal(saved.status, 201);
  const fetched = await request('/users/customer/shopping-lists');
  assert.equal(fetched.body.items[0].name, payload.name);
  assert.equal(fetched.body.items[0].items[0].qty, 3);
  assert.equal((await request(`/users/other/shopping-lists/${saved.body.id}`, 'DELETE')).status, 403);
  assert.equal((await request(`/users/customer/shopping-lists/${saved.body.id}`, 'DELETE')).status, 200);
  assert.equal((await request('/users/customer/shopping-lists')).body.items.length, 0);
});
test('buy-again HTTP response uses current prices and only this account’s purchases', async () => {
  const response = await request('/orders/buy-again');
  assert.equal(response.status, 200);
  assert.equal(response.body.items.length, 1);
  assert.equal(response.body.items[0].product.variants[0].price, 20);
});
test('ratings API saves updates and rejects another account’s order', async () => {
  const input = { orderRating: 5, review: 'Great', deliveryFeedback: 'up', productRatings: [{ productId: 'tomato', rating: 4 }] };
  assert.equal((await request('/orders/other/ratings', 'PATCH', input)).status, 403);
  assert.equal((await request('/orders/order-1/ratings', 'PATCH', input)).status, 200);
  assert.equal(records.get('orders/order-1').ratings.productRatings[0].rating, 4);
  assert.equal(records.get('orders/order-1').ratings.deliveryFeedback, 'up');
  assert.equal((await request('/orders/order-1/ratings', 'PATCH', { ...input, orderRating: 3, deliveryFeedback: 'down' })).status, 200);
  assert.equal(records.get('orders/order-1').ratings.orderRating, 3);
  assert.equal(records.get('orders/order-1').ratings.deliveryFeedback, 'down');
});
const { orderEstimate } = require('../../customer/src/utils/orderEstimate');
test('arrival estimates change with elapsed time, order status and fresh rider location', () => {
  const now = Date.now(); const order = { status: 'PLACED', estimatedDeliveryAt: now + 18 * 60000 };
  assert.equal(orderEstimate(null, now), null);
  assert.equal(orderEstimate(order, now), '~18 mins');
  assert.equal(orderEstimate(order, now + 5 * 60000), '~13 mins');
  assert.equal(orderEstimate(order, now + 19 * 60000), 'Updating arrival time');
  assert.equal(orderEstimate({ ...order, status: 'DELIVERED' }, now), null);
  assert.equal(orderEstimate({ status: 'OUT_FOR_DELIVERY', addressSnapshot: { lat: 8.56, lng: 76.86 }, partnerLocation: { lat: 8.56, lng: 76.86, updatedAt: now } }, now), 'Arriving now');
});

const { formatDeliveryAddress } = require('../../customer/src/utils/addressForm');
test('address labels show the actual locality without Current Location placeholders or duplicates', () => {
  assert.equal(formatDeliveryAddress({ houseNo: 'Current Location', street: 'Menamkulam Road', area: 'Menamkulam', city: 'Thiruvananthapuram', pincode: '695582' }), 'Menamkulam Road, Menamkulam, Thiruvananthapuram, 695582');
  assert.equal(formatDeliveryAddress({ houseNo: '1', street: 'Rose Lane', area: 'Rose Lane' }), '1, Rose Lane');
  assert.equal(formatDeliveryAddress({ houseNo: 'Current Location', street: 'Current Location', lat: 8.5636625, lng: 76.860234375 }), '8.56366, 76.86023');
});

const { locationFromGeocode } = require('../../customer/src/utils/pickedLocation');
test('map confirmation preserves the exact pin and geocoding never substitutes coordinates or a guessed PIN', () => {
  const coordinate = { latitude: 8.5771523241, longitude: 76.860234375 };
  const location = locationFromGeocode(coordinate, { name: 'Road', district: 'Menamkulam', city: 'Thiruvananthapuram', postalCode: '695582' });
  assert.equal(location.lat, coordinate.latitude);
  assert.equal(location.lng, coordinate.longitude);
  assert.equal(location.pincode, '695582');
  const missing = locationFromGeocode(coordinate, null);
  assert.equal(missing.lat, coordinate.latitude);
  assert.equal(missing.street, '');
  assert.equal(missing.pincode, '');
  assert.equal(locationFromGeocode({ latitude: null, longitude: 76.8 }, {}), null);
});
