const mongoose = require('mongoose');

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
  createdAt:    { type: Date, default: Date.now }
});

facultySchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.passwordHash;
    return ret;
  }
});

module.exports = mongoose.model('Faculty', facultySchema);
