require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { extractTextFromPDF } = require('../services/ocrService');

const uploadsDir = path.join(__dirname, '../uploads');

async function main() {
  const files = fs.readdirSync(uploadsDir).filter(f => f.endsWith('.pdf'));
  console.log(`Found ${files.length} PDFs in uploads folder:`, files);

  for (const file of files) {
    const filePath = path.join(uploadsDir, file);
    console.log(`\n==================================================`);
    console.log(`Processing: ${file}`);
    try {
      const result = await extractTextFromPDF(filePath);
      console.log(`Success:`);
      console.log(`  Student Name: ${result.studentName}`);
      console.log(`  Roll Number: ${result.rollNumber}`);
      console.log(`  Confidence: ${result.confidence}`);
      console.log(`  Page Count: ${result.pageCount}`);
      console.log(`  Answers Text Length: ${result.answersText ? result.answersText.length : 0}`);
      console.log(`  Snippet (First 300 chars):`);
      console.log(String(result.answersText || '').substring(0, 300));
    } catch (err) {
      console.error(`Failed to process ${file}:`, err.message);
    }
  }
}

main();
