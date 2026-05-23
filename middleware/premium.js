const Faculty = require('../models/Faculty');

const checkPremiumForBulk = async (req, res, next) => {
  try {
    const asFiles = req.files?.answerSheets;
    // If it's a bulk upload (more than 1 answer sheet)
    if (asFiles && asFiles.length > 1) {
      if (!req.faculty || !req.faculty.id) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }

      // Populate transactionHistory to check if there are successful payments
      const faculty = await Faculty.findById(req.faculty.id).populate('transactionHistory');
      if (!faculty) {
        return res.status(404).json({ success: false, error: 'Faculty profile not found' });
      }

      const hasSuccessfulCredit = faculty.transactionHistory && faculty.transactionHistory.some(t => t.type === 'credit' && t.status === 'success');
      const isPremiumUser = (faculty.availableTokens > 20) || hasSuccessfulCredit;

      if (!isPremiumUser) {
        return res.status(403).json({
          success: false,
          error: "Bulk evaluation available only for premium users"
        });
      }
    }
    next();
  } catch (err) {
    console.error('Premium check middleware error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error during premium check' });
  }
};

module.exports = { checkPremiumForBulk };
