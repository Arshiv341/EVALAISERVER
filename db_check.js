require('dotenv').config();
const mongoose = require('mongoose');
const EvalJob = require('./models/EvaluationJob');

const mongoUri = process.env.MONGO_URI;

mongoose.connect(mongoUri)
  .then(async () => {
    console.log('Connected to MongoDB.');

    const bulkJobs = await EvalJob.find({ totalStudents: { $gt: 1 } }).sort({ createdAt: -1 }).limit(10);
    console.log(`\nFound ${bulkJobs.length} bulk evaluation jobs in history:\n`);

    for (const job of bulkJobs) {
      console.log(`Job ID: ${job._id}`);
      console.log(`Faculty ID: ${job.facultyId}`);
      console.log(`Status: ${job.status}`);
      console.log(`Error Message: ${job.errorMessage || 'None'}`);
      console.log(`Total Students: ${job.totalStudents}`);
      console.log(`Completed Students: ${job.completedStudents}`);
      console.log(`Excel Path: ${job.excelPath || 'None'}`);
      console.log(`Created At: ${job.createdAt}`);
      console.log(`Students Status Breakdown:`);

      const statusCounts = {};
      job.students.forEach(s => {
        statusCounts[s.status] = (statusCounts[s.status] || 0) + 1;
        if (s.error) {
          console.log(`  - Student ${s.originalName || s._id} error: ${s.error}`);
        }
      });
      console.log(JSON.stringify(statusCounts, null, 2));
      console.log('--------------------------------------------------\n');
    }

    mongoose.disconnect();
  })
  .catch(err => {
    console.error('Connection failed:', err);
  });
