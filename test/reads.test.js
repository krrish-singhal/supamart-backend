process.env.JWT_SECRET = 'reads-tests-only';
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const firebase = require('../src/config/firebase');
const records = new Map([
  ['products/p1', { name: 'Rice', categoryId: 'food' }],
  ['products/p2', { name: 'Soap', categoryId: 'home' }],
  ['orders/o1', { userId: 'alice', assignedPartnerId: 'partner', status: 'PENDING_CONFIRMATION' }],
  ['orders/o2', { userId: 'bob', assignedPartnerId: 'other' }],
  ['refunds/r1', { userId: 'alice', orderId: 'o1' }],
  ['refunds/r2', { userId: 'bob', orderId: 'o2' }],
  ['users/alice', { name: 'Alice', passwordHash: 'private', resetPasswordOtp: 'private' }],
  ['users/alice/notifications/n1', { title: 'Order update', createdAt: 1 }],
  ['deliveryPartners/partner', { name: 'Driver', passwordHash: 'private', mobile: 'private', location: { lat: 1, lng: 2 } }],
]);
const snapshot = path => ({ id: path.split('/').at(-1), exists: records.has(path), data: () => records.get(path) });
function collection(path, filters = [], max = 500) {
  return {
    doc: id => ({ get: async () => snapshot(`${path}/${id}`) }),
    where: (field, op, value) => collection(path, [...filters, [field, op, value]], max),
    orderBy() { return this; },
    limit: count => collection(path, filters, count),
    get: async () => {
      const docs = [...records.keys()].filter(key => key.startsWith(`${path}/`) && key.split('/').length === path.split('/').length + 1)
        .filter(key => filters.every(([field, op, value]) => op === 'in' ? value.includes(records.get(key)[field]) : records.get(key)[field] === value))
        .slice(0, max).map(snapshot);
      return { docs, size: docs.length };
    },
  };
}
firebase.db = () => ({ collection, doc: path => ({ get: async () => snapshot(path) }) });
firebase.authAdmin = () => ({ verifyIdToken: async () => { throw Error('Use test JWT'); } });
const express = require('express');
const { errorHandler } = require('../src/middleware/error');
const app = express();
app.use(express.json());
app.use('/reads', require('../src/routes/reads.routes'));
app.use(errorHandler);
let server, base;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
async function read(path, kind = 'doc', uid, constraints = [], role = 'CUSTOMER') {
  const headers = { 'content-type': 'application/json' };
  if (uid) headers.authorization = `Bearer ${jwt.sign({ uid, role }, process.env.JWT_SECRET)}`;
  const response = await fetch(`${base}/reads`, { method: 'POST', headers, body: JSON.stringify({ path, kind, constraints }) });
  return { status: response.status, body: await response.json() };
}
test('catalog reads work without auth and preserve filters', async () => {
  assert.equal((await read('products/p1')).body.document.data.name, 'Rice');
  const result = await read('products', 'collection', undefined, [{ type: 'where', field: 'categoryId', op: '==', value: 'food' }]);
  assert.deepEqual(result.body.documents.map(d => d.id), ['p1']);
});
test('private reads reject anonymous users and other owners', async () => {
  for (const path of ['orders/o1', 'refunds/r1', 'users/alice', 'deliveryPartners/partner', 'accountSecurityCodes/secret']) {
    assert.equal((await read(path)).status, 403);
  }
  assert.equal((await read('orders/o2', 'doc', 'alice')).status, 403);
  assert.equal((await read('users/alice', 'doc', 'bob')).status, 403);
  assert.equal((await read('users/alice/notifications', 'collection', 'bob')).status, 403);
});
test('collection queries always apply server ownership', async () => {
  assert.deepEqual((await read('orders', 'collection', 'alice')).body.documents.map(d => d.id), ['o1']);
  assert.deepEqual((await read('refunds', 'collection', 'alice')).body.documents.map(d => d.id), ['r1']);
  assert.equal((await read('orders', 'collection', 'alice', [{ type: 'where', field: 'userId', op: '==', value: 'bob' }])).status, 403);
  assert.deepEqual((await read('orders', 'collection', 'partner', [], 'PARTNER')).body.documents.map(d => d.id), ['o1']);
});
test('profile secrets and other partner contact details never leave the server', async () => {
  assert.deepEqual((await read('users/alice', 'doc', 'alice')).body.document.data, { name: 'Alice' });
  assert.deepEqual((await read('deliveryPartners/partner', 'doc', 'alice')).body.document.data, { name: 'Driver', location: { lat: 1, lng: 2 } });
  assert.equal((await read('users/alice/notifications', 'collection', 'alice')).body.documents.length, 1);
});
test('invalid paths, operators, and limits are rejected', async () => {
  assert.equal((await read('products/../users')).status, 422);
  assert.equal((await read('products', 'doc')).status, 422);
  assert.equal((await read('products', 'collection', undefined, [{ type: 'limit', value: 100000 }])).status, 422);
  assert.equal((await read('products', 'collection', undefined, [{ type: 'where', field: 'name', op: '!=', value: 'Rice' }])).status, 422);
});
