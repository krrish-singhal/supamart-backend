require('dotenv').config();
const { db } = require('../config/firebase');
const { COLLECTIONS, OFFER_KIND, OFFER_SCOPE } = require('../config/constants');

const CANONICAL_OFFERS = [
  {
    code: 'WELCOME50',
    tag: 'NEW',
    tagColor: '#0a7c47',
    title: 'Save ₹50 on your first order',
    description: 'Valid on first order above ₹199.',
    kind: OFFER_KIND.FLAT,
    value: 50,
    scope: OFFER_SCOPE.CART,
    scopeId: null,
    minValue: 199,
    maxDiscount: null,
    sortOrder: 1,
    isActive: true,
  },
  {
    code: 'MSCLUB10',
    tag: 'CLUB',
    tagColor: '#121712',
    title: 'Extra 10% off (up to ₹60)',
    description: 'For MS Club members on any order.',
    kind: OFFER_KIND.PERCENT,
    value: 10,
    scope: OFFER_SCOPE.CART,
    scopeId: null,
    minValue: 0,
    maxDiscount: 60,
    sortOrder: 2,
    isActive: true,
  },
  {
    code: 'FRESH20',
    tag: 'FRESH',
    tagColor: '#4e8a3e',
    title: '₹20 off on fruits & vegetables',
    description: 'Applies to fresh items in your cart.',
    kind: OFFER_KIND.FLAT,
    value: 20,
    scope: OFFER_SCOPE.CART,
    scopeId: null,
    minValue: 0,
    maxDiscount: null,
    sortOrder: 3,
    isActive: true,
  },
  {
    code: 'BULK100',
    tag: 'BULK',
    tagColor: '#b57a00',
    title: 'Save ₹100 on stock-up orders',
    description: 'Valid on orders above ₹999.',
    kind: OFFER_KIND.FLAT,
    value: 100,
    scope: OFFER_SCOPE.CART,
    scopeId: null,
    minValue: 999,
    maxDiscount: null,
    sortOrder: 4,
    isActive: true,
  },
  {
    code: 'FLAT10OFF',
    tag: 'FLAT',
    tagColor: '#0891b2',
    title: 'Flat ₹10 off on orders',
    description: 'Valid on orders above ₹100.',
    kind: OFFER_KIND.FLAT,
    value: 10,
    scope: OFFER_SCOPE.CART,
    scopeId: null,
    minValue: 100,
    maxDiscount: null,
    sortOrder: 5,
    isActive: true,
  },
  {
    code: 'FIRSTORDER',
    tag: 'FIRST',
    tagColor: '#7c3aed',
    title: 'Flat ₹100 off on your first order',
    description: 'Valid on orders above ₹500.',
    kind: OFFER_KIND.FLAT,
    value: 100,
    scope: OFFER_SCOPE.CART,
    scopeId: null,
    minValue: 500,
    maxDiscount: null,
    sortOrder: 6,
    isActive: true,
  },
  {
    code: 'TEA15',
    tag: 'TEA',
    tagColor: '#d97706',
    title: '15% Off Tea & Beverages',
    description: 'Save 15% (up to ₹80) on tea and hot beverages.',
    kind: OFFER_KIND.PERCENT,
    value: 15,
    scope: OFFER_SCOPE.CART,
    scopeId: null,
    minValue: 0,
    maxDiscount: 80,
    sortOrder: 7,
    isActive: true,
  },
  {
    code: 'DETERGENT20',
    tag: 'HOME',
    tagColor: '#2563eb',
    title: '20% Off Detergent',
    description: 'Save 20% (up to ₹100) on detergents and laundry care.',
    kind: OFFER_KIND.PERCENT,
    value: 20,
    scope: OFFER_SCOPE.CART,
    scopeId: null,
    minValue: 0,
    maxDiscount: 100,
    sortOrder: 8,
    isActive: true,
  },
];

async function seedOffers() {
  const firestore = db();
  const now = Date.now();
  const oneYear = 365 * 24 * 60 * 60 * 1000;

  console.log('Seeding canonical offers into Firestore...');

  const snap = await firestore.collection(COLLECTIONS.OFFERS).get();
  const existingByCode = new Map();
  snap.docs.forEach((doc) => {
    const data = doc.data();
    if (data.code) {
      existingByCode.set(data.code.toUpperCase(), { id: doc.id, ...data });
    }
  });

  for (const offer of CANONICAL_OFFERS) {
    const code = offer.code.toUpperCase();
    const existing = existingByCode.get(code);

    const offerDoc = {
      code,
      tag: offer.tag,
      tagColor: offer.tagColor,
      title: offer.title,
      description: offer.description,
      kind: offer.kind,
      value: offer.value,
      scope: offer.scope,
      scopeId: offer.scopeId,
      minValue: offer.minValue,
      maxDiscount: offer.maxDiscount,
      sortOrder: offer.sortOrder,
      isActive: offer.isActive,
      validFrom: existing?.validFrom || now - 30 * 86400000,
      validTo: now + oneYear,
      updatedAt: now,
    };

    if (existing) {
      await firestore.collection(COLLECTIONS.OFFERS).doc(existing.id).set(
        {
          ...offerDoc,
          createdAt: existing.createdAt || now,
        },
        { merge: true }
      );
      console.log(`  ✓ Updated offer ${code} (${existing.id})`);
    } else {
      const docRef = await firestore.collection(COLLECTIONS.OFFERS).add({
        ...offerDoc,
        createdAt: now,
      });
      console.log(`  ✓ Created offer ${code} (${docRef.id})`);
    }
  }

  console.log(`\nSuccessfully seeded ${CANONICAL_OFFERS.length} offers!`);
}

seedOffers()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Failed to seed offers:', err);
    process.exit(1);
  });
