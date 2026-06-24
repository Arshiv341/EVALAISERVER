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
  const worksheet = workbook.addWorksheet('Results');

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

  const columns = [
    { header: 'Name', key: 'name', width: 28 },
    { header: 'Roll No', key: 'roll', width: 18 }
  ];

  for (const q of sortedQuestions) {
    columns.push({
      header: q.startsWith('Q') ? q : `Q${q}`,
      key: `col_${q}`,
      width: 10,
      style: { alignment: { horizontal: 'center' } }
    });
  }

  columns.push({
    header: 'Total',
    key: 'total',
    width: 12,
    style: { alignment: { horizontal: 'center' } }
  });

  columns.push(
    { header: 'Reason for Deduction', key: 'deduction_reason', width: 45 },
    { header: 'Improvement Suggestions', key: 'improvement_feedback', width: 45 },
    { header: 'Strengths', key: 'strengths', width: 45 },
    { header: 'Missing Points', key: 'missing_points', width: 45 }
  );

  worksheet.columns = columns;

  const headerRow = worksheet.getRow(1);
  headerRow.height = 22;
  headerRow.eachCell((cell, colNumber) => {
    const col = worksheet.columns[colNumber - 1];
    const isAiCol = ['deduction_reason', 'improvement_feedback', 'strengths', 'missing_points'].includes(col?.key);
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: isAiCol ? 'FF4F46E5' : 'FF1E1B4B' }
    };
    cell.font = { color: { argb: 'FFF8FAFC' }, bold: true };
    cell.border = {
      bottom: { style: 'thin', color: { argb: isAiCol ? 'FFF472B6' : 'FF6366F1' } }
    };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });

  let rowIndex = 2;
  for (const student of job.students) {
    const answers = Array.isArray(student.answers) ? student.answers : [];
    
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

    const rowData = {
      name: student.studentName || student.originalName || 'Unknown',
      roll: student.rollNumber || 'Unknown',
      total: Number.isFinite(student.totalMarks) ? student.totalMarks : Number(student.totalMarks || 0),
      deduction_reason,
      improvement_feedback,
      strengths,
      missing_points
    };

    for (const q of sortedQuestions) {
      const answer = answers.find(item => String(item.question || '').trim().toLowerCase() === q.toLowerCase());
      rowData[`col_${q}`] = answer && Number.isFinite(answer.marks) ? answer.marks : '';
    }

    const row = worksheet.addRow(rowData);

    row.eachCell((cell, colNumber) => {
      const col = worksheet.columns[colNumber - 1];
      const isAiCol = ['deduction_reason', 'improvement_feedback', 'strengths', 'missing_points'].includes(col?.key);

      if (isAiCol) {
        cell.alignment = { wrapText: true, vertical: 'top', horizontal: 'left' };
      } else {
        const alignment = { vertical: 'middle' };
        if (col && (col.key.startsWith('q') || col.key === 'total')) {
          alignment.horizontal = 'center';
        } else {
          alignment.horizontal = 'left';
        }
        cell.alignment = alignment;
      }

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

  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: columns.length }
  };

  worksheet.views = [{ state: 'frozen', ySplit: 1 }];

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const filename = `eval_${job._id}_${Date.now()}.xlsx`;
  const outputPath = path.join(outputDir, filename);
  await workbook.xlsx.writeFile(outputPath);
  return outputPath;
}

module.exports = { generateExcel, columnLetter };
