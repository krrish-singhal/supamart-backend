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

const readsCache = new Map();
const READS_CACHE_TTL_MS = 30_000;

router.post('/', optionalAuthenticate, asyncHandler(async (req, res) => {
  const { path, kind, constraints = [], cursor } = req.body;
  if (typeof path !== 'string' || !/^[\w-]+(?:\/[\w-]+){0,3}$/.test(path) ||
      !['doc', 'collection'].includes(kind) || !Array.isArray(constraints) || constraints.length > 12) throw invalid();
  const parts = path.split('/');
  if ((kind === 'doc') !== (parts.length % 2 === 0)) throw invalid();
  const [root, id, child] = parts;
  const uid = req.user?.uid;
  let ownerField;
  const isPublic = publicCollections.has(root) && parts.length <= 2;
  if (isPublic) {
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

  const ttl = isPublic ? READS_CACHE_TTL_MS : 15_000;
  const cacheKey = isPublic
    ? JSON.stringify({ scope: 'public', path, kind, constraints, cursor })
    : (uid ? JSON.stringify({ scope: 'private', uid, path, kind, constraints, cursor }) : null);

  if (cacheKey && readsCache.has(cacheKey)) {
    const entry = readsCache.get(cacheKey);
    if (Date.now() - entry.time < ttl) {
      return res.json(entry.data);
    } else {
      readsCache.delete(cacheKey);
    }
  }

  const setCachedResponse = (key, data) => {
    if (!key) return;
    if (readsCache.size > 1000) {
      const now = Date.now();
      for (const [k, v] of readsCache.entries()) {
        if (now - v.time > READS_CACHE_TTL_MS) readsCache.delete(k);
      }
    }
    readsCache.set(key, { time: Date.now(), data });
  };

  if (kind === 'doc') {
    try {
      const snap = await db().doc(path).get();
      if (snap.exists && ownerField && snap.data()[ownerField] !== uid) throw denied();
      const responseData = { document: snap.exists ? { id: snap.id, data: clean(snap.data()) } : null };
      if (cacheKey) setCachedResponse(cacheKey, responseData);
      return res.json(responseData);
    } catch (err) {
      if (err.statusCode === 403) throw err;
      console.warn(`Firestore read failure on doc: ${path}:`, err.message || err);
      if (cacheKey && readsCache.has(cacheKey)) {
        return res.json(readsCache.get(cacheKey).data);
      }
      return res.json({ document: null });
    }
  }

  try {
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
    const responseData = {
      documents: snap.docs.map(d => ({ id: d.id, data: clean(d.data()) })),
      nextCursor: !requestedLimit && snap.size === pageSize ? snap.docs.at(-1).id : null,
    };
    if (cacheKey) setCachedResponse(cacheKey, responseData);
    res.json(responseData);
  } catch (err) {
    if (err.statusCode === 403 || err.statusCode === 422) throw err;
    console.warn(`Firestore read failure on collection: ${path}:`, err.message || err);
    if (cacheKey && readsCache.has(cacheKey)) {
      return res.json(readsCache.get(cacheKey).data);
    }
    return res.json({ documents: [], nextCursor: null });
  }
}));

function invalidateReadsCache(pathSubstring) {
  if (!pathSubstring) {
    readsCache.clear();
    return;
  }
  for (const key of readsCache.keys()) {
    if (key.includes(pathSubstring)) {
      readsCache.delete(key);
    }
  }
}

router.invalidateReadsCache = invalidateReadsCache;
module.exports = router;
module.exports.invalidateReadsCache = invalidateReadsCache;
