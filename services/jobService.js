const fs = require('fs');
const path = require('path');
const EvalJob = require('../models/EvaluationJob');
const { generateExcel } = require('./excelService');

const RESULTS_DIR = path.join(__dirname, '../results');

function getStatusWeight(status) {
  switch (status) {
    case 'ocr_processing':
      return 25;
    case 'ocr_done':
      return 50;
    case 'ai_done':
      return 90;
    case 'completed':
    case 'error':
      return 100;
    default:
      return 0;
  }
}

function summarizeStudentStatuses(job) {
  const summary = {
    pending: 0,
    ocr_processing: 0,
    ocr_done: 0,
    ai_done: 0,
    completed: 0,
    error: 0
  };

  for (const student of job?.students || []) {
    if (Object.prototype.hasOwnProperty.call(summary, student.status)) {
      summary[student.status] += 1;
    } else {
      summary.pending += 1;
    }
  }

  return summary;
}

function countProcessedStudents(job) {
  return job.students.filter(student =>
    ['completed', 'ai_done', 'error', 'failed'].includes(student.status)
  ).length;
}

function countSuccessfulStudents(job) {
  return job.students.filter(student =>
    ['completed', 'ai_done'].includes(student.status)
  ).length;
}

function countErrorStudents(job) {
  return job.students.filter(student => ['error', 'failed'].includes(student.status)).length;
}

function calculateJobProgressPct(job) {
  if (!job || !Array.isArray(job.students) || job.students.length === 0) return 0;
  const total = job.students.length;
  const sum = job.students.reduce((acc, student) => acc + getStatusWeight(student.status), 0);
  return Math.min(100, Math.round(sum / total));
}

async function syncJobProgress(jobId, patch = {}) {
  const job = await EvalJob.findById(jobId).select('students totalStudents');
  if (!job) return null;

  const update = {
    completedStudents: countProcessedStudents(job)
  };

  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      update[key] = value;
    }
  }

  await EvalJob.updateOne({ _id: jobId }, { $set: update });

  return EvalJob.findById(jobId);
}

async function cleanupJobFiles(job) {
  if (!job) return;

  for (const student of job.students || []) {
    if (student.filePath && fs.existsSync(student.filePath)) {
      fs.unlinkSync(student.filePath);
    }
  }

  if (job.questionPaperPath && fs.existsSync(job.questionPaperPath)) {
    fs.unlinkSync(job.questionPaperPath);
  }
}

async function finalizeJob(jobId) {
  console.log("[TRACE] finalizeJob entered");
  const job = await EvalJob.findById(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);

  let excelPath = '';

  try {
    console.log("[TRACE] Before generating Excel");
    excelPath = await generateExcel(job, RESULTS_DIR);
    console.log("[TRACE] Excel generated");
  } catch (err) {
    console.error('[Excel] Failed:', err.message);
    console.error('error.stack:', err.stack);
    console.log("[TRACE] Before updating job status to error (Excel failed)");
    await EvalJob.findByIdAndUpdate(jobId, {
      status: 'error',
      errorMessage: `Excel generation failed: ${err.message}`,
      currentlyProcessing: '',
      completedAt: new Date()
    });
    return EvalJob.findById(jobId);
  }

  const processedStudents = countProcessedStudents(job);
  console.log("[TRACE] Before updating job status to completed");
  await EvalJob.findByIdAndUpdate(jobId, {
    status: 'completed',
    excelPath,
    completedStudents: processedStudents,
    currentlyProcessing: '',
    completedAt: new Date()
  });

  console.log("[TRACE] Before loading finalized job details");
  const finalJob = await EvalJob.findById(jobId);

  // Trigger background class performance analytics updates safely without blocking
  try {
    const { enqueueAnalytics } = require('./analyticsService');
    console.log("[TRACE] Enqueueing analytics update");
    enqueueAnalytics(finalJob.facultyId);
  } catch (analyticsError) {
    console.error('[Analytics Queue Trigger Error] Failed to enqueue analytics update:', analyticsError);
  }

  try {
    console.log("[TRACE] Cleaning up job files");
    await cleanupJobFiles(finalJob);
  } catch (err) {
    console.error('[Cleanup] Error:', err.message);
  }

  return finalJob;
}

async function maybeFinalizeJob(jobId) {
  console.log("[TRACE] maybeFinalizeJob entered");
  const job = await EvalJob.findById(jobId);
  if (!job) return null;

  if (job.status === 'completed') {
    console.log("[TRACE] Job already completed");
    return job;
  }

  const allDone = job.students.every(student =>
    ['ai_done', 'completed', 'error'].includes(student.status)
  );
  console.log("[TRACE] Checked allDone:", allDone);
  if (!allDone) {
    return null;
  }

  console.log("[TRACE] All students evaluated. Finalizing job...");
  return finalizeJob(jobId);
}

module.exports = {
  cleanupJobFiles,
  countErrorStudents,
  countProcessedStudents,
  countSuccessfulStudents,
  calculateJobProgressPct,
  finalizeJob,
  maybeFinalizeJob,
  summarizeStudentStatuses,
  syncJobProgress
};
