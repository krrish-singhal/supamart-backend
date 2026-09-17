const { db } = require('./src/config/firebase');

async function updateOrders() {
  try {
    const ordersRef = db().collection('orders');
    const snapshot = await ordersRef.get();
    let updated = false;
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.userId === '1DPgE33zSGTR4rpzFOcU' || (data.userName && data.userName.toLowerCase().includes('krrish'))) {
        doc.ref.update({ userPhone: '8265940243' });
        console.log(`Updated order ${data.orderNo} (${doc.id})`);
        updated = true;
      }
    });
    console.log('Done');
  } catch(e) {
    console.error(e);
  }
}
updateOrders();
