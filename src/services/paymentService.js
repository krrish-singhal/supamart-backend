// Abstract payment layer. COD works today; Razorpay/UPI plug in with the same interface.
const { PAYMENT_METHOD, PAYMENT_STATUS } = require("../config/constants");

const providers = {
  [PAYMENT_METHOD.COD]: {
    async createPayment() {
      return { status: PAYMENT_STATUS.PENDING, providerRef: null };
    },
    async verifyPayment() {
      return { status: PAYMENT_STATUS.PENDING };
    },
  },
  // [PAYMENT_METHOD.RAZORPAY]: { createPayment, verifyPayment }  <-- add in Phase 2
};

function getProvider(method) {
  const p = providers[method];
  if (!p) throw Object.assign(new Error(`Unsupported payment method ${method}`), { statusCode: 422 });
  return p;
}

async function createPayment(method, order) {
  return getProvider(method).createPayment(order);
}
async function verifyPayment(method, payload) {
  return getProvider(method).verifyPayment(payload);
}

module.exports = { createPayment, verifyPayment };
