const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const EvalJob = require('../models/EvaluationJob');
const Faculty = require('../models/Faculty');
const TokenTransaction = require('../models/TokenTransaction');
const { extractQuestionPaperOcr } = require('../services/ocrService');
const { enqueue } = require('../queue/evaluationQueue');
const {
  maybeFinalizeJob,
  syncJobProgress,
  calculateJobProgressPct,
  summarizeStudentStatuses
} = require('../services/jobService');

const UPLOADS_DIR = path.join(__dirname, '../uploads');

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    cb(null, UPLOADS_DIR);
  },
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, `${Date.now()}_${safeName}`);
  }
});

const fileFilter = (_req, file, cb) => {
  if (file.mimetype === 'application/pdf') {
    cb(null, true);
  } else {
    cb(new Error('Only PDF files are allowed.'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 20 * 1024 * 1024, files: 51 }
});

const uploadFields = upload.fields([
  { name: 'questionPaper', maxCount: 1 },
  { name: 'answerSheets', maxCount: 50 }
]);

exports.uploadMiddleware = uploadFields;

function getFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', data => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', err => reject(err));
  });
}

function cleanupFiles(filePaths = []) {
  for (const filePath of filePaths) {
    if (!filePath || !fs.existsSync(filePath)) continue;
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      console.warn('[upload] Failed to remove temporary upload file:', {
        filePath,
        message: err.message
      });
    }
  }
}

function normalizeText(value) {
  return String(value || '').trim();
}

function isMeaningfulText(value) {
  const text = normalizeText(value);
  if (!text) return false;

  const lower = text.toLowerCase();
  return !['unknown', 'n/a', 'na', 'none', 'null', '-'].includes(lower);
}

function parseResultPayload(result) {
  if (typeof result === 'string') {
    return JSON.parse(result);
  }

  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return result;
  }

  throw new Error('AI result must be a JSON object or JSON string.');
}

function validateAiResult(result) {
  const payload = parseResultPayload(result);
  const studentName = normalizeText(payload.studentName);
  const rollNumber = normalizeText(payload.rollNumber);

  if (!studentName) {
    throw new Error('AI result must include studentName.');
  }

  if (!rollNumber) {
    throw new Error('AI result must include rollNumber.');
  }

  if (!Array.isArray(payload.answers)) {
    throw new Error('AI result answers must be an array.');
  }

  const seenQuestions = new Set();
  const answers = payload.answers.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Invalid answer entry at position ${index + 1}.`);
    }

    const question = Number(item.question);
    const rawMarks = item.marks_awarded !== undefined ? item.marks_awarded : item.marks;
    const marks = Number(rawMarks);

    if (!Number.isInteger(question) || question < 1) {
      throw new Error(`Invalid question number at position ${index + 1}.`);
    }

    if (seenQuestions.has(question)) {
      throw new Error(`Duplicate question number ${question} in AI result.`);
    }
    seenQuestions.add(question);

    if (!Number.isFinite(marks)) {
      throw new Error(`Invalid marks for question ${question}.`);
    }

    if (marks < 0) {
      throw new Error(`Negative marks are not allowed for question ${question}.`);
    }

    const deduction_reason = item.deduction_reason ? String(item.deduction_reason).trim() : '';
    const improvement_feedback = item.improvement_feedback ? String(item.improvement_feedback).trim() : '';
    const strengths = item.strengths ? String(item.strengths).trim() : '';
    const missing_points = Array.isArray(item.missing_points)
      ? item.missing_points.map(pt => String(pt || '').trim()).filter(Boolean)
      : (item.missing_points ? [String(item.missing_points).trim()] : []);

    return {
      question,
      marks,
      deduction_reason,
      improvement_feedback,
      strengths,
      missing_points
    };
  });

  const totalMarks = Number(payload.totalMarks);
  if (!Number.isFinite(totalMarks)) {
    throw new Error('AI result totalMarks must be a number.');
  }

  const sum = answers.reduce((acc, answer) => acc + answer.marks, 0);
  if (Math.abs(sum - totalMarks) > 1e-6) {
    throw new Error('AI result totalMarks must match the sum of answer marks.');
  }

  return {
    studentName,
    rollNumber,
    answers,
    totalMarks
  };
}

function buildJobCounts(job) {
  const counts = summarizeStudentStatuses(job);
  return {
    pendingStudents: counts.pending,
    ocrProcessingStudents: counts.ocr_processing,
    ocrDoneStudents: counts.ocr_done,
    aiDoneStudents: counts.ai_done,
    completedStudents: counts.ai_done + counts.completed + counts.error,
    errorStudents: counts.error,
    successfulStudents: counts.ai_done + counts.completed,
    processedStudents: counts.ocr_done + counts.ai_done + counts.completed + counts.error
  };
}

exports.upload = async (req, res) => {
  const uploadedPaths = [];

  try {
    const qpFiles = req.files?.questionPaper;
    const asFiles = req.files?.answerSheets;

    if (!qpFiles || qpFiles.length === 0) {
      return res.status(400).json({ error: 'Question paper PDF is required.' });
    }

    if (!asFiles || asFiles.length === 0) {
      return res.status(400).json({ error: 'At least one answer sheet PDF is required.' });
    }

    // 1. Duplicate detection (filename & SHA-256 content hash)
    const uniqueFiles = [];
    const skippedFiles = [];
    const seenNames = new Set();
    const seenHashes = new Set();

    for (const file of asFiles) {
      const normalizedName = String(file.originalname || '').trim().toLowerCase();
      
      let fileHash = '';
      try {
        fileHash = await getFileHash(file.path);
      } catch (hashError) {
        console.error(`[HASH ERROR] Failed to calculate hash for ${file.originalname}:`, hashError);
      }

      const isDuplicateName = seenNames.has(normalizedName);
      const isDuplicateHash = fileHash ? seenHashes.has(fileHash) : false;

      if (isDuplicateName || isDuplicateHash) {
        console.log(`[DUPLICATE DETECTED] ${file.originalname}`);
        console.log(`[DUPLICATE REMOVED FROM QUEUE] ${file.originalname}`);
        skippedFiles.push(file.originalname);
        try {
          fs.unlinkSync(file.path);
        } catch (unlinkError) {
          console.warn(`[CLEANUP WARNING] Failed to delete duplicate file ${file.path}:`, unlinkError);
        }
      } else {
        seenNames.add(normalizedName);
        if (fileHash) {
          seenHashes.add(fileHash);
        }
        uniqueFiles.push(file);
      }
    }

    if (uniqueFiles.length === 0) {
      try {
        fs.unlinkSync(qpFiles[0].path);
      } catch {}
      return res.status(400).json({
        error: 'All uploaded answer sheets were duplicates and have been skipped.',
        processedCount: 0,
        skippedCount: skippedFiles.length,
        skippedFiles
      });
    }

    // 2. Enforce Token Verification BEFORE uploading/processing
    const faculty = await Faculty.findById(req.faculty.id).populate('transactionHistory');
    if (!faculty) {
      cleanupFiles([qpFiles[0].path, ...uniqueFiles.map(f => f.path)]);
      return res.status(404).json({ error: 'Faculty profile not found.' });
    }

    const hasSuccessfulCredit = faculty.transactionHistory && faculty.transactionHistory.some(t => t.type === 'credit' && t.status === 'success');
    const isPremiumUser = (faculty.availableTokens > 20) || hasSuccessfulCredit;

    if (uniqueFiles.length > 1 && !isPremiumUser) {
      cleanupFiles([qpFiles[0].path, ...uniqueFiles.map(f => f.path)]);
      return res.status(403).json({
        success: false,
        error: "Bulk evaluation available only for premium users"
      });
    }

    const requiredTokens = uniqueFiles.length * 2;
    const available = typeof faculty.availableTokens === 'number' ? faculty.availableTokens : 20;

    if (available < requiredTokens) {
      cleanupFiles([qpFiles[0].path, ...uniqueFiles.map(f => f.path)]);
      return res.status(403).json({
        error: `Insufficient tokens. Evaluating ${uniqueFiles.length} answer sheets requires ${requiredTokens} tokens, but you only have ${available} available. Please recharge.`
      });
    }

    const mode = String(req.body?.mode || 'avg').toLowerCase();
    if (!['hard', 'avg', 'low'].includes(mode)) {
      cleanupFiles([qpFiles[0].path, ...uniqueFiles.map(f => f.path)]);
      return res.status(400).json({ error: 'Invalid evaluation mode.' });
    }

    const qpPath = qpFiles[0].path;
    uploadedPaths.push(qpPath, ...uniqueFiles.map(file => file.path));

    const customInstructions = req.body?.customInstructions !== undefined
      ? String(req.body.customInstructions).trim()
      : '';

    console.log('[TRACE 2] upload endpoint body:', req.body);
    console.log('[TRACE 3] isPremiumUser status in upload endpoint:', isPremiumUser);
    console.log('[TRACE 4] customInstructions extracted:', customInstructions);

    if (customInstructions.length > 0) {
      if (!isPremiumUser) {
        cleanupFiles(uploadedPaths);
        return res.status(403).json({ error: 'Custom Instructions are available only for Premium users.' });
      }
      if (customInstructions.length > 2000) {
        cleanupFiles(uploadedPaths);
        return res.status(400).json({ error: 'Custom instructions cannot exceed 2000 characters.' });
      }
    }

    const storedInstructions = isPremiumUser ? customInstructions : '';
    console.log('[TRACE 5] customInstructions saved in DB (storedInstructions):', storedInstructions);

    let qpOcr;
    try {
      qpOcr = await extractQuestionPaperOcr(qpPath);
    } catch (err) {
      console.error('Question paper extraction failed:', {
        message: err.message,
        code: err.code,
        responseCode: err.responseCode,
        stack: err.stack
      });
      cleanupFiles(uploadedPaths);
      const statusCode = /no readable text|too short/i.test(String(err.message || ''))
        ? 422
        : 500;
      return res.status(statusCode).json({
        error: `Could not extract readable text from the question paper PDF. ${err.message}`
      });
    }

    const qpText = String(qpOcr?.text || '').trim();
    if (!qpText) {
      cleanupFiles(uploadedPaths);
      return res.status(422).json({
        error: 'Could not extract readable text from the question paper PDF.'
      });
    }

    const students = uniqueFiles.map(file => ({
      originalName: file.originalname,
      filePath: file.path,
      status: 'pending',
      ocrText: '',
      ocrConfidence: 0,
      studentName: '',
      rollNumber: '',
      answers: [],
      totalMarks: 0,
      error: ''
    }));

    const job = await EvalJob.create({
      facultyId: req.faculty.id,
      questionPaperPath: qpPath,
      questionPaperText: qpText,
      questionPaperOcrConfidence: Number(qpOcr?.confidence || 0),
      mode,
      customInstructions: storedInstructions,
      students,
      totalStudents: students.length,
      completedStudents: 0,
      status: 'queued',
      currentlyProcessing: ''
    });

    // 2. Perform Atomic Token Deduction
    const updatedFaculty = await Faculty.findOneAndUpdate(
      { _id: req.faculty.id, availableTokens: { $gte: requiredTokens } },
      {
        $inc: {
          availableTokens: -requiredTokens,
          totalUsedTokens: requiredTokens,
          totalEvaluatedPdfs: students.length
        }
      },
      { new: true }
    );

    if (!updatedFaculty) {
      // Clean up newly created job and files if balance checked out initially but failed atomic update
      await EvalJob.deleteOne({ _id: job._id });
      cleanupFiles(uploadedPaths);
      return res.status(403).json({ error: 'Insufficient tokens. Transaction aborted.' });
    }

    // 3. Create Deduction Log in TokenTransaction collection
    const transaction = await TokenTransaction.create({
      facultyId: req.faculty.id,
      type: 'deduction',
      amount: requiredTokens,
      description: `Evaluated ${students.length} answer sheets (Job ID: ${job._id})`,
      status: 'success',
      credited: false
    });

    // Link transaction to user's history array
    await Faculty.findByIdAndUpdate(req.faculty.id, {
      $push: { transactionHistory: transaction._id }
    });

    enqueue(job._id);

    res.status(201).json({
      success: true,
      jobId: job._id,
      message: `Job queued. Processing ${students.length} answer sheet(s).`,
      processedCount: uniqueFiles.length,
      skippedCount: skippedFiles.length,
      skippedFiles
    });
  } catch (err) {
    console.error('upload error:', err);
    cleanupFiles(uploadedPaths);
    res.status(500).json({ error: `Upload failed. ${err.message}` });
  }
};

exports.getStatus = async (req, res) => {
  try {
    const job = await EvalJob.findOne({
      _id: req.params.jobId,
      facultyId: req.faculty.id
    }).select('questionPaperText questionPaperOcrConfidence students status mode customInstructions totalStudents completedStudents currentlyProcessing excelPath createdAt completedAt');

    if (!job) {
      return res.status(404).json({ error: 'Job not found.' });
    }

    const counts = buildJobCounts(job);
    const currentLabel = job.currentlyProcessing || (
      counts.ocrDoneStudents > 0
        ? 'Waiting for browser AI'
        : ''
    );

    console.log('[TRACE 6] getStatus response customInstructions:', job.customInstructions);

    res.json({
      jobId: job._id,
      status: job.status,
      mode: job.mode,
      customInstructions: job.customInstructions || '',
      totalStudents: job.totalStudents,
      pendingStudents: counts.pendingStudents,
      ocrProcessingStudents: counts.ocrProcessingStudents,
      ocrDoneStudents: counts.ocrDoneStudents,
      aiDoneStudents: counts.aiDoneStudents,
      completedStudents: counts.completedStudents,
      processedStudents: counts.processedStudents,
      successfulStudents: counts.successfulStudents,
      errorStudents: counts.errorStudents,
      progressPct: calculateJobProgressPct(job),
      currentlyProcessing: currentLabel,
      excelReady: Boolean(job.excelPath),
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      questionPaperText: job.questionPaperText,
      questionPaperOcrConfidence: job.questionPaperOcrConfidence || 0,
      students: job.students.map(student => ({
        id: student._id,
        name: student.studentName || student.originalName,
        originalName: student.originalName,
        rollNumber: student.rollNumber,
        status: student.status,
        ocrText: student.ocrText,
        ocrConfidence: student.ocrConfidence || 0,
        totalMarks: student.totalMarks,
        answers: student.answers,
        error: student.error
      }))
    });
  } catch (err) {
    res.status(500).json({ error: 'Status fetch failed.' });
  }
};

exports.saveResult = async (req, res) => {
  try {
    const { jobId, studentId, result } = req.body || {};
    if (!jobId || !studentId || !result) {
      return res.status(400).json({ error: 'jobId, studentId, and result are required.' });
    }

    const job = await EvalJob.findOne({ _id: jobId, facultyId: req.faculty.id });
    if (!job) {
      return res.status(404).json({ error: 'Job not found.' });
    }

    const student = job.students.id(studentId);
    if (!student) {
      return res.status(404).json({ error: 'Student not found in job.' });
    }

    if (student.status === 'ai_done' || student.status === 'completed') {
      await maybeFinalizeJob(jobId);
      return res.json({ success: true, message: 'Result already saved.' });
    }

    if (student.status !== 'ocr_done') {
      return res.status(409).json({
        error: `Student is not ready for AI save. Current status: ${student.status}.`
      });
    }

    let normalized;
    try {
      normalized = validateAiResult(result);
    } catch (validationError) {
      return res.status(422).json({ error: validationError.message });
    }

    const storedName = isMeaningfulText(student.studentName)
      ? normalizeText(student.studentName)
      : normalized.studentName;
    const storedRollNumber = isMeaningfulText(student.rollNumber)
      ? normalizeText(student.rollNumber)
      : normalized.rollNumber;

    await EvalJob.updateOne(
      { _id: jobId, 'students._id': studentId },
      {
        $set: {
          'students.$.answers': normalized.answers,
          'students.$.totalMarks': normalized.totalMarks,
          'students.$.studentName': storedName,
          'students.$.rollNumber': storedRollNumber,
          'students.$.status': 'ai_done',
          'students.$.processedAt': new Date(),
          'students.$.error': ''
        }
      }
    );

    const maybeFinalJob = await maybeFinalizeJob(jobId);
    if (!maybeFinalJob) {
      const refreshedJob = await EvalJob.findById(jobId).select('students');
      const counts = buildJobCounts(refreshedJob);
      await syncJobProgress(jobId, {
        status: 'processing',
        currentlyProcessing: counts.ocrDoneStudents > 0
          ? 'Waiting for browser AI'
          : ''
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('saveResult error:', err);
    res.status(500).json({ error: 'Save failed.' });
  }
};

exports.download = async (req, res) => {
  try {
    const job = await EvalJob.findOne({
      _id: req.params.jobId,
      facultyId: req.faculty.id
    });

    if (!job) {
      return res.status(404).json({ error: 'Job not found.' });
    }

    if (!job.excelPath) {
      return res.status(400).json({ error: 'Excel not ready yet.' });
    }

    if (!fs.existsSync(job.excelPath)) {
      return res.status(404).json({ error: 'Excel file not found on server.' });
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="EvalAI_Results_${job._id}.xlsx"`);
    fs.createReadStream(job.excelPath).pipe(res);
  } catch (err) {
    res.status(500).json({ error: 'Download failed.' });
  }
};

exports.getJobs = async (req, res) => {
  try {
    const jobs = await EvalJob.find({ facultyId: req.faculty.id })
      .select('status mode totalStudents completedStudents createdAt completedAt excelPath students')
      .sort({ createdAt: -1 })
      .limit(20);

    res.json({
      jobs: jobs.map(job => {
        const counts = buildJobCounts(job);
        return {
          id: job._id,
          status: job.status,
          mode: job.mode,
          totalStudents: job.totalStudents,
          completedStudents: counts.completedStudents,
          processedStudents: counts.processedStudents,
          ocrDoneStudents: counts.ocrDoneStudents,
          aiDoneStudents: counts.aiDoneStudents,
          errorStudents: counts.errorStudents,
          progressPct: calculateJobProgressPct(job),
          excelReady: Boolean(job.excelPath),
          createdAt: job.createdAt,
          completedAt: job.completedAt
        };
      })
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch jobs.' });
  }
};

exports.getAnalytics = async (req, res) => {
  try {
    const ClassAnalytics = require('../models/ClassAnalytics');
    const { regenerateClassAnalytics } = require('../services/analyticsService');
    const facultyId = req.faculty.id;

    console.log(`[ROUTE HIT] GET /api/eval/analytics - Faculty ID: ${facultyId}`);

    let analytics = await ClassAnalytics.findOne({ facultyId });
    if (analytics) {
      console.log(`[Analytics DB Check] Analytics document found for Faculty: ${facultyId}`);
    } else {
      console.log(`[Analytics DB Check] Analytics document NOT found for Faculty: ${facultyId}. Regenerating...`);
      analytics = await regenerateClassAnalytics(facultyId);
    }

    const totalJobs = await EvalJob.countDocuments({ facultyId });
    const completedJobs = await EvalJob.countDocuments({ facultyId, status: 'completed' });
    console.log(`[Analytics Stats] Faculty: ${facultyId} - Total jobs found: ${totalJobs}, Completed jobs found: ${completedJobs}, Total students aggregated: ${analytics ? analytics.totalStudents : 0}`);

    res.json({ success: true, analytics });
  } catch (err) {
    console.error('getAnalytics error:', err);
    res.status(500).json({ error: `Failed to fetch class performance analytics. ${err.message}` });
  }
};

exports.refreshAnalytics = async (req, res) => {
  try {
    const { regenerateClassAnalytics } = require('../services/analyticsService');
    const facultyId = req.faculty.id;

    console.log(`[ROUTE HIT] POST /api/eval/analytics/refresh - Faculty ID: ${facultyId}`);

    const analytics = await regenerateClassAnalytics(facultyId);

    const totalJobs = await EvalJob.countDocuments({ facultyId });
    const completedJobs = await EvalJob.countDocuments({ facultyId, status: 'completed' });
    console.log(`[Analytics Stats After Refresh] Faculty: ${facultyId} - Total jobs found: ${totalJobs}, Completed jobs found: ${completedJobs}, Total students aggregated: ${analytics ? analytics.totalStudents : 0}`);

    res.json({ success: true, analytics });
  } catch (err) {
    console.error('refreshAnalytics error:', err);
    res.status(500).json({ error: `Failed to regenerate class performance analytics. ${err.message}` });
  }
};
