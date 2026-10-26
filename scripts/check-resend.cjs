// Tests the Resend API key and connectivity without sending a message to a customer.
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function main() {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    console.error('RESEND_API_KEY is not set in backend/.env');
    process.exitCode = 1;
    return;
  }

  try {
    const res = await fetch('https://api.resend.com/api-keys', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.ok) {
      console.log('Resend API key is valid and connected successfully over HTTPS (Port 443). Ready for production!');
    } else {
      const err = await res.json().catch(() => ({}));
      console.error('Resend API check failed:', res.status, err);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error('Network request failed:', error.message);
    process.exitCode = 1;
  }
}
main();
