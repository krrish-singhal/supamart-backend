const { db } = require('./src/config/firebase');

async function updatePhone() {
  try {
    const usersRef = db().collection('users');
    const snapshot = await usersRef.get();
    let updated = false;
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.name && data.name.toLowerCase().includes('krrish')) {
        doc.ref.update({ phone: '8265940243' });
        console.log(`Updated user ${data.name} (${doc.id})`);
        updated = true;
      }
    });
    if (!updated) {
      console.log('User not found. Will just create or update any test user.');
    }
  } catch(e) {
    console.error(e);
  }
}
updatePhone();
