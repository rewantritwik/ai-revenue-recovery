const Razorpay = require("razorpay");

const instance = new Razorpay({
  key_id: process.env.RZP_TEST_KEY,
  key_secret: process.env.RZP_TEST_SECRET,
});

async function createTestOrder() {
  const order = await instance.orders.create({
    amount: 499900,
    currency: "INR",
    receipt: `test_receipt_${Date.now()}`,
    notes: {
      customer_contact: "+919845127634",
      customer_email: "yourtest@example.com",
    },
  });

  console.log("Order created:", order.id);
  console.log("Amount:", order.amount / 100, order.currency);
  console.log("\nNext step: open Razorpay's test Checkout with this order_id,");
  console.log("use a failure test card, and click Failure on the mock bank page.");
  console.log("Your webhook-server.js should log the payment.failed event within seconds.");

  return order;
}

if (require.main === module) {
  createTestOrder().catch((err) => {
    console.error("Failed to create test order:", err.message);
  });
}

module.exports = { createTestOrder };
