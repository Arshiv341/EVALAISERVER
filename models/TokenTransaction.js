const mongoose = require('mongoose');

const tokenTransactionSchema = new mongoose.Schema({
  facultyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Faculty',
    required: true
  },
  type: {
    type: String,
    enum: ['credit', 'deduction'],
    required: true
  },
  amount: {
    type: Number,
    required: true
  },
  description: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'success', 'failed'],
    default: 'pending'
  },
  orderId: {
    type: String
  },
  paymentId: {
    type: String
  },
  signature: {
    type: String
  },
  credited: {
    type: Boolean,
    default: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Create index for fast lookups and unique checking
tokenTransactionSchema.index({ paymentId: 1 }, { unique: true, sparse: true });
tokenTransactionSchema.index({ facultyId: 1 });

module.exports = mongoose.model('TokenTransaction', tokenTransactionSchema);
