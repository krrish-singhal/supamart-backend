// Tests the existing Nodemailer SMTP connection and login without sending a message.
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { getSmtpTransport, smtpFailure } = require('../src/services/smtpTransport');
async function main() {
  let transport;
  try {
    transport = getSmtpTransport();
    await transport.verify();
    console.log('Nodemailer SMTP connection and authentication succeeded. The server is ready to accept email.');
  } catch (error) {
    console.error('Nodemailer SMTP check failed:', smtpFailure(error));
    process.exitCode = 1;
  } finally {
    transport?.close();
  }
}
main();
