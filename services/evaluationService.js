const { forwardGeminiGenerateContent } = require('./geminiService');

const OCR_CORRECTIONS = {
  // Keywords / Programming
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
  
  // Terminology
  "dacta": "data",
  "algorithrn": "algorithm",
  "analys1s": "analysis",
  "functons": "functions"
};

function cleanOcrText(text, ocrConfidence = 1) {
  if (!text || typeof text !== 'string') return '';

  // 1. Whitespace and indentation normalization
  let cleaned = text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ') // collapse multiple spaces/tabs
    .replace(/^[ \t]+/gm, '') // trim leading spaces on lines
    .trim();

  // 2. Normalize smart quotes, hyphens, and common symbols confusion
  cleaned = cleaned
    .replace(/[“‘’””]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2014\u2015\u2013]/g, "-") // em-dash, en-dash to hyphen
    .replace(/;+/g, ';');

  // 3. Repair broken punctuation spacing (e.g., obj . prop -> obj.prop, console . log -> console.log)
  cleaned = cleaned
    .replace(/\s+\.\s+/g, '.')
    .replace(/\b(console|System\.out|arr|list|map|obj|self|this)\s+\.\s*([a-zA-Z_])/g, '$1.$2')
    .replace(/([a-zA-Z0-9_])\s+\.\s+([a-zA-Z_])/g, '$1.$2');

  // 4. Keyword replacement and line-level OCR uncertainty tagging
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

    if (corrected) {
      if (!lineCleaned.includes('[Possible OCR corruption detected]')) {
        lineCleaned += ' // [Possible OCR corruption detected]';
      }
    }
    return lineCleaned;
  });
  cleaned = processedLines.join('\n');

  // 5. Standardize common casing discrepancies for coding constructs
  cleaned = cleaned
    .replace(/\bReturn\b/g, 'return')
    .replace(/\bPrint\b/g, 'print')
    .replace(/\bElse\b/g, 'else')
    .replace(/\bIf\b/g, 'if')
    .replace(/\bFor\b/g, 'for')
    .replace(/\bWhile\b/g, 'while')
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false');

  // 6. Block-level Low OCR confidence tagging
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

function normalizeText(value) {
  return String(value || '').trim();
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

    const questionText = String(item.question || '').trim();
    const match = questionText.match(/\d+/);
    const question = match ? Number(match[0]) : (index + 1);

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

async function gradeStudentAnswerSheet(questionPaperText, ocrText, mode, ocrConfidence, customInstructions) {
  const cleanedText = cleanOcrText(ocrText, ocrConfidence);
  const prompt = buildEvaluationPrompt(questionPaperText, cleanedText, mode, ocrConfidence, customInstructions);

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, topP: 0.8, maxOutputTokens: 4096 }
  };

  console.log(`[Evaluation Service] Sending request to Gemini...`);
  const response = await forwardGeminiGenerateContent(payload);

  if (response.statusCode !== 200) {
    throw new Error(`Gemini API proxy error (${response.statusCode}): ${response.body}`);
  }

  const data = JSON.parse(response.body);
  const extracted = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('\n').trim() || '';
  const cleanText = extracted.replace(/```json/g, '').replace(/```/g, '').trim();
  
  // Find valid JSON bounds
  const firstBrace = cleanText.indexOf('{');
  const lastBrace = cleanText.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    throw new Error('Gemini API did not return a valid JSON object in its text.');
  }
  const jsonCandidate = cleanText.slice(firstBrace, lastBrace + 1);
  const parsed = JSON.parse(jsonCandidate);
  
  const validated = validateAiResult(parsed);
  return validated;
}

module.exports = {
  cleanOcrText,
  buildEvaluationPrompt,
  validateAiResult,
  gradeStudentAnswerSheet
};
