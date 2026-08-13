// One-off brand cleanup per client correction:
//  - "R.G." isn't a real brand -- delete it, clear brandId on its one product (R.G. Palm Oil).
//  - "Lia" isn't a separate brand -- it's under "Cycle". Reassign Lia's one product
//    (Lia Agarbathy) onto the existing "Cycle" brand, then delete the Lia brand doc.
require("dotenv").config();
const { db } = require("../config/firebase");
const { COLLECTIONS } = require("../config/constants");

async function run() {
  const firestore = db();
  const now = Date.now();

  const brandsSnap = await firestore.collection(COLLECTIONS.BRANDS).get();
  const brands = brandsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const rg = brands.find((b) => b.name === "R.G.");
  const lia = brands.find((b) => b.name === "Lia");
  const cycle = brands.find((b) => b.name === "Cycle");

  if (!rg) throw new Error('Brand "R.G." not found');
  if (!lia) throw new Error('Brand "Lia" not found');
  if (!cycle) throw new Error('Brand "Cycle" not found');

  const prodSnap = await firestore.collection(COLLECTIONS.PRODUCTS).get();
  const prods = prodSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  const rgProducts = prods.filter((p) => p.brandId === rg.id);
  const liaProducts = prods.filter((p) => p.brandId === lia.id);

  for (const p of rgProducts) {
    await firestore.collection(COLLECTIONS.PRODUCTS).doc(p.id).update({ brandId: null, updatedAt: now });
    console.log(`Cleared brandId on "${p.name}" (was R.G.)`);
  }
  await firestore.collection(COLLECTIONS.BRANDS).doc(rg.id).delete();
  console.log('Deleted brand "R.G."');

  for (const p of liaProducts) {
    await firestore.collection(COLLECTIONS.PRODUCTS).doc(p.id).update({ brandId: cycle.id, updatedAt: now });
    console.log(`Moved "${p.name}" -> brand "Cycle"`);
  }
  await firestore.collection(COLLECTIONS.BRANDS).doc(lia.id).delete();
  console.log('Deleted brand "Lia"');

  console.log("\nDone.");
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
