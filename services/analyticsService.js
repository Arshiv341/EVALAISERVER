const EvalJob = require('../models/EvaluationJob');
const Faculty = require('../models/Faculty');
const TokenTransaction = require('../models/TokenTransaction');
const ClassAnalytics = require('../models/ClassAnalytics');
const { forwardGeminiGenerateContent } = require('./geminiService');

const analyticsQueue = [];
let isProcessingQueue = false;

/**
 * Enqueue a faculty ID for background analytics regeneration.
 * Returns immediately without blocking the caller.
 * @param {string} facultyId 
 */
function enqueueAnalytics(facultyId) {
  const idStr = String(facultyId);
  if (!analyticsQueue.includes(idStr)) {
    analyticsQueue.push(idStr);
  }
  void processNextInQueue();
}

/**
 * Sequential background worker processing analytics requests one by one.
 */
async function processNextInQueue() {
  if (isProcessingQueue || analyticsQueue.length === 0) return;
  
  isProcessingQueue = true;
  const facultyId = analyticsQueue.shift();
  
  try {
    console.log(`[Analytics Queue] Regenerating analytics for faculty: ${facultyId}`);
    await regenerateClassAnalytics(facultyId);
    console.log(`[Analytics Queue] Completed analytics for faculty: ${facultyId}`);
  } catch (err) {
    console.error(`[Analytics Queue] Failed for faculty ${facultyId}:`, err);
  } finally {
    isProcessingQueue = false;
    void processNextInQueue();
  }
}

/**
 * Helper to extract the top N elements of an array by frequency.
 */
function getMostCommonItems(arr, limit = 5) {
  const counts = {};
  for (const item of arr) {
    if (!item) continue;
    const cleanItem = String(item).trim().replace(/\s+/g, ' ');
    if (cleanItem.length > 3) {
      counts[cleanItem] = (counts[cleanItem] || 0) + 1;
    }
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([val]) => val);
}

/**
 * Core analytics aggregation logic, Gemini analysis, and cache update.
 * @param {string} facultyId 
 * @returns {Promise<object>} The generated ClassAnalytics document
 */
function estimateMaxMarks(highestMarks) {
  if (highestMarks <= 10) return 10;
  if (highestMarks <= 20) return 20;
  if (highestMarks <= 25) return 25;
  if (highestMarks <= 50) return 50;
  if (highestMarks <= 80) return 80;
  return 100;
}

async function regenerateClassAnalytics(facultyId) {
  // 1. Fetch faculty details
  const faculty = await Faculty.findById(facultyId).populate('transactionHistory');
  if (!faculty) {
    throw new Error('Faculty member not found.');
  }

  // 2. Fetch all completed jobs for this faculty
  const completedJobs = await EvalJob.find({ facultyId, status: 'completed' }).sort({ createdAt: 1 });
  if (completedJobs.length === 0) {
    // No completed jobs: write clean empty analytics
    return await ClassAnalytics.findOneAndUpdate(
      { facultyId },
      {
        $set: {
          lastUpdated: new Date(),
          totalJobs: 0,
          totalStudents: 0,
          averageMarks: 0,
          highestMarks: 0,
          lowestMarks: 0,
          passPercentage: 0,
          marksDistribution: [],
          topPerformers: [],
          studentsRequiringAttention: [],
          topicAnalytics: [],
          evaluationTrends: [],
          strongTopics: [],
          weakTopics: [],
          commonMissingPoints: [],
          commonReasonsForDeduction: [],
          commonImprovementSuggestions: [],
          classSummary: '',
          commonMistakes: [],
          improvementSuggestions: [],
          teachingRecommendations: [],
          aiInsightsAvailable: false,
          aiInsightsError: false
        }
      },
      { upsert: true, new: true }
    );
  }

  // 3. Aggregate student stats locally
  const allStudents = [];
  const evaluationTrends = [];
  const jobMap = {};

  for (const job of completedJobs) {
    const jobStudents = (job.students || []).filter(s => ['completed', 'ai_done'].includes(s.status));
    if (jobStudents.length === 0) continue;

    jobMap[job._id.toString()] = `Batch ${job._id.toString().slice(-6).toUpperCase()}`;

    const jobMarks = jobStudents.map(s => s.totalMarks);
    const jobAvg = jobMarks.reduce((a, b) => a + b, 0) / jobStudents.length;
    const jobMax = Math.max(...jobMarks);
    const jobMin = Math.min(...jobMarks);

    evaluationTrends.push({
      jobId: job._id.toString(),
      jobName: `Batch ${job._id.toString().slice(-6).toUpperCase()}`,
      averageMarks: Math.round(jobAvg * 10) / 10,
      highestMarks: jobMax,
      lowestMarks: jobMin,
      totalStudents: jobStudents.length,
      completedAt: job.completedAt || job.createdAt
    });

    for (const student of jobStudents) {
      allStudents.push({
        _id: student._id,
        studentName: student.studentName || student.originalName || 'Unknown',
        rollNumber: student.rollNumber || 'Unknown',
        totalMarks: student.totalMarks,
        answers: student.answers || [],
        jobName: `Batch ${job._id.toString().slice(-6).toUpperCase()}`
      });
    }
  }

  if (allStudents.length === 0) {
    return await ClassAnalytics.findOneAndUpdate(
      { facultyId },
      {
        $set: {
          lastUpdated: new Date(),
          totalJobs: completedJobs.length,
          totalStudents: 0,
          averageMarks: 0,
          highestMarks: 0,
          lowestMarks: 0,
          passPercentage: 0,
          marksDistribution: [],
          topPerformers: [],
          studentsRequiringAttention: [],
          topicAnalytics: [],
          evaluationTrends: [],
          strongTopics: [],
          weakTopics: [],
          commonMissingPoints: [],
          commonReasonsForDeduction: [],
          commonImprovementSuggestions: [],
          classSummary: '',
          commonMistakes: [],
          improvementSuggestions: [],
          teachingRecommendations: [],
          aiInsightsAvailable: false,
          aiInsightsError: false
        }
      },
      { upsert: true, new: true }
    );
  }

  const marks = allStudents.map(s => s.totalMarks);
  const totalStudents = allStudents.length;
  const averageMarks = Math.round((marks.reduce((a, b) => a + b, 0) / totalStudents) * 10) / 10;
  const highestMarks = Math.max(...marks);
  const lowestMarks = Math.min(...marks);

  // Dynamic pass rate estimation: passing is >= 40% of the estimated maximum mark of the test
  const maxMarks = estimateMaxMarks(highestMarks);
  const passingScore = 0.4 * maxMarks;
  const passingCount = allStudents.filter(s => s.totalMarks >= passingScore).length;
  const passPercentage = Math.round((passingCount / totalStudents) * 100);

  // static range distribution bins: 0-20, 21-40, 41-60, 61-80, 81-100 based on percentage of maxMarks
  const marksDistribution = [
    { range: '0-20', count: 0 },
    { range: '21-40', count: 0 },
    { range: '41-60', count: 0 },
    { range: '61-80', count: 0 },
    { range: '81-100', count: 0 }
  ];

  for (const s of allStudents) {
    const pct = maxMarks > 0 ? (s.totalMarks / maxMarks) * 100 : 0;
    if (pct <= 20) {
      marksDistribution[0].count++;
    } else if (pct <= 40) {
      marksDistribution[1].count++;
    } else if (pct <= 60) {
      marksDistribution[2].count++;
    } else if (pct <= 80) {
      marksDistribution[3].count++;
    } else {
      marksDistribution[4].count++;
    }
  }

  // Performer lists
  const sortedDesc = [...allStudents].sort((a, b) => b.totalMarks - a.totalMarks);
  const topPerformers = sortedDesc.slice(0, 5).map(s => ({
    studentName: s.studentName,
    rollNumber: s.rollNumber,
    totalMarks: s.totalMarks,
    jobName: s.jobName
  }));

  const sortedAsc = [...allStudents].sort((a, b) => a.totalMarks - b.totalMarks);
  const studentsRequiringAttention = sortedAsc.slice(0, 5).map(s => ({
    studentName: s.studentName,
    rollNumber: s.rollNumber,
    totalMarks: s.totalMarks,
    jobName: s.jobName
  }));

  // Topic/Question Analytics
  const questionStats = {};
  for (const student of allStudents) {
    for (const ans of student.answers) {
      const qNum = Number(ans.question);
      if (Number.isInteger(qNum) && qNum > 0) {
        if (!questionStats[qNum]) {
          questionStats[qNum] = [];
        }
        questionStats[qNum].push(Number(ans.marks || 0));
      }
    }
  }

  const topicAnalytics = Object.entries(questionStats).map(([qNum, marksList]) => {
    const avg = marksList.reduce((a, b) => a + b, 0) / marksList.length;
    const maxQMarks = Math.max(...marksList, 1);
    // Success rate is percentage of students who got >= 50% of the max mark achieved for this question
    const passingQCount = marksList.filter(m => m >= 0.5 * maxQMarks).length;
    const successRate = Math.round((passingQCount / marksList.length) * 100);
    return {
      topic: `Question ${qNum}`,
      averageScore: Math.round(avg * 10) / 10,
      successRate
    };
  }).sort((a, b) => {
    const numA = Number(a.topic.replace('Question ', ''));
    const numB = Number(b.topic.replace('Question ', ''));
    return numA - numB;
  });

  // Weak & Strong topics for compatibility with existing charts data structure
  const strongTopics = [...topicAnalytics]
    .sort((a, b) => b.successRate - a.successRate)
    .slice(0, 5)
    .map(t => ({ topic: t.topic, score: t.successRate }));

  const weakTopics = [...topicAnalytics]
    .sort((a, b) => a.successRate - b.successRate)
    .slice(0, 5)
    .map(t => ({ topic: t.topic, score: t.successRate }));

  // Save/update the cached document completely locally
  const updateData = {
    lastUpdated: new Date(),
    totalJobs: completedJobs.length,
    totalStudents,
    averageMarks,
    highestMarks,
    lowestMarks,
    passPercentage,
    marksDistribution,
    topPerformers,
    studentsRequiringAttention,
    topicAnalytics,
    evaluationTrends,
    strongTopics,
    weakTopics,
    commonMissingPoints: [],
    commonReasonsForDeduction: [],
    commonImprovementSuggestions: [],
    classSummary: '',
    commonMistakes: [],
    improvementSuggestions: [],
    teachingRecommendations: [],
    aiInsightsAvailable: false,
    aiInsightsError: false
  };

  return await ClassAnalytics.findOneAndUpdate(
    { facultyId },
    { $set: updateData },
    { upsert: true, new: true }
  );
}

module.exports = {
  enqueueAnalytics,
  regenerateClassAnalytics
};
