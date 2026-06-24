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

function getCompactIdentifier(q) {
  const str = String(q || '').trim();
  const match = str.match(/^(?:(?:Question|Q)\s*[\.\-]?\s*)?(\d+)(?:\s*[\.\-]?\s*\(?\s*([a-zA-Z])\s*\)?)?/i);
  if (match) {
    const num = match[1];
    const letter = match[2];
    if (letter) {
      return `Q${num}(${letter.toLowerCase()})`;
    }
    return `Q${num}`;
  }
  console.warn(`[Excel Export Warning] Cannot extract question identifier from: "${q}". Falling back to original text.`);
  return str;
}

/**
 * Generate an Excel report for a completed evaluation job.
 * Layout:
 * Name | Roll No | Q1 | Q2 | ... | Total
 */
async function generateExcel(job, outputDir) {
  const workbook = new ExcelJS.Workbook();
  const marksSheet = workbook.addWorksheet('Student Marks Summary');
  const feedbackSheet = workbook.addWorksheet('Student Evaluation Feedback');

  const normalizedKeys = new Set();
  for (const student of job.students) {
    if (!Array.isArray(student.answers)) continue;
    for (const answer of student.answers) {
      const qKey = String(answer?.question || '').trim();
      if (qKey) {
        normalizedKeys.add(getCompactIdentifier(qKey));
      }
    }
  }

  const sortedNormalizedQuestions = Array.from(normalizedKeys).sort((a, b) => {
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  });

  const marksColumns = [
    { header: 'Name', key: 'name', width: 28 },
    { header: 'Roll No', key: 'roll', width: 18 }
  ];

  for (const q of sortedNormalizedQuestions) {
    marksColumns.push({
      header: q,
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

  const feedbackColumns = [
    { header: 'Name', key: 'name', width: 28 },
    { header: 'Roll No', key: 'roll', width: 18 },
    { header: 'Reason for Deduction', key: 'deduction_reason', width: 45 },
    { header: 'Improvement Suggestions', key: 'improvement_feedback', width: 45 },
    { header: 'Strengths', key: 'strengths', width: 45 },
    { header: 'Missing Points', key: 'missing_points', width: 45 }
  ];

  marksSheet.columns = marksColumns;
  feedbackSheet.columns = feedbackColumns;

  const marksHeaderRow = marksSheet.getRow(1);
  marksHeaderRow.height = 22;
  marksHeaderRow.eachCell((cell, colNumber) => {
    const col = marksSheet.columns[colNumber - 1];
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

  const feedbackHeaderRow = feedbackSheet.getRow(1);
  feedbackHeaderRow.height = 22;
  feedbackHeaderRow.eachCell((cell, colNumber) => {
    const col = feedbackSheet.columns[colNumber - 1];
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

    for (const q of sortedNormalizedQuestions) {
      const answer = answers.find(item => {
        const rawQ = String(item.question || '').trim();
        return getCompactIdentifier(rawQ).toLowerCase() === q.toLowerCase();
      });
      rowData[`col_${q}`] = answer && Number.isFinite(answer.marks) ? answer.marks : '';
    }

    const marksRow = marksSheet.addRow(rowData);
    marksRow.eachCell((cell, colNumber) => {
      const col = marksSheet.columns[colNumber - 1];
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

    const feedbackRow = feedbackSheet.addRow(rowData);
    feedbackRow.eachCell((cell, colNumber) => {
      const col = feedbackSheet.columns[colNumber - 1];
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

  marksSheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: marksColumns.length }
  };
  marksSheet.views = [{ state: 'frozen', ySplit: 1 }];

  feedbackSheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: feedbackColumns.length }
  };
  feedbackSheet.views = [{ state: 'frozen', ySplit: 1 }];

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const filename = `eval_${job._id}_${Date.now()}.xlsx`;
  const outputPath = path.join(outputDir, filename);
  await workbook.xlsx.writeFile(outputPath);
  return outputPath;
}

module.exports = { generateExcel, columnLetter };
