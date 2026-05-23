const EvalJob = require('../models/EvaluationJob');
const { extractTextFromPDF } = require('../services/ocrService');
const {
  maybeFinalizeJob,
  syncJobProgress
} = require('../services/jobService');

const OCR_PARALLELISM = 2;
const MAX_JOB_TIME = 20 * 60 * 1000; // 20 minutes
let isRunning = false;
const jobQueue = [];
const queuedJobIds = new Set();

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

  const pendingStudents = job.students.filter(student => student.status === 'pending');

  for (let i = 0; i < pendingStudents.length; i += OCR_PARALLELISM) {
    const batch = pendingStudents.slice(i, i + OCR_PARALLELISM);

    await Promise.all(batch.map(async student => {
      const studentId = student._id;
      try {
        await EvalJob.updateOne(
          { _id: jobId, 'students._id': studentId },
          {
            $set: {
              'students.$.status': 'ocr_processing',
              currentlyProcessing: student.originalName
            }
          }
        );

        const result = await extractTextFromPDF(student.filePath);
        const ocrText = result.answersText || result.rawText || '';

        if (!String(ocrText).trim()) {
          throw new Error('No readable text detected in the PDF.');
        }

        await EvalJob.updateOne(
          { _id: jobId, 'students._id': studentId },
          {
            $set: {
              'students.$.status': 'ocr_done',
              'students.$.ocrText': ocrText,
              'students.$.ocrConfidence': Number(result.confidence || 0),
              'students.$.studentName': result.studentName,
              'students.$.rollNumber': result.rollNumber
            }
          }
        );

        console.log(`[OCR] Done: ${student.originalName} -> ${result.studentName}`, {
          pages: result.pageCount,
          confidence: Number(result.confidence || 0)
        });
      } catch (err) {
        console.error(`[OCR] Error on ${student.originalName}:`, {
          message: err.message,
          code: err.code,
          responseCode: err.responseCode,
          stack: err.stack
        });
        await EvalJob.updateOne(
          { _id: jobId, 'students._id': studentId },
          {
            $set: {
              'students.$.status': 'error',
              'students.$.error': `OCR failed: ${err.message}`,
              currentlyProcessing: ''
            }
          }
        );
        await syncJobProgress(jobId, { currentlyProcessing: student.originalName, status: 'processing' });
      }
    }));
  }

  const freshJob = await EvalJob.findById(jobId);
  const ocrDoneStudents = freshJob.students.filter(student => student.status === 'ocr_done');

  const finalizedJob = await maybeFinalizeJob(jobId);
  if (finalizedJob) {
    console.log(`[Queue] Job ${jobId} completed`);
    return;
  }

  if (ocrDoneStudents.length > 0) {
    await syncJobProgress(jobId, {
      status: 'processing',
      currentlyProcessing: 'Waiting for browser AI'
    });
    console.log(`[Queue] Job ${jobId} OCR complete. Waiting for browser AI.`);
  }
}

module.exports = {
  clearQueue,
  enqueue,
  processJob,
  processNext,
  requeueIncompleteJobs
};
