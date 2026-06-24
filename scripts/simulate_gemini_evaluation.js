require('dotenv').config();
const mongoose = require('mongoose');
const EvalJob = require('../models/EvaluationJob');
const { forwardGeminiGenerateContent } = require('../services/geminiService');

const mongoUri = process.env.MONGO_URI;

function buildEvaluationPrompt(questionPaperText, studentText, mode, ocrConfidence = 1, customInstructions = '') {
  const confidencePercent = Math.round(ocrConfidence * 100);
  const trimmedCustom = String(customInstructions || '').trim();

  return `
You are an AI exam evaluator. Provide high-quality, professional, teacher-like point-wise feedback and grading comments.

CRITICAL INSTRUCTION:
- Behave like a human teacher checking a handwritten answer sheet, not like a strict compiler.
- The student answers were extracted via OCR from handwritten paper and may contain spelling, symbol, spacing, punctuation, and syntax noise.
- The OCR extraction confidence score for this sheet is: ${confidencePercent}%.
- If the OCR extraction confidence is low (less than 85%), you must be extremely lenient with formatting, syntax, and spelling noise.
- Do NOT deduct marks for:
  * minor spelling errors (e.g. keyword corruption like 'retun' or 'prnt')
  * OCR character/symbol confusion (e.g. '0' instead of 'o', '1' instead of 'l', curly braces/brackets read incorrectly, or punctuation issues)
  * capitalization noise
  * spacing or indentation noise
- If the intended meaning is understandable despite OCR corruption, treat the answer as correct.
- Deduct marks ONLY if:
  * logic incorrect
  * algorithm wrong
  * formula incorrect
  * answer incomplete
  * concept missing
- For programming/coding questions: prioritize logical flow, algorithm structure, and intent over exact syntax. Tolerate OCR-corrupted keywords, broken spacing, and noisy extractions.
- Update "deduction_reason" in output:
  * Do NOT blame the student for OCR extraction issues.
  * If you ignore OCR corruption, explicitly write: "OCR-related noise ignored during grading." or "Possible OCR corruption detected; logic interpreted correctly."
  * Leave empty or write a neutral note if full marks are awarded.

IMPORTANT RULES:
- Return ONLY valid JSON.
- No explanations.
- No markdown.
- No backticks.
- Output must begin with { and end with }.

Instructions:
- Detect all questions automatically from the question paper.
- Evaluate student answers carefully.
- Give marks question-wise based on evaluation mode: "${mode}".
- Generate total marks correctly.
${trimmedCustom ? `
FACULTY CUSTOM INSTRUCTIONS:
${trimmedCustom}
` : ''}
- Provide detailed feedback for each question:
  - Evaluate conceptual correctness, missing keywords, formula mistakes, syntax issues, incomplete steps, logic errors, and presentation quality.
  - Explain concisely but meaningfully why marks were deducted or what mistakes were found in "deduction_reason" (leave empty if full marks).
  - Provide constructive teacher-like suggestion in "improvement_feedback".
  - Summarize what the student did well in "strengths" (e.g. good structure, correct definitions, clear handwriting/logic).
  - Specify any missing keywords, formula steps, or details in the "missing_points" array.

Required JSON structure:

{
  "studentName": "string",
  "rollNumber": "string",
  "answers": [
    {
      "question": "dynamic question identifier (e.g., 'Q1' or '1')",
      "marks_awarded": number,
      "deduction_reason": "string",
      "improvement_feedback": "string",
      "strengths": "string",
      "missing_points": ["string"]
    }
  ],
  "totalMarks": number
}

Question Paper:
${questionPaperText}

Student Answers:
${studentText}

Return ONLY valid JSON.
`;
}

function validateAiResult(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('AI result must be a JSON object.');
  }

  const studentName = String(payload.studentName || '').trim();
  const rollNumber = String(payload.rollNumber || '').trim();

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
    const rawQuestion = String(item.question || '').trim();
    const validationKey = rawQuestion.toLowerCase();

    console.log("Original Question:", rawQuestion);
    console.log("Validation Key:", validationKey);

    const rawMarks = item.marks_awarded !== undefined ? item.marks_awarded : item.marks;
    const marks = Number(rawMarks);

    if (!rawQuestion) {
      throw new Error(`Missing question identifier at position ${index + 1}.`);
    }
    if (seenQuestions.has(validationKey)) {
      throw new Error(`Duplicate question identifier ${rawQuestion} in AI result.`);
    }
    seenQuestions.add(validationKey);

    const deduction_reason = String(item.deduction_reason || '').trim();
    const improvement_feedback = String(item.improvement_feedback || '').trim();
    const strengths = String(item.strengths || '').trim();
    const missing_points = Array.isArray(item.missing_points)
      ? item.missing_points.map(pt => String(pt || '').trim()).filter(Boolean)
      : (item.missing_points ? [String(item.missing_points).trim()] : []);

    return {
      question: rawQuestion,
      marks,
      deduction_reason,
      improvement_feedback,
      strengths,
      missing_points
    };
  });

  const sum = answers.reduce((acc, answer) => acc + answer.marks, 0);
  const totalMarks = sum;

  return {
    studentName,
    rollNumber,
    answers,
    totalMarks
  };
}

mongoose.connect(mongoUri)
  .then(async () => {
    console.log('Connected to MongoDB.');

    const jobId = '6a1d5aa56639cf1d534a61d7';
    const job = await EvalJob.findById(jobId);
    if (!job) {
      console.log(`Job ${jobId} not found.`);
      mongoose.disconnect();
      return;
    }

    const student = job.students.find(s => s.originalName.includes('AANYA_JAISWAL'));
    if (!student) {
      console.log('Student AANYA_JAISWAL not found.');
      mongoose.disconnect();
      return;
    }

    console.log('\n--- SIMULATING GEMINI EVALUATION ---');
    const prompt = buildEvaluationPrompt(job.questionPaperText, student.ocrText, job.mode, student.ocrConfidence);
    console.log(`Prompt constructed (length: ${prompt.length})`);

    const requestPayload = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        topP: 0.8,
        maxOutputTokens: 8192,
        responseMimeType: "application/json",
        thinkingConfig: {
          thinkingBudget: 0
        }
      }
    };

    console.log('Sending request to Gemini...');
    const result = await forwardGeminiGenerateContent(requestPayload);
    console.log(`Gemini Status: ${result.statusCode}`);

    // Save raw response for diagnostics
    const fs = require('fs');
    const path = require('path');
    const logsDir = path.join(__dirname, '..', 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    fs.writeFileSync(path.join(logsDir, 'gemini_raw_response.txt'), result.body || '', 'utf8');
    fs.writeFileSync(path.join(logsDir, 'raw_gemini_response.txt'), result.body || '', 'utf8');

    let bodyObj;
    try {
      bodyObj = JSON.parse(result.body);
    } catch (parseErr) {
      console.error('Failed to parse Gemini response body as JSON. Raw body:', result.body);
      mongoose.disconnect();
      return;
    }

    const extracted = bodyObj?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('\n').trim() || '';
    
    console.log('\n--- PARSING AND VALIDATING RESPONSE ---');
    let validated;
    try {
      // Clean and parse the Gemini evaluation output defensively
      const cleanAndParseJson = (text) => {
        const value = String(text || '').trim();
        let cleanCandidate = value
          .replace(/```json/gi, '')
          .replace(/```/gi, '')
          .trim();

        const firstBrace = cleanCandidate.indexOf('{');
        const lastBrace = cleanCandidate.lastIndexOf('}');
        if (firstBrace >= 0 && lastBrace > firstBrace) {
          cleanCandidate = cleanCandidate.slice(firstBrace, lastBrace + 1);
        }

        cleanCandidate = cleanCandidate
          .replace(/[“”]/g, '"')
          .replace(/[‘’]/g, "'");

        cleanCandidate = cleanCandidate.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/g, (match) => {
          return match.replace(/\r?\n/g, '\\n');
        });

        cleanCandidate = cleanCandidate.replace(/,\s*([}\]])/g, '$1');

        return JSON.parse(cleanCandidate);
      };

      const parsed = cleanAndParseJson(extracted);
      validated = validateAiResult(parsed);
      console.log('\nValidation Succeeded! Validated object:', JSON.stringify(validated, null, 2));
    } catch (err) {
      console.error('\nValidation Failed:', err.message);
      console.error('Raw Extracted Text:', extracted);
      mongoose.disconnect();
      return;
    }

    console.log('\n--- SAVING RESULT TO DATABASE ---');
    try {
      await EvalJob.updateOne(
        { _id: jobId, 'students._id': student._id },
        {
          $set: {
            'students.$.answers': validated.answers,
            'students.$.totalMarks': validated.totalMarks,
            'students.$.studentName': validated.studentName,
            'students.$.rollNumber': validated.rollNumber,
            'students.$.status': 'completed', // Let's mark it completed!
            'students.$.processedAt': new Date(),
            'students.$.error': ''
          }
        }
      );
      console.log('✅ Result saved successfully!');

      // Fetch refreshed job to show final state
      const refreshedJob = await EvalJob.findById(jobId);
      const refreshedStudent = refreshedJob.students.id(student._id);
      console.log('\nRefreshed Student Record from DB:');
      console.log(`  Student Name: ${refreshedStudent.studentName}`);
      console.log(`  Roll Number: ${refreshedStudent.rollNumber}`);
      console.log(`  Status: ${refreshedStudent.status}`);
      console.log(`  Total Marks Saved: ${refreshedStudent.totalMarks}`);
      console.log(`  Answers Array Size: ${refreshedStudent.answers.length}`);
      console.log(`  Answers:`);
      refreshedStudent.answers.forEach(a => {
        console.log(`    - Q${a.question}: Marks=${a.marks}`);
      });
    } catch (saveErr) {
      console.error('Failed to save to database:', saveErr);
    }

    mongoose.disconnect();
  })
  .catch(err => {
    console.error('Connection failed:', err);
  });
