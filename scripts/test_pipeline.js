require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { extractQuestionPaperText, extractTextFromPDF } = require('../services/ocrService');
const { forwardGeminiGenerateContent } = require('../services/geminiService');

const qpPath = 'C:\\Users\\drrit\\Downloads\\checking sample\\QuestionPaper.pdf';
const studentPath = 'C:\\Users\\drrit\\Downloads\\checking sample\\testing\\mod\\Programming_in_C-Theory_25CS101__2025_Term_1_FY-BTech__AIML__-1_2503215300018_AJAY_GUPTA.pdf.pdf';

const OCR_CORRECTIONS = {
  "returr": "return",
  "retun": "return",
  "retum": "return",
  "brint": "print",
  "fa1se": "false",
  "fa15e": "false",
  "tmue": "true",
  "el5e": "else",
  "eløe": "else",
  "inclucle": "include",
  "inc1ude": "include",
  "functon": "function",
  "func": "function",
  "defi": "def",
  "importt": "import",
  "whi1e": "while",
  "c1ass": "class",
  "system.out.brintln": "System.out.println",
  "system.out.print1n": "System.out.println",
  "console.1og": "console.log",
  "dacta": "data",
  "algorithrn": "algorithm",
  "analys1s": "analysis",
  "functons": "functions"
};

function cleanOcrText(text, ocrConfidence = 1) {
  if (!text || typeof text !== 'string') return '';
  let cleaned = text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/^[ \t]+/gm, '')
    .trim();

  cleaned = cleaned
    .replace(/[“‘’””]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2014\u2015\u2013]/g, "-")
    .replace(/;+/g, ';');

  cleaned = cleaned
    .replace(/\s+\.\s+/g, '.')
    .replace(/\b(console|System\.out|arr|list|map|obj|self|this)\s+\.\s*([a-zA-Z_])/g, '$1.$2')
    .replace(/([a-zA-Z0-9_])\s+\.\s+([a-zA-Z_])/g, '$1.$2');

  const lines = cleaned.split('\n');
  const processedLines = lines.map(line => {
    let lineCleaned = line;
    let corrected = false;
    for (const [bad, good] of Object.entries(OCR_CORRECTIONS)) {
      const escapedBad = bad.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      const regex = new RegExp(`\\b${escapedBad}\\b`, 'gi');
      if (regex.test(lineCleaned)) {
        lineCleaned = lineCleaned.replace(regex, good);
        corrected = true;
      }
    }
    if (corrected && !lineCleaned.includes('[Possible OCR corruption detected]')) {
      lineCleaned += ' // [Possible OCR corruption detected]';
    }
    return lineCleaned;
  });
  cleaned = processedLines.join('\n');

  cleaned = cleaned
    .replace(/\bReturn\b/g, 'return')
    .replace(/\bPrint\b/g, 'print')
    .replace(/\bElse\b/g, 'else')
    .replace(/\bIf\b/g, 'if')
    .replace(/\bFor\b/g, 'for')
    .replace(/\bWhile\b/g, 'while')
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false');

  if (ocrConfidence < 0.85) {
    const confidencePercent = Math.round(ocrConfidence * 100);
    cleaned = `[Possible OCR corruption detected: Low OCR confidence (${confidencePercent}%)]\n\n` + cleaned;
  }
  return cleaned;
}

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
    const match = rawQuestion.match(/\d+/);
    const question = match ? Number(match[0]) : index + 1;
    const rawMarks = item.marks_awarded !== undefined ? item.marks_awarded : item.marks;
    const marks = Number(rawMarks);

    if (!question) {
      throw new Error(`Missing question identifier at position ${index + 1}.`);
    }
    if (seenQuestions.has(question)) {
      throw new Error(`Duplicate question identifier ${question} in AI result.`);
    }
    seenQuestions.add(question);

    if (!Number.isFinite(marks)) {
      throw new Error(`Invalid marks for question ${question}.`);
    }
    if (marks < 0) {
      throw new Error(`Negative marks are not allowed for question ${question}.`);
    }

    const deduction_reason = String(item.deduction_reason || '').trim();
    const improvement_feedback = String(item.improvement_feedback || '').trim();
    const strengths = String(item.strengths || '').trim();
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

async function main() {
  console.log('--- STARTING PIPELINE TRACE ---');

  // 1. Question Paper Extraction
  console.log('\n--- STEP 1: Question Paper Extraction ---');
  let qpText = '';
  try {
    qpText = await extractQuestionPaperText(qpPath);
    console.log(`Question Paper Text Length: ${qpText.length}`);
    console.log(`Question Paper Snippet (First 500 chars):\n${qpText.substring(0, 500)}`);
  } catch (err) {
    console.error('Question Paper OCR Failed:', err);
    return;
  }

  // 2. Student Answer OCR Extraction
  console.log('\n--- STEP 2: Student Answer OCR Extraction ---');
  let studentOcr = null;
  try {
    studentOcr = await extractTextFromPDF(studentPath);
    console.log('Student OCR Success:');
    console.log(`  Student Name: ${studentOcr.studentName}`);
    console.log(`  Roll Number: ${studentOcr.rollNumber}`);
    console.log(`  Confidence: ${studentOcr.confidence}`);
    console.log(`  Page Count: ${studentOcr.pageCount}`);
    console.log(`  Raw Answers Text Length: ${studentOcr.answersText ? studentOcr.answersText.length : 0}`);
    console.log(`  Snippet (First 500 chars):\n${String(studentOcr.answersText || '').substring(0, 500)}`);
  } catch (err) {
    console.error('Student OCR Failed:', err);
    return;
  }

  // 3. Clean Student OCR text
  console.log('\n--- STEP 3: OCR Cleaning ---');
  const cleanedText = cleanOcrText(studentOcr.answersText, studentOcr.confidence);
  console.log(`Cleaned Text Length: ${cleanedText.length}`);
  console.log(`Cleaned Text Snippet (First 300 chars):\n${cleanedText.substring(0, 300)}`);

  // 4. Build Gemini prompt
  console.log('\n--- STEP 4: Prompt Construction ---');
  const prompt = buildEvaluationPrompt(qpText, cleanedText, 'avg', studentOcr.confidence, '');
  console.log(`Prompt Length: ${prompt.length}`);
  console.log(`Prompt Snippet (Last 500 chars):\n${prompt.substring(prompt.length - 500)}`);

  // 5. Gemini API Call
  console.log('\n--- STEP 5: Gemini AI Request Payload ---');
  const requestPayload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, topP: 0.8, maxOutputTokens: 4096 }
  };
  console.log('Sending request to Gemini...');

  let geminiResponse;
  try {
    geminiResponse = await forwardGeminiGenerateContent(requestPayload);
    console.log(`Gemini Status Code: ${geminiResponse.statusCode}`);
    console.log(`Gemini Response Body Length: ${geminiResponse.body.length}`);
    console.log(`Gemini Response Body Snippet (First 800 chars):\n${geminiResponse.body.substring(0, 800)}`);
  } catch (err) {
    console.error('Gemini Request Failed:', err);
    return;
  }

  // 6. JSON Parse & Validation & Marks Calculation
  console.log('\n--- STEP 6: Marks Calculation & Parsing ---');
  try {
    const data = JSON.parse(geminiResponse.body);
    const extracted = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('\n').trim() || '';
    console.log(`Extracted text from Gemini:\n${extracted}`);

    const cleanJsonText = extracted.replace(/```json/g, '').replace(/```/g, '').trim();
    console.log(`Cleaned JSON Text:\n${cleanJsonText}`);

    const parsed = JSON.parse(cleanJsonText);
    console.log('Parsed JSON object successfully.');

    const validated = validateAiResult(parsed);
    console.log('Validated Result:', JSON.stringify(validated, null, 2));
    console.log(`Total Marks Awarded: ${validated.totalMarks}`);
  } catch (err) {
    console.error('Parsing/Validation Failed:', err.message);
  }
}

main();
