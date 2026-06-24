require('dotenv').config();
const mongoose = require('mongoose');
const EvalJob = require('../models/EvaluationJob');

const mongoUri = process.env.MONGO_URI;

mongoose.connect(mongoUri)
  .then(async () => {
    console.log('Connected to MongoDB.');

    const job = await EvalJob.findOne({ _id: '6a1d5aa56639cf1d534a61d7' });
    if (job) {
      console.log(`Job ID: ${job._id}`);
      console.log(`Question Paper Text (Length: ${job.questionPaperText.length}):`);
      console.log(`--------------------------------------------------`);
      console.log(job.questionPaperText);
      console.log(`--------------------------------------------------\n`);

      for (const student of job.students) {
        console.log(`Student Name: ${student.studentName}`);
        console.log(`Original Name: ${student.originalName}`);
        console.log(`Status: ${student.status}`);
        console.log(`OCR Text (Length: ${student.ocrText.length}):`);
        console.log(`--------------------------------------------------`);
        console.log(student.ocrText);
        console.log(`--------------------------------------------------\n`);
      }
    } else {
      console.log('Job not found.');
    }

    mongoose.disconnect();
  })
  .catch(err => {
    console.error('Connection failed:', err);
  });
