// Ensure at least 20 real catalog products are enabled for Monthly Stock-up.
// Dry-run by default. Pass --apply to write only the admin-managed flag.
require('dotenv').config();
const { db } = require('../config/firebase');

const STAPLE_TERMS = ['staple', 'rice', 'atta', 'grain', 'oil', 'ghee', 'spice', 'masala', 'dry fruit', 'dal', 'pulse'];

async function configureMonthlyStockUp() {
  const firestore = db();
  const [categorySnapshot, productSnapshot] = await Promise.all([
    firestore.collection('categories').get(),
    firestore.collection('products').get(),
  ]);

  const categories = categorySnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const byId = new Map(categories.map((category) => [category.id, category]));
  const eligibleCategoryIds = new Set();
  categories.forEach((category) => {
    if (category.isActive === false) return;
    let current = category;
    while (current?.parentId && byId.has(current.parentId)) current = byId.get(current.parentId);
    const rootName = (current?.name || '').toLowerCase();
    if (STAPLE_TERMS.some((term) => rootName.includes(term))) eligibleCategoryIds.add(category.id);
  });

  const products = productSnapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((product) => eligibleCategoryIds.has(product.categoryId) && Array.isArray(product.variants) && product.variants.length > 0)
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  const selected = products.filter((product) => product.isMonthlyStockUp);
  for (const product of products) {
    if (selected.length >= 20) break;
    if (!product.isMonthlyStockUp) selected.push(product);
  }

  if (selected.length < 20) {
    throw new Error(`Only ${selected.length} eligible existing catalog products found; no database changes made.`);
  }

  console.log(`Selected ${selected.length} existing products for Monthly Stock-up:`);
  selected.forEach((product) => console.log(`- ${product.name} (${product.id})`));
  if (!process.argv.includes('--apply')) {
    console.log('\nDry run only. Re-run with --apply to save isMonthlyStockUp=true.');
    return;
  }

  const batch = firestore.batch();
  selected.filter((product) => !product.isMonthlyStockUp).forEach((product) => {
    batch.update(firestore.collection('products').doc(product.id), { isMonthlyStockUp: true });
  });
  await batch.commit();
  console.log('\nSaved isMonthlyStockUp=true for the selected catalog products.');
}

configureMonthlyStockUp().catch((error) => {
  console.error('Monthly Stock-up setup failed:', error.message);
  process.exitCode = 1;
});
