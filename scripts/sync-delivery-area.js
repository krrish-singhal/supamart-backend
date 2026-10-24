const fs = require('node:fs');
const path = require('node:path');
for (const name of ['deliveryArea.js', 'storeHours.js']) {
  const source = path.resolve(__dirname, '../src/config', name);
  const destination = path.resolve(__dirname, '../../customer/src/config', name);
  fs.copyFileSync(source, destination);
}
console.log('Synced the canonical delivery policy to the customer app.');
