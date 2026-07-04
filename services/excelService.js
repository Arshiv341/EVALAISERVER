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
 * Layout:
 * Name | Roll No | Q1 | Q2 | ... | Total
 */
async function generateExcel(job, outputDir) {
  const workbook = new ExcelJS.Workbook();

  // 1. Collect and sort question keys
  const questionKeys = new Set();
  for (const student of job.students) {
    if (!Array.isArray(student.answers)) continue;
    for (const answer of student.answers) {
      const qKey = String(answer?.question || '').trim();
      if (qKey) {
        questionKeys.add(qKey);
      }
    }
  }

  const sortedQuestions = Array.from(questionKeys).sort((a, b) => {
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  });

  // =========================================================================
  // WORKSHEET 1: Student Marks Summary
  // =========================================================================
  const wsMarks = workbook.addWorksheet('Student Marks Summary');

  const marksColumns = [
    { header: 'Name', key: 'name', width: 28 },
    { header: 'Roll No', key: 'roll', width: 18 }
  ];

  for (const q of sortedQuestions) {
    marksColumns.push({
      header: q.startsWith('Q') ? q : `Q${q}`,
      key: `col_${q}`,
      width: 10,
      style: { alignment: { horizontal: 'center' } }
    });
  }

  marksColumns.push({
    header: 'Total',
    key: 'total',
    width: 12,
    style: { alignment: { horizontal: 'center' } }
  });

  wsMarks.columns = marksColumns;

  const headerRowMarks = wsMarks.getRow(1);
  headerRowMarks.height = 22;
  headerRowMarks.eachCell((cell) => {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { theme: 1, tint: 0 },
      bgColor: { theme: 1, tint: 0 }
    };
    cell.font = { color: { argb: 'FFF8FAFC' }, bold: true };
    cell.border = {
      bottom: { style: 'thin', color: { argb: 'FF6366F1' } }
    };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });

  // =========================================================================
  // WORKSHEET 2: Student Evaluation Feedback
  // =========================================================================
  const wsFeedback = workbook.addWorksheet('Student Evaluation Feedback');

  const feedbackColumns = [
    { header: 'Name', key: 'name', width: 28 },
    { header: 'Roll No', key: 'roll', width: 18 },
    { header: 'Reason for Deduction', key: 'deduction_reason', width: 45 },
    { header: 'Improvement Suggestions', key: 'improvement_feedback', width: 45 },
    { header: 'Strengths', key: 'strengths', width: 45 },
    { header: 'Missing Points', key: 'missing_points', width: 45 }
  ];

  wsFeedback.columns = feedbackColumns;

  const headerRowFeedback = wsFeedback.getRow(1);
  headerRowFeedback.height = 22;
  headerRowFeedback.eachCell((cell, colNumber) => {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { theme: 1, tint: 0 },
      bgColor: { theme: 1, tint: 0 }
    };
    cell.font = { color: { argb: 'FFF8FAFC' }, bold: true };
    
    const isAiCol = colNumber > 2;
    cell.border = {
      bottom: { style: 'thin', color: { argb: isAiCol ? 'FFF472B6' : 'FF6366F1' } }
    };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });

  // =========================================================================
  // POPULATE DATA
  // =========================================================================
  for (const student of job.students) {
    const answers = Array.isArray(student.answers) ? student.answers : [];

    // --- Populate Worksheet 1 (Marks) ---
    const marksRowData = {
      name: student.studentName || student.originalName || 'Unknown',
      roll: student.rollNumber || 'Unknown',
      total: Number.isFinite(student.totalMarks) ? student.totalMarks : Number(student.totalMarks || 0)
    };

    for (const q of sortedQuestions) {
      const answer = answers.find(item => String(item.question || '').trim().toLowerCase() === q.toLowerCase());
      marksRowData[`col_${q}`] = answer && Number.isFinite(answer.marks) ? answer.marks : '';
    }

    const mRow = wsMarks.addRow(marksRowData);
    mRow.eachCell((cell, colNumber) => {
      const colKey = marksColumns[colNumber - 1]?.key || '';
      const alignment = { vertical: 'middle' };
      if (colKey.startsWith('col_') || colKey === 'total') {
        alignment.horizontal = 'center';
      } else {
        alignment.horizontal = 'left';
      }
      cell.alignment = alignment;

      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { theme: 0, tint: 0 },
        bgColor: { theme: 0, tint: 0 }
      };
    });

    // --- Populate Worksheet 2 (Feedback) ---
    const deduction_reason = answers
      .map(ans => ans.deduction_reason?.trim() ? `Q${ans.question}: ${ans.deduction_reason.trim()}` : '')
      .filter(Boolean)
      .join('\n');

    const improvement_feedback = answers
      .map(ans => ans.improvement_feedback?.trim() ? `Q${ans.question}: ${ans.improvement_feedback.trim()}` : '')
      .filter(Boolean)
      .join('\n');

    const strengths = answers
      .map(ans => ans.strengths?.trim() ? `Q${ans.question}: ${ans.strengths.trim()}` : '')
      .filter(Boolean)
      .join('\n');

    const missing_points = answers
      .map(ans => {
        const pts = Array.isArray(ans.missing_points) ? ans.missing_points : [];
        return pts.length > 0 ? `Q${ans.question}:\n${pts.map(p => `• ${p.trim()}`).join('\n')}` : '';
      })
      .filter(Boolean)
      .join('\n\n');

    const feedbackRowData = {
      name: student.studentName || student.originalName || 'Unknown',
      roll: student.rollNumber || 'Unknown',
      deduction_reason,
      improvement_feedback,
      strengths,
      missing_points
    };

    const fRow = wsFeedback.addRow(feedbackRowData);
    fRow.eachCell((cell, colNumber) => {
      const isAiCol = colNumber > 2;
      if (isAiCol) {
        cell.alignment = { wrapText: true, vertical: 'top', horizontal: 'left' };
      } else {
        cell.alignment = { vertical: 'middle', horizontal: 'left' };
      }

      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { theme: 0, tint: 0 },
        bgColor: { theme: 0, tint: 0 }
      };
    });
  }

  // =========================================================================
  // VIEW & FILTER CONFIGURATION
  // =========================================================================
  wsMarks.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: marksColumns.length }
  };
  wsMarks.views = [{ state: 'frozen', ySplit: 1 }];

  wsFeedback.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: feedbackColumns.length }
  };
  wsFeedback.views = [{ state: 'frozen', ySplit: 1 }];

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const filename = `eval_${job._id}_${Date.now()}.xlsx`;
  const outputPath = path.join(outputDir, filename);
  await workbook.xlsx.writeFile(outputPath);
  return outputPath;
}

module.exports = { generateExcel, columnLetter };
