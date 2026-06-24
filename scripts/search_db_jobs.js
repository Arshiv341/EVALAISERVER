require('dotenv').config();
const mongoose = require('mongoose');
const EvalJob = require('../models/EvaluationJob');

const mongoUri = process.env.MONGO_URI;

mongoose.connect(mongoUri)
  .then(async () => {
    console.log('Connected to MongoDB.');

    // Search for students with totalMarks 0 or containing college keywords
    const jobs = await EvalJob.find({
      $or: [
        { 'students.originalName': /25CS101|Programming_in_C|QuestionPaper/i },
        { 'students.totalMarks': 0 },
        { questionPaperText: /25CS101|Programming_in_C/i }
      ]
    }).sort({ createdAt: -1 });

    console.log(`Found ${jobs.length} jobs matching criteria.`);

    for (const job of jobs) {
      console.log(`\n==================================================`);
      console.log(`Job ID: ${job._id}`);
      console.log(`Status: ${job.status}`);
      console.log(`Created At: ${job.createdAt}`);
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
        console.log(`  Total Marks: ${student.totalMarks}`);
        console.log(`  Error: ${student.error || 'None'}`);
        if (student.answers && student.answers.length > 0) {
          console.log(`  Answers Breakdown (First 3):`);
          student.answers.slice(0, 3).forEach(ans => {
            console.log(`    - Q${ans.question}: Marks=${ans.marks}, Reason="${ans.deduction_reason || ''}"`);
          });
        }
      }
    }

    mongoose.disconnect();
  })
  .catch(err => {
    console.error('Connection failed:', err);
  });
