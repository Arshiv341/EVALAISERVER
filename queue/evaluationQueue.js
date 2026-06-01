const EvalJob = require('../models/EvaluationJob');
const { extractTextFromPDF } = require('../services/ocrService');
const {
  finalizeJob,
  maybeFinalizeJob,
  syncJobProgress
} = require('../services/jobService');
const { gradeStudentAnswerSheet } = require('../services/evaluationService');

const OCR_PARALLELISM = 2;
const MAX_JOB_TIME = 20 * 60 * 1000; // 20 minutes
let isRunning = false;
const jobQueue = [];
const queuedJobIds = new Set();

async function retryAsync(fn, retries = 2, delay = 1000, contextLabel = '', onRetry = null) {
  let attempt = 0;
  while (attempt <= retries) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      console.warn(`[RETRY][${contextLabel}] Attempt ${attempt}/${retries} failed: ${err.message}`);
      if (attempt > retries) {
        throw err;
      }
      if (onRetry) {
        await onRetry(attempt, err);
      }
      await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, attempt - 1)));
    }
  }
}

function enqueue(jobId) {
  const id = String(jobId);
  if (queuedJobIds.has(id)) return false;

  queuedJobIds.add(id);
  jobQueue.push(id);
  processNext();
  return true;
}

function clearQueue() {
  jobQueue.length = 0;
  queuedJobIds.clear();
}

async function requeueIncompleteJobs() {
  const jobs = await EvalJob.find({
    status: { $in: ['queued', 'processing'] }
  })
    .sort({ createdAt: 1 })
    .select('_id');

  for (const job of jobs) {
    enqueue(job._id);
  }
}

async function processNext() {
  if (isRunning || jobQueue.length === 0) return;

  isRunning = true;
  const jobId = jobQueue.shift();
  queuedJobIds.delete(jobId);

  try {
    await Promise.race([

  processJob(jobId),

  new Promise((_, reject) =>
    setTimeout(() => {
      reject(new Error('Job timeout after 20 minutes'));
    }, MAX_JOB_TIME)
  )

]);
  } catch (err) {
    console.error(`[Queue] Fatal error on job ${jobId}:`, err);
    try {
      await EvalJob.findByIdAndUpdate(jobId, {
        status: 'error',
        errorMessage: err.message,
        currentlyProcessing: ''
      });
    } catch {}
  } finally {
    isRunning = false;
    processNext();
  }
}

async function processJob(jobId) {
  const job = await EvalJob.findById(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);

  console.log(`[Queue] Starting job ${jobId} - ${job.students.length} students, mode: ${job.mode}`);
  await EvalJob.findByIdAndUpdate(jobId, { status: 'processing', currentlyProcessing: '' });

  const total = job.students.length;

  for (let i = 0; i < total; i++) {
    const student = job.students[i];

    // Skip already completed/failed/processed students if the job is resumed or retried
    if (['completed', 'failed', 'error', 'ai_done'].includes(student.status)) {
      continue;
    }

    const currentLabel = `PDF ${i + 1}/${total} Processing: ${student.originalName}`;
    console.log(`[Queue] ${currentLabel}`);

    try {
      // 1. Update status to 'processing' and set the currentlyProcessing label
      await EvalJob.updateOne(
        { _id: jobId, 'students._id': student._id },
        {
          $set: {
            'students.$.status': 'processing',
            currentlyProcessing: currentLabel
          }
        }
      );
      await syncJobProgress(jobId);

      // 2. Perform OCR text extraction
      const result = await extractTextFromPDF(student.filePath);
      const ocrText = result.answersText || result.rawText || '';

      if (!String(ocrText).trim()) {
        throw new Error('No readable text detected in the PDF.');
      }

      // Save intermediate OCR text to student sub-document
      await EvalJob.updateOne(
        { _id: jobId, 'students._id': student._id },
        {
          $set: {
            'students.$.ocrText': ocrText,
            'students.$.ocrConfidence': Number(result.confidence || 0),
            'students.$.studentName': result.studentName,
            'students.$.rollNumber': result.rollNumber
          }
        }
      );

      // 3. Perform AI Evaluation using Gemini API with retry
      console.log(`[Queue] Grading student: ${student.originalName}`);
      const updateStatusToRetrying = async (attempt, err) => {
        try {
          await EvalJob.updateOne(
            { _id: jobId, 'students._id': student._id },
            {
              $set: {
                'students.$.status': 'retrying',
                'students.$.error': `Grading attempt ${attempt} failed: ${err.message}`
              }
            }
          );
          await syncJobProgress(jobId);
        } catch (dbErr) {
          console.error('[Queue] Failed to update status to retrying:', dbErr.message);
        }
      };

      const gradeFn = () => gradeStudentAnswerSheet(
        job.questionPaperText,
        ocrText,
        job.mode || 'avg',
        Number(result.confidence || 0),
        job.customInstructions
      );

      const validatedResult = await retryAsync(
        gradeFn,
        2,
        2000,
        `${student.originalName} Grading`,
        updateStatusToRetrying
      );

      const finalName = (result.studentName && result.studentName !== 'Unknown')
        ? result.studentName
        : (validatedResult.studentName || student.originalName);

      const finalRoll = (result.rollNumber && result.rollNumber !== 'Unknown')
        ? result.rollNumber
        : (validatedResult.rollNumber || 'Unknown');

      // Save AI evaluation result and mark student as completed
      await EvalJob.updateOne(
        { _id: jobId, 'students._id': student._id },
        {
          $set: {
            'students.$.answers': validatedResult.answers,
            'students.$.totalMarks': validatedResult.totalMarks,
            'students.$.studentName': finalName,
            'students.$.rollNumber': finalRoll,
            'students.$.status': 'completed',
            'students.$.processedAt': new Date(),
            'students.$.error': ''
          }
        }
      );

      console.log(`[Queue] Evaluation completed for ${student.originalName} -> ${finalName}`);

    } catch (err) {
      console.error(`[Queue] Evaluation failed for ${student.originalName}:`, err.message);

      // Mark student as failed and record the failure message
      await EvalJob.updateOne(
        { _id: jobId, 'students._id': student._id },
        {
          $set: {
            'students.$.status': 'failed',
            'students.$.error': err.message,
            'students.$.processedAt': new Date()
          }
        }
      );
    } finally {
      // Sync job completion count in database
      await syncJobProgress(jobId);
    }
  }

  // Once all students have been processed, finalize the job and output the Excel sheet
  console.log(`[Queue] All students processed. Finalizing job: ${jobId}`);
  await finalizeJob(jobId);
}

module.exports = {
  clearQueue,
  enqueue,
  processJob,
  processNext,
  requeueIncompleteJobs
};
