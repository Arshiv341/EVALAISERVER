const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');

function columnLetter(index) {
  let letter = '';
  while (index > 0) {
    const rem = (index - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    index = Math.floor((index - 1) / 26);
  }
  return letter;
}

/**
 * Generate an Excel report for a completed evaluation job.
 * Generates ONE workbook with exactly TWO worksheets:
 * 1. "Marks Summary": Name | Roll Number | Q1 | Q2 | ... | QN | Total Marks
 * 2. "Deduction Analysis": Name | Roll Number | Q1 Deduction Reason | Q2 Deduction Reason | ...
 */
async function generateExcel(job, outputDir) {
  const workbook = new ExcelJS.Workbook();
  const sheet1 = workbook.addWorksheet('Marks Summary');
  const sheet2 = workbook.addWorksheet('Deduction Analysis');

  // 1. Detect max question count dynamically from all students
  let maxQ = 0;
  for (const student of job.students) {
    if (!Array.isArray(student.answers)) continue;
    for (const answer of student.answers) {
      const questionNumber = Number(answer?.question);
      if (Number.isFinite(questionNumber) && questionNumber > maxQ) {
        maxQ = questionNumber;
      }
    }
  }
  if (maxQ === 0) maxQ = 1;

  // 2. Define Columns for Sheet 1 (Marks Summary)
  const s1Columns = [
    { header: 'Name', key: 'name', width: 28 },
    { header: 'Roll Number', key: 'roll', width: 18 }
  ];
  for (let q = 1; q <= maxQ; q += 1) {
    s1Columns.push({
      header: `Q${q}`,
      key: `q${q}`,
      width: 10,
      style: { alignment: { horizontal: 'center' } }
    });
  }
  s1Columns.push({
    header: 'Total Marks',
    key: 'total',
    width: 15,
    style: { alignment: { horizontal: 'center' } }
  });
  sheet1.columns = s1Columns;

  // 3. Define Columns for Sheet 2 (Deduction Analysis)
  const s2Columns = [
    { header: 'Name', key: 'name', width: 28 },
    { header: 'Roll Number', key: 'roll', width: 18 }
  ];
  for (let q = 1; q <= maxQ; q += 1) {
    s2Columns.push({
      header: `Q${q} Deduction Reason`,
      key: `q${q}_reason`,
      width: 40,
      style: { alignment: { wrapText: true, vertical: 'top', horizontal: 'left' } }
    });
  }
  sheet2.columns = s2Columns;

  // 4. Fill Data for both sheets
  let rowIndex = 2;
  for (const student of job.students) {
    const answers = Array.isArray(student.answers) ? student.answers : [];

    // Sheet 1 Row Construction
    const s1RowData = {
      name: student.studentName || student.originalName || 'Unknown',
      roll: student.rollNumber || 'Unknown'
    };
    for (let q = 1; q <= maxQ; q += 1) {
      const answer = answers.find(item => Number(item.question) === q);
      s1RowData[`q${q}`] = (answer && Number.isFinite(answer.marks)) ? answer.marks : 0;
    }

    // Formula calculation of total marks automatically
    const startColLetter = columnLetter(3); // Column C
    const endColLetter = columnLetter(2 + maxQ); // End of questions column
    s1RowData['total'] = { formula: `=SUM(${startColLetter}${rowIndex}:${endColLetter}${rowIndex})` };

    const row1 = sheet1.addRow(s1RowData);

    // Sheet 2 Row Construction
    const s2RowData = {
      name: student.studentName || student.originalName || 'Unknown',
      roll: student.rollNumber || 'Unknown'
    };
    for (let q = 1; q <= maxQ; q += 1) {
      const answer = answers.find(item => Number(item.question) === q);
      let deductionStr = 'No deduction';

      if (answer) {
        const parts = [];
        if (answer.deduction_reason && answer.deduction_reason.trim()) {
          parts.push(answer.deduction_reason.trim());
        }
        if (Array.isArray(answer.missing_points) && answer.missing_points.length > 0) {
          parts.push(`Missing: ${answer.missing_points.join(', ')}`);
        }
        if (answer.improvement_feedback && answer.improvement_feedback.trim()) {
          parts.push(`Feedback: ${answer.improvement_feedback.trim()}`);
        }

        if (parts.length > 0) {
          deductionStr = parts.join(' | ');
        }
      }
      s2RowData[`q${q}_reason`] = deductionStr;
    }
    const row2 = sheet2.addRow(s2RowData);

    // Style row 1 cells (alternate colors and alignment)
    row1.eachCell((cell, colNumber) => {
      const alignment = { vertical: 'middle' };
      if (colNumber <= 2) {
        alignment.horizontal = 'left';
      } else {
        alignment.horizontal = 'center';
      }
      cell.alignment = alignment;

      if (rowIndex % 2 === 0) {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FF0F0F1A' }
        };
      }
    });

    // Style row 2 cells (alternate colors and wrap text)
    row2.eachCell((cell, colNumber) => {
      cell.alignment = { wrapText: true, vertical: 'top', horizontal: 'left' };

      if (rowIndex % 2 === 0) {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FF0F0F1A' }
        };
      }
    });

    rowIndex += 1;
  }

  // 5. Apply header styling and freeze panes for both sheets
  const styleWorksheetHeader = (worksheet, isDarkPurple = true) => {
    const headerRow = worksheet.getRow(1);
    headerRow.height = 24;
    headerRow.eachCell((cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: isDarkPurple ? 'FF1E1B4B' : 'FF4F46E5' }
      };
      cell.font = { color: { argb: 'FFF8FAFC' }, bold: true };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });

    worksheet.views = [{ state: 'frozen', ySplit: 1 }];
    worksheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: worksheet.columns.length }
    };
  };

  styleWorksheetHeader(sheet1, true); // Dark Purple for Marks Summary
  styleWorksheetHeader(sheet2, false); // Indigo/Purple for Deduction Analysis

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const filename = `eval_${job._id}_${Date.now()}.xlsx`;
  const outputPath = path.join(outputDir, filename);
  await workbook.xlsx.writeFile(outputPath);
  return outputPath;
}

module.exports = { generateExcel, columnLetter };
