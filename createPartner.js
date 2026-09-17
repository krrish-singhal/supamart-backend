// Need to set env vars so firebase.js works if they aren't loaded globally
require('dotenv').config();

const { authAdmin, db } = require('./src/config/firebase');

async function main() {
  const email = 'delivery@supamart.com';
  const password = 'password123';
  const name = 'Test Delivery Boy';
  const mobile = '9999999999';

  try {
    let userRecord;
    try {
      userRecord = await authAdmin().getUserByEmail(email);
      console.log('User already exists, updating password...');
      await authAdmin().updateUser(userRecord.uid, { password });
    } catch (e) {
      if (e.code === 'auth/user-not-found') {
        userRecord = await authAdmin().createUser({
          email,
          password,
          displayName: name,
        });
        console.log('Created new user in Firebase Auth.');
      } else {
        throw e;
      }
    }

    const uid = userRecord.uid;
    const now = Date.now();

    await db().collection('deliveryPartners').doc(uid).set({
      name,
      email,
      mobile,
      isActive: true,
      fcmTokens: [],
      currentOrders: [],
      createdAt: now,
    });

    await authAdmin().setCustomUserClaims(uid, { role: 'PARTNER' });
    console.log('Successfully created test delivery partner!');
    console.log(`Email: ${email}`);
    console.log(`Password: ${password}`);
    process.exit(0);
  } catch (err) {
    console.error('Failed:', err);
    process.exit(1);
  }
}

main();
