const router = require('express').Router();
const {
  sendOtp,
  verifyOtp,
  testEmail,
  register,
  login,
  logout,
  me
} = require('../controllers/authController');
const verifyToken = require('../middleware/auth');

router.post('/send-otp',   sendOtp);
router.post('/test-email', verifyToken, testEmail);
router.post('/verify-otp', verifyOtp);
router.post('/register',   register);
router.post('/login',      login);
router.post('/logout',     logout);
router.get('/me',          verifyToken, me);

module.exports = router;
