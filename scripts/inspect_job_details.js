require('dotenv').config();
const mongoose = require('mongoose');
const EvalJob = require('../models/EvaluationJob');

const mongoUri = process.env.MONGO_URI;

mongoose.connect(mongoUri)
  .then(async () => {
    console.log('Connected to MongoDB.');

    const job = await EvalJob.findOne({ _id: '6a1ce1f878f68ec0a87864f8' });
    if (job) {
      console.log(`Job ID: ${job._id}`);
      console.log(`Question Paper Text:\n${job.questionPaperText}\n`);
      for (const student of job.students) {
        console.log(`Student Name: ${student.studentName}`);
        console.log(`Original Name: ${student.originalName}`);
        console.log(`OCR Text:\n${student.ocrText}\n`);
      }
    } else {
      console.log('Job not found.');
    }

    mongoose.disconnect();
  })
  .catch(err => {
    console.error('Connection failed:', err);
  });
