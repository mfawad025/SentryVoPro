/**
 * Builds an .xlsx report of a subscriber's leaks — the "save in Excel"
 * feature. Attached to the periodic email report, and reusable for an
 * on-demand dashboard download later if you want to add that endpoint.
 */
const ExcelJS = require('exceljs');
const { GOOGLE_REMOVAL_TOOL_URL } = require('./constants');

async function buildLeakExcelBuffer(user, leaks, summary) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'SentryVo';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Leak Report');

  sheet.columns = [
    { header: 'Alias / Keyword', key: 'alias', width: 22 },
    { header: 'URL', key: 'url', width: 60 },
    { header: 'Source', key: 'source', width: 16 },
    { header: 'Hosting Provider', key: 'hosting', width: 26 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Found At', key: 'foundAt', width: 20 },
    { header: 'Reported At', key: 'reportedAt', width: 20 },
    { header: 'Removed At', key: 'removedAt', width: 20 },
    { header: 'Manual Google Removal', key: 'googleNote', width: 34 },
  ];
  sheet.getRow(1).font = { bold: true };

  leaks.forEach((leak) => {
    sheet.addRow({
      alias: leak.matched_alias || '',
      url: leak.url,
      source: leak.source || '',
      hosting: leak.hosting_provider || 'Unknown (RDAP had no data)',
      status: leak.status,
      foundAt: leak.found_at || '',
      reportedAt: leak.reported_at || '',
      removedAt: leak.removed_at || '',
      googleNote: leak.status !== 'removed' ? GOOGLE_REMOVAL_TOOL_URL : '',
    });
  });

  const summarySheet = workbook.addWorksheet('Summary');
  summarySheet.columns = [
    { header: 'Metric', key: 'metric', width: 24 },
    { header: 'Count', key: 'count', width: 12 },
  ];
  summarySheet.getRow(1).font = { bold: true };
  summarySheet.addRow({ metric: 'Total leaks tracked', count: summary.total || 0 });
  summarySheet.addRow({ metric: 'Found (awaiting action)', count: summary.found || 0 });
  summarySheet.addRow({ metric: 'Reported (notice sent)', count: summary.reported || 0 });
  summarySheet.addRow({ metric: 'Removed (confirmed)', count: summary.removed || 0 });
  summarySheet.addRow({ metric: '', count: '' });
  summarySheet.addRow({ metric: 'Report generated', count: new Date().toISOString() });
  summarySheet.addRow({ metric: 'Account', count: user.email });

  const noteRow = summarySheet.addRow({
    metric: 'Note on Google removals',
    count: `Google has no public API for third-party takedown requests — items marked "found" or "reported" include a manual submission link on the Leak Report tab.`,
  });
  noteRow.font = { italic: true };

  return workbook.xlsx.writeBuffer();
}

module.exports = { buildLeakExcelBuffer };
