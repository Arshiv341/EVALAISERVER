const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const vision = require('@google-cloud/vision');

const execFileAsync = promisify(execFile);
const OCR_TEMP_ROOT = path.join(__dirname, '../temp/ocr');
const LANGUAGE_HINTS = ['en', 'hi'];

function getClientOptions() {
  const projectId = process.env.GOOGLE_PROJECT_ID;
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;

  if (projectId && clientEmail && privateKey) {
    return {
      projectId,
      credentials: {
        client_email: clientEmail,
        private_key: privateKey.replace(/\\n/g, '\n')
      }
    };
  }

  if (projectId) {
    return { projectId };
  }

  return {};
}

let _client = null;

function getClient() {
  if (!_client) {
    _client = new vision.ImageAnnotatorClient(getClientOptions());
  }
  return _client;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sanitizeSegment(value) {
  const safe = String(value || 'document')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  return safe || 'document';
}

function resolveBundledPdftoppmPath() {
  const bundleRoot = path.join(__dirname, '../node_modules/pdf-poppler/lib');

  if (process.platform === 'win32') {
    return path.join(bundleRoot, 'win', 'poppler-0.51', 'bin', 'pdftoppm.exe');
  }

  if (process.platform === 'darwin') {
    return path.join(bundleRoot, 'osx', 'poppler-0.66', 'bin', 'pdftoppm');
  }

  return null;
}

function resolvePdftoppmBinary() {
  const bundled = resolveBundledPdftoppmPath();
  if (bundled && fs.existsSync(bundled)) {
    return bundled;
  }

  return process.platform === 'win32' ? 'pdftoppm.exe' : 'pdftoppm';
}

function normalizeLine(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\t+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function normalizePageText(text) {
  const lines = String(text || '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(normalizeLine);

  const output = [];
  for (const line of lines) {
    if (!line) {
      if (output.length > 0 && output[output.length - 1] !== '') {
        output.push('');
      }
      continue;
    }

    if (output.length > 0 && output[output.length - 1].toLowerCase() === line.toLowerCase()) {
      continue;
    }

    output.push(line);
  }

  while (output.length > 0 && output[0] === '') output.shift();
  while (output.length > 0 && output[output.length - 1] === '') output.pop();

  return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function isNumberedLine(line) {
  return /^\s*(?:\d+[.)]|[a-zA-Z][.)]|[ivxlcdm]+\.)\s*/i.test(String(line || ''));
}

function looksLikeHeaderFooter(line) {
  return /(page\s*\d+(\s*of\s*\d+)?|\d+\s*\/\s*\d+|name|roll|student id|candidate|question paper|answer sheet|subject|course|semester|exam|college|university|school|date|invigilator|signature)/i
    .test(String(line || ''));
}

function cleanDocumentText(pageTexts) {
  const pages = (pageTexts || []).map(normalizePageText).filter(Boolean);
  if (pages.length === 0) return '';

  const lineCounts = new Map();
  for (const page of pages) {
    const seenInPage = new Set();
    for (const line of page.split('\n')) {
      if (!line) continue;
      const key = line.toLowerCase();
      if (seenInPage.has(key)) continue;
      seenInPage.add(key);
      lineCounts.set(key, (lineCounts.get(key) || 0) + 1);
    }
  }

  const output = [];
  const emitted = new Set();

  for (const page of pages) {
    for (const line of page.split('\n')) {
      if (!line) {
        if (output.length > 0 && output[output.length - 1] !== '') {
          output.push('');
        }
        continue;
      }

      const key = line.toLowerCase();
      const repeated = (lineCounts.get(key) || 0) > 1;
      const shouldSkip = repeated
        && emitted.has(key)
        && line.length <= 100
        && !isNumberedLine(line)
        && looksLikeHeaderFooter(line);

      if (shouldSkip) continue;

      emitted.add(key);
      output.push(line);
    }

    if (output.length > 0 && output[output.length - 1] !== '') {
      output.push('');
    }
  }

  while (output.length > 0 && output[0] === '') output.shift();
  while (output.length > 0 && output[output.length - 1] === '') output.pop();

  return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function extractVisionText(response) {
  const candidates = [
    response?.fullTextAnnotation?.text,
    Array.isArray(response?.textAnnotations) ? response.textAnnotations[0]?.description : '',
    response?.text
  ];

  for (const candidate of candidates) {
    const text = normalizePageText(candidate);
    if (text) return text;
  }

  return '';
}

function collectConfidenceValues(node, values) {
  if (!node || typeof node !== 'object') return;

  if (typeof node.confidence === 'number' && Number.isFinite(node.confidence)) {
    values.push(node.confidence);
  }

  if (Array.isArray(node.pages)) {
    for (const page of node.pages) collectConfidenceValues(page, values);
  }

  if (Array.isArray(node.blocks)) {
    for (const block of node.blocks) collectConfidenceValues(block, values);
  }

  if (Array.isArray(node.paragraphs)) {
    for (const paragraph of node.paragraphs) collectConfidenceValues(paragraph, values);
  }

  if (Array.isArray(node.words)) {
    for (const word of node.words) collectConfidenceValues(word, values);
  }

  if (Array.isArray(node.symbols)) {
    for (const symbol of node.symbols) collectConfidenceValues(symbol, values);
  }
}

function estimateConfidence(response) {
  const values = [];
  collectConfidenceValues(response?.fullTextAnnotation, values);

  if (values.length === 0) {
    collectConfidenceValues(response, values);
  }

  if (values.length === 0) {
    return 0;
  }

  const average = values.reduce((acc, value) => acc + value, 0) / values.length;
  return Number(average.toFixed(3));
}

function extractPageNumber(fileName, fallbackIndex) {
  const match = String(fileName || '').match(/-(\d+)\.(?:jpe?g)$/i);
  if (match && match[1]) {
    return Number(match[1]);
  }

  return fallbackIndex + 1;
}

function cleanupTempDir(tempDir) {
  try {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.warn('[OCR] Failed to clean temporary directory:', {
      path: tempDir,
      message: err.message
    });
  }
}

async function convertPdfToImages(filePath, label) {
  ensureDir(OCR_TEMP_ROOT);

  const tempDir = fs.mkdtempSync(
    path.join(OCR_TEMP_ROOT, `${sanitizeSegment(path.basename(filePath, path.extname(filePath)))}-`)
  );
  const outputPrefix = path.join(tempDir, 'page');
  const pdftoppm = resolvePdftoppmBinary();

  console.log(`[OCR][${label}] Converting PDF pages to JPG images...`, {
    source: path.basename(filePath),
    tempDir,
    binary: pdftoppm
  });

  try {
    const { stdout, stderr } = await execFileAsync(
      pdftoppm,
      ['-jpeg', '-r', '300', filePath, outputPrefix],
      {
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true
      }
    );

    if (stdout && stdout.trim()) {
      console.log(`[OCR][${label}] pdftoppm stdout:`, stdout.trim());
    }

    if (stderr && stderr.trim()) {
      console.log(`[OCR][${label}] pdftoppm stderr:`, stderr.trim());
    }
  } catch (err) {
    console.error(`[OCR][${label}] PDF to image conversion failed:`, {
      message: err.message,
      code: err.code,
      stdout: err.stdout,
      stderr: err.stderr,
      stack: err.stack
    });
    cleanupTempDir(tempDir);
    throw new Error(`Failed to convert PDF pages to images: ${err.message}`);
  }

  const imageFiles = fs.readdirSync(tempDir)
    .filter(fileName => /\.jpe?g$/i.test(fileName))
    .map((fileName, index) => ({
      pageNumber: extractPageNumber(fileName, index),
      filePath: path.join(tempDir, fileName),
      fileName
    }))
    .sort((a, b) => a.pageNumber - b.pageNumber);

  if (imageFiles.length === 0) {
    cleanupTempDir(tempDir);
    throw new Error(`No JPG page images were generated for ${path.basename(filePath)}.`);
  }

  return { tempDir, imageFiles };
}

async function ocrImagePage(client, imagePath, pageNumber, totalPages, label) {
  try {
    const [response] = await client.documentTextDetection({
      image: {
        source: {
          filename: imagePath
        }
      },
      imageContext: {
        languageHints: LANGUAGE_HINTS
      }
    });

    const text = extractVisionText(response);
    const confidence = estimateConfidence(response);

    if (text) {
      console.log(`[OCR][${label}] Page ${pageNumber}/${totalPages} success:`, {
        chars: text.length,
        confidence
      });
    } else {
      console.warn(`[OCR][${label}] Page ${pageNumber}/${totalPages} returned no readable text.`);
    }

    return {
      pageNumber,
      text,
      confidence,
      success: Boolean(text),
      error: ''
    };
  } catch (err) {
    console.error(`[OCR][${label}] Page ${pageNumber}/${totalPages} failed:`, {
      message: err.message,
      code: err.code,
      responseCode: err.responseCode,
      stack: err.stack
    });

    return {
      pageNumber,
      text: '',
      confidence: 0,
      success: false,
      error: err.message
    };
  }
}

async function extractDocumentOcr(filePath, { label = 'document' } = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`PDF file not found: ${filePath || '(missing path)'}`);
  }

  const client = getClient();
  const { tempDir, imageFiles } = await convertPdfToImages(filePath, label);

  try {
    const pageResults = await Promise.all(
      imageFiles.map(page => ocrImagePage(client, page.filePath, page.pageNumber, imageFiles.length, label))
    );

    pageResults.sort((a, b) => a.pageNumber - b.pageNumber);

    const rawText = pageResults
      .map(page => page.text)
      .filter(Boolean)
      .join('\n\n')
      .trim();

    const cleanedText = cleanDocumentText(pageResults.map(page => page.text));
    const finalText = cleanedText || rawText;

    const confidenceValues = pageResults
      .map(page => page.confidence)
      .filter(value => Number.isFinite(value) && value > 0);
    const confidence = confidenceValues.length > 0
      ? Number((confidenceValues.reduce((acc, value) => acc + value, 0) / confidenceValues.length).toFixed(3))
      : 0;

    const successfulPages = pageResults.filter(page => page.success && page.text).length;
    const failedPages = pageResults.length - successfulPages;

    console.log(`[OCR][${label}] OCR complete:`, {
      pages: pageResults.length,
      successfulPages,
      failedPages,
      chars: finalText.length,
      confidence
    });

    if (!String(finalText || '').trim()) {
      throw new Error(`OCR produced no readable text for ${label}.`);
    }

    if (String(finalText).replace(/\s+/g, '').length < 20) {
      throw new Error(`OCR output is too short to evaluate reliably for ${label}.`);
    }

    return {
      text: finalText,
      rawText,
      pageCount: pageResults.length,
      confidence,
      pages: pageResults
    };
  } finally {
    cleanupTempDir(tempDir);
  }
}

async function extractQuestionPaperOcr(filePath) {
  return extractDocumentOcr(filePath, { label: 'Question paper' });
}

async function extractQuestionPaperText(filePath) {
  const result = await extractQuestionPaperOcr(filePath);
  return result.text;
}

async function extractTextFromPDF(filePath) {
  const result = await extractDocumentOcr(filePath, { label: 'Answer sheet' });
  const text = String(result.text || '').trim();
  const metadata = extractMetadata(text);

  return {
    studentName: metadata.studentName,
    rollNumber: metadata.rollNumber,
    answersText: text,
    rawText: result.rawText,
    pageCount: result.pageCount,
    confidence: result.confidence,
    pages: result.pages
  };
}

function isValidStudentName(name) {
  if (!name) return false;
  const clean = name.trim();
  if (clean.length < 2 || clean.length > 50) return false;
  
  // Reject names that contain brackets, parentheses, semicolons, or other coding markers
  if (/[{}();#<>\[\]\/]/g.test(clean)) return false;
  
  // Reject if it contains common programming keywords as separate words
  const lower = clean.toLowerCase();
  const badKeywords = [
    'void', 'int', 'float', 'double', 'class', 'struct', 'return', 'include',
    'using', 'namespace', 'cout', 'cin', 'public', 'private', 'parameter',
    'function', 'object', 'prototype', 'define', 'if', 'else', 'for', 'while'
  ];
  for (const kw of badKeywords) {
    if (lower.split(/\s+/).includes(kw)) return false;
  }
  return true;
}

function extractField(text, labels) {
  const lines = String(text || '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    for (const label of labels) {
      // Use word boundaries around label to avoid substring matching
      const pattern = new RegExp(`^\\s*[^a-zA-Z0-9]*\\s*\\b${escapeRegex(label)}\\b\\s*[:=\\-|]?\\s*(.+)$`, 'i');
      const match = line.match(pattern);
      if (match && match[1]) {
        const candidate = normalizeLine(match[1]);
        if (candidate) return candidate;
      }
    }
  }

  for (const label of labels) {
    // Use word boundaries around label to avoid substring matching
    const genericPattern = new RegExp(`\\b${escapeRegex(label)}\\b\\s*[:=\\-|]?\\s*([^\\n]+)`, 'i');
    const match = String(text || '').match(genericPattern);
    if (match && match[1]) {
      const candidate = normalizeLine(match[1]);
      if (candidate) return candidate;
    }
  }

  return '';
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractMetadata(text) {
  const lines = String(text || '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  const headerLines = lines.slice(0, 10);
  const headerText = headerLines.join('\n');

  let studentName = extractField(headerText, [
    'student name',
    'candidate name',
    'full name',
    'naam',
    'name'
  ]);

  if (studentName && !isValidStudentName(studentName)) {
    studentName = '';
  }

  const rollNumber = extractField(headerText, [
    'roll no',
    'roll number',
    'roll',
    'registration no',
    'reg no',
    'registration number',
    'student id'
  ]);

  if (studentName === 'Unknown' || !studentName) {
    const firstLine = lines[0] || '';
    if (firstLine && firstLine.length < 50 && !firstLine.includes(':') && !/\d/.test(firstLine) && isValidStudentName(firstLine)) {
      studentName = firstLine;
    }
  }

  return {
    studentName: studentName || 'Unknown',
    rollNumber: rollNumber || 'Unknown'
  };
}

module.exports = {
  extractDocumentOcr,
  extractQuestionPaperOcr,
  extractQuestionPaperText,
  extractTextFromPDF
};
