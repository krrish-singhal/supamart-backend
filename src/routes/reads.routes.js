// Read-only mobile transport. All access checks happen here because Admin SDK
// reads bypass Firestore rules. Never accept arbitrary collection paths.
const express = require('express');
const { FieldPath } = require('firebase-admin/firestore');
const { db } = require('../config/firebase');
const { optionalAuthenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/error');
const { publicUser } = require('../utils/publicUser');
const router = express.Router();
const publicCollections = new Set(['products', 'categories', 'brands', 'offers', 'banners', 'config']);
const denied = () => Object.assign(new Error('Forbidden'), { statusCode: 403 });
const invalid = () => Object.assign(new Error('Invalid read request'), { statusCode: 422 });

router.post('/', optionalAuthenticate, asyncHandler(async (req, res) => {
  const { path, kind, constraints = [], cursor } = req.body;
  if (typeof path !== 'string' || !/^[\w-]+(?:\/[\w-]+){0,3}$/.test(path) ||
      !['doc', 'collection'].includes(kind) || !Array.isArray(constraints) || constraints.length > 12) throw invalid();
  const parts = path.split('/');
  if ((kind === 'doc') !== (parts.length % 2 === 0)) throw invalid();
  const [root, id, child] = parts;
  const uid = req.user?.uid;
  let ownerField;
  if (publicCollections.has(root) && parts.length <= 2) {
    // Public catalog reads.
  } else if (root === 'users' && uid === id &&
      (parts.length === 2 || (parts.length === 3 && child === 'notifications'))) {
    // Own profile and inbox only.
  } else if (['orders', 'refunds'].includes(root) && parts.length <= 2 && uid) {
    ownerField = root === 'orders' && req.user.role === 'PARTNER' ? 'assignedPartnerId' : 'userId';
  } else if (root === 'deliveryPartners' && parts.length === 2 && uid) {
    // Authenticated live tracking; return only location fields for other partners.
  } else throw denied();

  const clean = data => {
    if (root === 'users' || (root === 'deliveryPartners' && id === uid)) return publicUser(data);
    if (root === 'deliveryPartners') {
      const { name, location, lastLocation, currentLocation, lat, lng, latitude, longitude, heading, speed, updatedAt } = data;
      return Object.fromEntries(Object.entries({ name, location, lastLocation, currentLocation, lat, lng, latitude, longitude, heading, speed, updatedAt }).filter(([, value]) => value !== undefined));
    }
    return data;
  };
  res.set('Cache-Control', 'no-store');
  if (kind === 'doc') {
    const snap = await db().doc(path).get();
    if (snap.exists && ownerField && snap.data()[ownerField] !== uid) throw denied();
    return res.json({ document: snap.exists ? { id: snap.id, data: clean(snap.data()) } : null });
  }
  let query = db().collection(path);
  if (ownerField) query = query.where(ownerField, '==', uid);
  let requestedLimit = null;
  for (const constraint of constraints) {
    if (!constraint || typeof constraint !== 'object') throw invalid();
    const { type, field, op, value, direction } = constraint;
    if (type === 'limit') {
      if (!Number.isInteger(value) || value < 1 || value > 500) throw invalid();
      requestedLimit = value;
      continue;
    }
    if (typeof field !== 'string' || !/^(?:[A-Za-z][\w.]*|__name__)$/.test(field)) throw invalid();
    const fieldPath = field === '__name__' ? FieldPath.documentId() : field;
    if (type === 'where' && ['==', 'in'].includes(op)) {
      if (op === 'in' && (!Array.isArray(value) || !value.length || value.length > 30)) throw invalid();
      // Ownership is added by the server; client filters cannot replace it.
      if (field === ownerField) {
        if (op !== '==' || value !== uid) throw denied();
      } else query = query.where(fieldPath, op, value);
    } else if (type === 'orderBy' && ['asc', 'desc'].includes(direction)) {
      query = query.orderBy(fieldPath, direction);
    } else throw invalid();
  }
  if (cursor) {
    if (typeof cursor !== 'string' || !/^[\w-]+$/.test(cursor)) throw invalid();
    const previous = await db().collection(path).doc(cursor).get();
    if (!previous.exists || (ownerField && previous.data()[ownerField] !== uid)) throw denied();
    query = query.startAfter(previous);
  }
  const pageSize = requestedLimit || 500;
  const snap = await query.limit(pageSize).get();
  res.json({ documents: snap.docs.map(d => ({ id: d.id, data: clean(d.data()) })),
    nextCursor: !requestedLimit && snap.size === pageSize ? snap.docs.at(-1).id : null });
}));

module.exports = router;
