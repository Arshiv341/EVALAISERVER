const router = require('express').Router();
const verifyToken = require('../middleware/auth');
const ctrl = require('../controllers/paymentController');

// Webhook endpoint (Public, verified via Razorpay Signature check)
router.post('/webhook', ctrl.handleWebhook);

// Protected routes (Requires cookie token auth)
router.get('/plans', verifyToken, ctrl.getPlans);
router.post('/create-order', verifyToken, ctrl.createOrder);
router.post('/verify', verifyToken, ctrl.verifyPayment);

module.exports = router;
