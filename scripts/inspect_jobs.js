require('dotenv').config();
const mongoose = require('mongoose');
const EvalJob = require('../models/EvaluationJob');

const mongoUri = process.env.MONGO_URI;

mongoose.connect(mongoUri)
  .then(async () => {
    console.log('Connected to MongoDB.');

    const jobs = await EvalJob.find({}).sort({ createdAt: -1 });
    console.log(`Found ${jobs.length} total evaluation jobs in history.`);

    for (const job of jobs) {
      console.log(`==================================================`);
      console.log(`Job ID: ${job._id}`);
      console.log(`Mode: ${job.mode}`);
      console.log(`Status: ${job.status}`);
      console.log(`Question Paper Text (Length): ${job.questionPaperText ? job.questionPaperText.length : 0}`);
      console.log(`Question Paper (First 200 chars): ${String(job.questionPaperText || '').substring(0, 200).replace(/\n/g, ' ')}`);
      
      console.log(`Students:`);
      for (const student of job.students) {
        console.log(`  ------------------------------------------------`);
        console.log(`  Student Name: ${student.studentName}`);
        console.log(`  Original Name: ${student.originalName}`);
        console.log(`  Roll Number: ${student.rollNumber}`);
        console.log(`  Status: ${student.status}`);
        console.log(`  OCR Text (Length): ${student.ocrText ? student.ocrText.length : 0}`);
        console.log(`  OCR Confidence: ${student.ocrConfidence}`);
        console.log(`  Total Marks: ${student.totalMarks}`);
        console.log(`  Answers Count: ${student.answers ? student.answers.length : 0}`);
        console.log(`  Answers Breakdown:`);
        if (student.answers && student.answers.length > 0) {
          student.answers.forEach(ans => {
            console.log(`    - Q${ans.question}: Marks=${ans.marks}, Reason="${ans.deduction_reason || ''}"`);
          });
        } else {
          console.log(`    (No answers array content)`);
        }
        if (student.error) {
          console.log(`  Error: ${student.error}`);
        }
      }
    }

    mongoose.disconnect();
  })
  .catch(err => {
    console.error('Connection failed:', err);
  });
