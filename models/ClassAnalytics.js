const mongoose = require('mongoose');

const classAnalyticsSchema = new mongoose.Schema({
  facultyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Faculty', required: true, unique: true },
  lastUpdated: { type: Date, default: Date.now },
  totalJobs: { type: Number, default: 0 },
  totalStudents: { type: Number, default: 0 },
  averageMarks: { type: Number, default: 0 },
  highestMarks: { type: Number, default: 0 },
  lowestMarks: { type: Number, default: 0 },
  passPercentage: { type: Number, default: 0 },
  
  marksDistribution: [{
    range: { type: String, required: true },
    count: { type: Number, required: true }
  }],
  
  topPerformers: [{
    studentName: { type: String, required: true },
    rollNumber: { type: String },
    totalMarks: { type: Number, required: true },
    jobName: { type: String, required: true }
  }],
  
  studentsRequiringAttention: [{
    studentName: { type: String, required: true },
    rollNumber: { type: String },
    totalMarks: { type: Number, required: true },
    jobName: { type: String, required: true }
  }],
  
  topicAnalytics: [{
    topic: { type: String, required: true },
    averageScore: { type: Number, required: true },
    successRate: { type: Number, required: true }
  }],
  
  commonMissingPoints: [{ type: String }],
  commonReasonsForDeduction: [{ type: String }],
  commonImprovementSuggestions: [{ type: String }],
  
  evaluationTrends: [{
    jobId: { type: String, required: true },
    jobName: { type: String, required: true },
    averageMarks: { type: Number, required: true },
    highestMarks: { type: Number, required: true },
    lowestMarks: { type: Number, required: true },
    totalStudents: { type: Number, required: true },
    completedAt: { type: Date, required: true }
  }],
  
  // AI Insights (Premium tier only)
  classSummary: { type: String, default: '' },
  strongTopics: [{
    topic: { type: String, required: true },
    score: { type: Number, required: true }
  }],
  weakTopics: [{
    topic: { type: String, required: true },
    score: { type: Number, required: true }
  }],
  commonMistakes: [{ type: String }],
  improvementSuggestions: [{ type: String }],
  teachingRecommendations: [{ type: String }],
  
  // Gating & Error states
  aiInsightsAvailable: { type: Boolean, default: false },
  aiInsightsError: { type: Boolean, default: false }
});

module.exports = mongoose.model('ClassAnalytics', classAnalyticsSchema);
