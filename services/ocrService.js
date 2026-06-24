const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const vision = require('@google-cloud/vision');
const https = require('https');

const execFileAsync = promisify(execFile);

async function retryAsync(fn, retries = 2, delay = 1000, contextLabel = '') {
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
      await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, attempt - 1)));
    }
  }
}

function getPngDimensions(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    if (buffer.toString('ascii', 1, 4) === 'PNG') {
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      return { width, height };
    }
  } catch (err) {
    console.error('[OCR] Failed to parse PNG dimensions:', err.message);
  }
  return { width: 0, height: 0 };
}

function callGeminiOcr(imagePath) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !String(apiKey).trim()) {
    throw new Error('GEMINI_API_KEY is missing.');
  }

  const base64Data = fs.readFileSync(imagePath).toString('base64');
  const payload = {
    contents: [
      {
        parts: [
          {
            text: "Perform OCR on this image. Extract all text exactly as written, preserving structure and layout as much as possible."
          },
          {
            inlineData: {
              mimeType: "image/png",
              data: base64Data
            }
          }
        ]
      }
    ]
  };

  const body = JSON.stringify(payload);
  const GEMINI_HOST = 'generativelanguage.googleapis.com';
  const GEMINI_PATH = '/v1beta/models/gemini-2.5-flash:generateContent';

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        method: 'POST',
        hostname: GEMINI_HOST,
        path: GEMINI_PATH,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-goog-api-key': apiKey
        }
      },
      response => {
        let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', chunk => responseBody += chunk);
        response.on('end', () => {
          if (response.statusCode === 200) {
            try {
              const resObj = JSON.parse(responseBody);
              const text = resObj?.candidates?.[0]?.content?.parts?.[0]?.text || '';
              resolve(text);
            } catch (err) {
              reject(new Error(`Failed to parse Gemini response: ${err.message}`));
            }
          } else {
            reject(new Error(`Gemini API returned error status ${response.statusCode}: ${responseBody}`));
          }
        });
      }
    );
    request.setTimeout(120000, () => {
      request.destroy(new Error('Gemini OCR request timeout after 120 seconds'));
    });
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

function callEnhancedGeminiOcr(imagePath) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !String(apiKey).trim()) {
    throw new Error('GEMINI_API_KEY is missing.');
  }

  const base64Data = fs.readFileSync(imagePath).toString('base64');
  const payload = {
    contents: [
      {
        parts: [
          {
            text: "Perform high-accuracy Enhanced OCR on this handwritten answer sheet image. Transcribe all text exactly as written, paying close attention to handwritten symbols, math notations, and messy penmanship. Retain the layout and structure."
          },
          {
            inlineData: {
              mimeType: "image/png",
              data: base64Data
            }
          }
        ]
      }
    ]
  };

  const body = JSON.stringify(payload);
  const GEMINI_HOST = 'generativelanguage.googleapis.com';
  const GEMINI_PATH = '/v1beta/models/gemini-2.5-flash:generateContent';

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        method: 'POST',
        hostname: GEMINI_HOST,
        path: GEMINI_PATH,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-goog-api-key': apiKey
        }
      },
      response => {
        let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', chunk => responseBody += chunk);
        response.on('end', () => {
          if (response.statusCode === 200) {
            try {
              const resObj = JSON.parse(responseBody);
              const text = resObj?.candidates?.[0]?.content?.parts?.[0]?.text || '';
              resolve(text);
            } catch (err) {
              reject(new Error(`Failed to parse Gemini response: ${err.message}`));
            }
          } else {
            reject(new Error(`Gemini API returned error status ${response.statusCode}: ${responseBody}`));
          }
        });
      }
    );
    request.setTimeout(120000, () => {
      request.destroy(new Error('Enhanced Gemini OCR request timeout after 120 seconds'));
    });
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

function saveDebugFiles(text, imagePath, label) {
  try {
    const debugDir = path.join(__dirname, '../temp');
    ensureDir(debugDir);
    
    // Save temp/ocr_output.txt
    const txtPath = path.join(debugDir, 'ocr_output.txt');
    fs.writeFileSync(txtPath, text, 'utf8');
    console.log(`[DEBUG] Saved intermediate text file to: ${txtPath}`);

    // Save temp/converted_page_1.png
    if (imagePath && fs.existsSync(imagePath)) {
      const pngPath = path.join(debugDir, 'converted_page_1.png');
      fs.copyFileSync(imagePath, pngPath);
      console.log(`[DEBUG] Saved intermediate image file to: ${pngPath}`);
    }
  } catch (err) {
    console.warn(`[DEBUG] Failed to save intermediate debug files:`, err.message);
  }
}
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
  const match = String(fileName || '').match(/-(\d+)\.(?:jpe?g|png)$/i);
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

  console.log(`[OCR][${label}] Converting PDF pages to PNG images...`, {
    source: path.basename(filePath),
    tempDir,
    binary: pdftoppm
  });

  const convertFn = async () => {
    return await execFileAsync(
      pdftoppm,
      ['-png', '-r', '150', filePath, outputPrefix],
      {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120000, // 120s timeout
        windowsHide: true
      }
    );
  };

  try {
    const { stdout, stderr } = await retryAsync(convertFn, 2, 1000, `${label} PDF-to-Image Conversion`);
    if (stdout && stdout.trim()) {
      console.log(`[OCR][${label}] pdftoppm stdout:`, stdout.trim());
    }
    if (stderr && stderr.trim()) {
      console.log(`[OCR][${label}] pdftoppm stderr:`, stderr.trim());
    }
  } catch (err) {
    console.error(`[OCR][${label}] PDF to image conversion failed after retries:`, {
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
    .filter(fileName => /\.png$/i.test(fileName))
    .map((fileName, index) => ({
      pageNumber: extractPageNumber(fileName, index),
      filePath: path.join(tempDir, fileName),
      fileName
    }))
    .sort((a, b) => a.pageNumber - b.pageNumber);

  if (imageFiles.length === 0) {
    cleanupTempDir(tempDir);
    throw new Error(`No PNG page images were generated for ${path.basename(filePath)}.`);
  }

  return { tempDir, imageFiles };
}

async function callGoogleVisionOcr(client, imagePath) {
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
  return { text, confidence };
}

async function ocrImagePage(client, imagePath, pageNumber, totalPages, label) {
  let text = '';
  let confidence = 0;
  let engineUsed = 'Google Vision';
  let success = false;
  let lastErrorMsg = '';

  // 1. Google Vision OCR
  try {
    console.log(`[OCR][${label}] Running Google Vision OCR on page ${pageNumber}/${totalPages}...`);
    const res = await retryAsync(
      () => callGoogleVisionOcr(client, imagePath),
      2,
      1000,
      `${label} Page ${pageNumber} Google Vision`
    );
    text = res.text;
    confidence = res.confidence;
    if (text) {
      success = true;
    }
  } catch (err) {
    lastErrorMsg = err.message;
    console.warn(`[OCR][${label}] Google Vision OCR failed on page ${pageNumber} after retries:`, err.message);
  }

  // 2. Gemini OCR
  if (!success) {
    engineUsed = 'Gemini OCR';
    try {
      console.log(`[OCR][${label}] Running Gemini OCR on page ${pageNumber}/${totalPages}...`);
      text = await retryAsync(
        () => callGeminiOcr(imagePath),
        2,
        1000,
        `${label} Page ${pageNumber} Gemini OCR`
      );
      confidence = 0.95;
      if (text) {
        success = true;
      }
    } catch (err) {
      lastErrorMsg = err.message;
      console.warn(`[OCR][${label}] Gemini OCR failed on page ${pageNumber} after retries:`, err.message);
    }
  }

  // 3. Enhanced OCR
  if (!success) {
    engineUsed = 'Enhanced OCR';
    try {
      console.log(`[OCR][${label}] Running Enhanced OCR on page ${pageNumber}/${totalPages}...`);
      text = await retryAsync(
        () => callEnhancedGeminiOcr(imagePath),
        2,
        1000,
        `${label} Page ${pageNumber} Enhanced OCR`
      );
      confidence = 0.95;
      if (text) {
        success = true;
      }
    } catch (err) {
      lastErrorMsg = err.message;
      console.error(`[OCR][${label}] Enhanced OCR failed on page ${pageNumber} after retries:`, err.message);
      return {
        pageNumber,
        text: '',
        confidence: 0,
        success: false,
        error: `All OCR methods in the chain failed on page ${pageNumber}. Last error: ${lastErrorMsg}`,
        engineUsed: 'none'
      };
    }
  }

  console.log(`[OCR][${label}] Page ${pageNumber}/${totalPages} success using ${engineUsed}:`, {
    chars: text.length,
    confidence
  });

  return {
    pageNumber,
    text,
    confidence,
    success: true,
    error: '',
    engineUsed
  };
}

async function extractDocumentOcr(filePath, { label = 'document' } = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`PDF file not found: ${filePath || '(missing path)'}`);
  }

  const stats = fs.statSync(filePath);
  const fileSize = stats.size;
  console.log(`[OCR][${label}] Processing PDF file:`, {
    name: path.basename(filePath),
    sizeBytes: fileSize
  });

  if (fileSize === 0) {
    throw new Error('Empty PDF');
  }

  // 1. Try direct PDF text extraction first using pdf-parse
  let directText = '';
  let pdfParsePageCount = 0;
  let parsedSuccessfully = false;

  try {
    const pdfParse = require('pdf-parse');
    const dataBuffer = fs.readFileSync(filePath);
    
    // Custom pagerender to track page count and separate text by page
    const pageTexts = [];
    const options = {
      pagerender: function(pageData) {
        return pageData.getTextContent().then(function(textContent) {
          let lastY, text = '';
          for (let item of textContent.items) {
            if (lastY == item.transform[5] || !lastY){
              text += item.str;
            } else {
              text += '\n' + item.str;
            }
            lastY = item.transform[5];
          }
          pageTexts.push(text);
          return text;
        });
      }
    };

    const parsedData = await pdfParse(dataBuffer, options);
    pdfParsePageCount = parsedData.numpages;
    directText = String(parsedData.text || '').trim();
    parsedSuccessfully = true;

    console.log(`[OCR][${label}] pdf-parse results:`, {
      pages: pdfParsePageCount,
      textLength: directText.length
    });
  } catch (err) {
    console.error(`[OCR][${label}] pdf-parse failed:`, err.message);
    const errMsg = String(err.message || '').toLowerCase();
    if (errMsg.includes('password') || errMsg.includes('decrypt') || errMsg.includes('encrypted')) {
      throw new Error('Password protected PDF');
    } else {
      throw new Error('Corrupted PDF');
    }
  }

  if (pdfParsePageCount === 0) {
    throw new Error('Empty PDF');
  }

  // If direct text extraction length > 200 characters, use it directly and skip OCR entirely
  if (parsedSuccessfully && directText.replace(/\s+/g, '').length > 200) {
    console.log(`[OCR][${label}] Direct text extraction has > 200 readable chars. Skipping OCR entirely.`);
    
    // Save intermediate debug files
    saveDebugFiles(directText, null, label);

    return {
      text: directText,
      rawText: directText,
      pageCount: pdfParsePageCount,
      confidence: 1.0,
      pages: [{ pageNumber: 1, text: directText, confidence: 1.0, success: true, engineUsed: 'pdf-parse' }]
    };
  }

  // 2. If direct text is empty/too short, fall back to PDF -> Image conversion + OCR
  console.log(`[OCR][${label}] Direct text too short or empty. Falling back to PDF -> Image conversion + OCR...`);

  const client = getClient();
  const { tempDir, imageFiles } = await convertPdfToImages(filePath, label);
  const imageCount = imageFiles.length;

  let pageResults = [];
  let rawText = '';
  let finalText = '';
  let confidence = 0;
  let ocrSucceeded = false;

  try {
    // Get image dimensions for the first page for logging
    if (imageFiles.length > 0) {
      const dimensions = getPngDimensions(imageFiles[0].filePath);
      console.log(`[OCR][${label}] Converted image dimensions (Page 1):`, dimensions);
    }

    pageResults = await Promise.all(
      imageFiles.map(page => ocrImagePage(client, page.filePath, page.pageNumber, imageCount, label))
    );

    pageResults.sort((a, b) => a.pageNumber - b.pageNumber);

    rawText = pageResults
      .map(page => page.text)
      .filter(Boolean)
      .join('\n\n')
      .trim();

    const cleanedText = cleanDocumentText(pageResults.map(page => page.text));
    finalText = cleanedText || rawText;

    const confidenceValues = pageResults
      .map(page => page.confidence)
      .filter(value => Number.isFinite(value) && value > 0);
    confidence = confidenceValues.length > 0
      ? Number((confidenceValues.reduce((acc, value) => acc + value, 0) / confidenceValues.length).toFixed(3))
      : 0;

    const successfulPages = pageResults.filter(page => page.success && page.text).length;
    const failedPages = pageResults.length - successfulPages;

    const enginesUsed = [...new Set(pageResults.map(p => p.engineUsed))].filter(Boolean).join(', ');

    console.log(`[OCR][${label}] OCR complete:`, {
      pages: pageResults.length,
      successfulPages,
      failedPages,
      chars: finalText.length,
      confidence,
      enginesUsed,
      imageCount
    });

    if (String(finalText || '').trim()) {
      ocrSucceeded = true;
    }
  } catch (err) {
    console.error(`[OCR][${label}] OCR conversion/processing failed:`, err.message);
  } finally {
    cleanupTempDir(tempDir);
  }

  // Determine final text output
  let resultText = '';
  if (ocrSucceeded) {
    resultText = String(finalText || '').trim();
    // Save intermediate debug files
    saveDebugFiles(resultText, imageFiles[0]?.filePath, label);

    return {
      text: resultText,
      rawText,
      pageCount: pageResults.length,
      confidence,
      pages: pageResults
    };
  } else {
    // OCR failed or returned empty text. Fall back to pdf-parse text if available
    if (parsedSuccessfully && directText && String(directText).trim()) {
      console.log(`[OCR][${label}] OCR returned no text. Falling back to direct PDF text (${directText.length} chars).`);
      resultText = String(directText).trim();
      // Save intermediate debug files
      saveDebugFiles(resultText, null, label);

      return {
        text: resultText,
        rawText: resultText,
        pageCount: pdfParsePageCount,
        confidence: 1.0,
        pages: [{ pageNumber: 1, text: resultText, confidence: 1.0, success: true, engineUsed: 'pdf-parse' }]
      };
    }

    // No text extracted from either method
    throw new Error(`OCR produced no readable text for ${label}.`);
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
