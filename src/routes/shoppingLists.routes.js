const express = require('express');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/error');
const { db } = require('../config/firebase');
const { listSchema, validate } = require('../services/customerFeatures');
const router = express.Router({ mergeParams: true });
router.use(authenticate, (req, res, next) => req.user.uid === req.params.uid ? next() : res.status(403).json({ error: 'Forbidden' }));
const lists = uid => db().collection('users').doc(uid).collection('shoppingLists');
router.get('/', asyncHandler(async (req, res) => {
  const snap = await lists(req.params.uid).get();
  res.json({ items: snap.docs.map(doc => ({ id: doc.id, ...doc.data() })).sort((a,b) => b.updatedAt-a.updatedAt) });
}));
router.post('/', asyncHandler(async (req, res) => {
  const value = { ...validate(listSchema, req.body), createdAt: Date.now(), updatedAt: Date.now() };
  const ref = await lists(req.params.uid).add(value);
  res.status(201).json({ id: ref.id, ...value });
}));
router.delete('/:id', asyncHandler(async (req, res) => {
  await lists(req.params.uid).doc(req.params.id).delete();
  res.json({ deleted: true });
}));
module.exports = router;
