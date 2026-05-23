const router      = require('express').Router();
const verifyToken = require('../middleware/auth');
const ctrl        = require('../controllers/evaluationController');
const geminiCtrl  = require('../controllers/geminiController');
const { checkPremiumForBulk } = require('../middleware/premium');

// All eval routes require authentication
router.use(verifyToken);

// Upload question paper + answer sheets
router.post('/upload',      ctrl.uploadMiddleware, checkPremiumForBulk, ctrl.upload);

// Proxy Gemini generateContent requests through the backend secret
router.post('/gemini', geminiCtrl.generateContent);

// Poll job status
router.get('/status/:jobId', ctrl.getStatus);

// Save an AI result (manual override / external result)
router.post('/save-result', ctrl.saveResult);

// Download Excel file
router.get('/download/:jobId', ctrl.download);

// List all jobs for the logged-in faculty
router.get('/jobs',         ctrl.getJobs);

module.exports = router;
