const mongoose = require('mongoose');
require('./TokenTransaction');

const facultySchema = new mongoose.Schema({
  name:         { type: String, required: true, trim: true },
  email:        { type: String, required: true, unique: true, lowercase: true, trim: true },
  department:   { type: String, required: true, trim: true },
  employeeId:   { type: String, required: true, unique: true, trim: true },
  passwordHash: { type: String, required: true },
  availableTokens:    { type: Number, default: 20 },
  totalUsedTokens:     { type: Number, default: 0 },
  totalEvaluatedPdfs:  { type: Number, default: 0 },
  transactionHistory:  [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TokenTransaction'
  }],
  institutionalAccess: { type: Boolean, default: false },
  institutionName:     { type: String, default: '' },
  institutionPlan:     { type: String, default: '' },
  lastInstitutionalRenewal: { type: Date },
  createdAt:    { type: Date, default: Date.now }
}, { toJSON: { virtuals: true }, toObject: { virtuals: true } });

facultySchema.virtual('isPremium').get(function () {
  if (this.institutionalAccess) return true;
  const hasSuccessfulCredit = this.transactionHistory && this.transactionHistory.some(t => {
    if (t && typeof t === 'object' && t.type === 'credit' && t.status === 'success') {
      return true;
    }
    return false;
  });
  return (this.availableTokens > 20) || !!hasSuccessfulCredit;
});

facultySchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.passwordHash;
    return ret;
  }
});

module.exports = mongoose.model('Faculty', facultySchema);
