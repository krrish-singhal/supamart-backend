const fs = require('node:fs');
const path = require('node:path');
const source = path.resolve(__dirname, '../src/config/deliveryArea.js');
const destination = path.resolve(__dirname, '../../customer/src/config/deliveryArea.js');
fs.copyFileSync(source, destination);
console.log('Synced the canonical delivery policy to the customer app.');
