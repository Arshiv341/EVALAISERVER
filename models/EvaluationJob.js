const mongoose = require('mongoose');

// ── Student sub-document ─────────────────────────────────────
const studentSchema = new mongoose.Schema({
  originalName:  { type: String },                 // original filename
  filePath:      { type: String },                 // disk path (deleted after done)
  status: {
    type:    String,
    enum:    ['pending', 'processing', 'completed', 'failed', 'ocr_processing', 'ocr_done', 'ai_done', 'error', 'retrying'],
    default: 'pending'
  },
  ocrText:       { type: String, default: '' },
  ocrConfidence: { type: Number, default: 0 },
  studentName:   { type: String, default: '' },
  rollNumber:    { type: String, default: '' },
  answers:       [{
    question: { type: String, required: true },
    marks: Number,
    deduction_reason: { type: String, default: '' },
    improvement_feedback: { type: String, default: '' },
    strengths: { type: String, default: '' },
    missing_points: [{ type: String }]
  }],
  totalMarks:    { type: Number, default: 0 },
  error:         { type: String, default: '' },
  processedAt:   { type: Date }
}, { _id: true });

// ── Main evaluation job ──────────────────────────────────────
const evaluationJobSchema = new mongoose.Schema({
  facultyId:          { type: mongoose.Schema.Types.ObjectId, ref: 'Faculty', required: true },
  questionPaperPath:  { type: String },            // disk path (deleted after done)
  questionPaperText:  { type: String, default: '' },
  questionPaperOcrConfidence: { type: Number, default: 0 },
  mode: {
    type:    String,
    enum:    ['hard', 'avg', 'low'],
    default: 'avg'
  },
  customInstructions: { type: String, default: '' },
  students:    [studentSchema],
  excelPath:   { type: String, default: '' },
  status: {
    type:    String,
    enum:    ['queued', 'processing', 'completed', 'error'],
    default: 'queued'
  },
  currentlyProcessing: { type: String, default: '' },
  totalStudents:       { type: Number, default: 0 },
  completedStudents:   { type: Number, default: 0 },
  errorMessage:        { type: String, default: '' },
  createdAt:           { type: Date, default: Date.now },
  completedAt:         { type: Date }
});

// ── Virtual: progress percentage ─────────────────────────────
evaluationJobSchema.virtual('progressPct').get(function () {
  if (!this.totalStudents) return 0;
  return Math.round((this.completedStudents / this.totalStudents) * 100);
});

evaluationJobSchema.set('toJSON', { virtuals: true });
evaluationJobSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('EvaluationJob', evaluationJobSchema);
