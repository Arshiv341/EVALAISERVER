require('dotenv').config();
const mongoose = require('mongoose');
const EvalJob = require('../models/EvaluationJob');

const mongoUri = process.env.MONGO_URI;

mongoose.connect(mongoUri)
  .then(async () => {
    console.log('Connected to MongoDB.');

    const jobs = await EvalJob.find({
      $or: [
        { questionPaperText: /25CS101/i },
        { 'students.originalName': /25CS101/i }
      ]
    }).sort({ createdAt: -1 });

    console.log(`Found ${jobs.length} jobs matching 25CS101.`);

    for (const job of jobs) {
      console.log(`\n==================================================`);
      console.log(`Job ID: ${job._id}`);
      console.log(`Status: ${job.status}`);
      console.log(`Created At: ${job.createdAt}`);
      console.log(`Question Paper (First 150 chars): ${String(job.questionPaperText || '').substring(0, 150).replace(/\n/g, ' ')}`);
      
      console.log(`Students Status:`);
      job.students.forEach(s => {
        console.log(`  - Student Name: ${s.studentName || '(none)'}`);
        console.log(`    Original Name: ${s.originalName}`);
        console.log(`    Status: ${s.status}`);
        console.log(`    OCR Text Length: ${s.ocrText ? s.ocrText.length : 0}`);
        console.log(`    Total Marks: ${s.totalMarks}`);
        console.log(`    Error: ${s.error || 'None'}`);
        console.log(`    Answers Count: ${s.answers ? s.answers.length : 0}`);
      });
    }

    mongoose.disconnect();
  })
  .catch(err => {
    console.error('Connection failed:', err);
  });
