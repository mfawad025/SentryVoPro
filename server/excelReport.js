/**
 * Builds an .xlsx report of a subscriber's leaks — the "save in Excel"
 * feature. Attached to the periodic email report, and reusable for an
 * on-demand dashboard download later if you want to add that endpoint.
 *
 * Split into separate tabs by what action each leak actually needs, since
 * "automated" and "needs a human to submit a form" are genuinely different
 * next steps for the admin:
 *   - "All Leaks Found" — the complete list, unfiltered
 *   - "Auto-Reported (Generic Sites)" — an automated takedown notice was
 *     actually emailed, either to a contact address published on the site
 *     itself or to the hosting provider found via RDAP
 *   - "Manual Review — Platforms" — major platforms (YouTube, TikTok,
 *     Facebook, X, Reddit, etc.) that require using their own official
 *     reporting form — automating this isn't feasible (see scanner.js for
 *     why), so this tab links directly to the right form for each one
 *   - "Manual Review — Google Images" — leaks found via image search, on
 *     non-major-platform sites, worth ALSO submitting to Google's own
 *     content-removal tool to delist from image search results (separate
 *     from whatever action was taken at the hosting level)
 */
const ExcelJS = require('exceljs');
const { GOOGLE_REMOVAL_TOOL_URL, isMajorPlatform, getMajorPlatformReportLink } = require('./constants');

function addLeaksSheet(workbook, title, leaks, extraColumns = []) {
  const sheet = workbook.addWorksheet(title);
  sheet.columns = [
    { header: 'Alias / Keyword', key: 'alias', width: 22 },
    { header: 'URL', key: 'url', width: 60 },
    { header: 'Source', key: 'source', width: 16 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Found At', key: 'foundAt', width: 20 },
    ...extraColumns,
  ];
  sheet.getRow(1).font = { bold: true };
  leaks.forEach((leak) => {
    const row = {
      alias: leak.matched_alias || '',
      url: leak.url,
      source: leak.source === 'serper_image' ? 'Google Images' : 'Web',
      status: leak.status,
      foundAt: leak.found_at || '',
    };
    sheet.addRow(row);
  });
  return sheet;
}

async function buildLeakExcelBuffer(user, leaks, summary) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'SentryVo';
  workbook.created = new Date();

  // ---- Tab 1: All Leaks Found (complete, unfiltered list) ----
  const allSheet = workbook.addWorksheet('All Leaks Found');
  allSheet.columns = [
    { header: 'Alias / Keyword', key: 'alias', width: 22 },
    { header: 'URL', key: 'url', width: 60 },
    { header: 'Source', key: 'source', width: 16 },
    { header: 'Hosting Provider', key: 'hosting', width: 26 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Found At', key: 'foundAt', width: 20 },
    { header: 'Reported At', key: 'reportedAt', width: 20 },
    { header: 'Removed At', key: 'removedAt', width: 20 },
  ];
  allSheet.getRow(1).font = { bold: true };
  leaks.forEach((leak) => {
    allSheet.addRow({
      alias: leak.matched_alias || '',
      url: leak.url,
      source: leak.source === 'serper_image' ? 'Google Images' : 'Web',
      hosting: leak.hosting_provider || 'Unknown (RDAP had no data)',
      status: leak.status,
      foundAt: leak.found_at || '',
      reportedAt: leak.reported_at || '',
      removedAt: leak.removed_at || '',
    });
  });

  // ---- Tab 2: Auto-Reported (Generic Sites) ----
  const autoReported = leaks.filter((l) => l.status === 'reported' || l.status === 'removed');
  addLeaksSheet(workbook, 'Auto-Reported (Generic Sites)', autoReported, [
    { header: 'Hosting Provider', key: 'hosting', width: 26 },
  ]).eachRow((row, rowNum) => {
    if (rowNum === 1) return;
    const leak = autoReported[rowNum - 2];
    row.getCell('hosting').value = leak.hosting_provider || 'Unknown (RDAP had no data)';
  });

  // ---- Tab 3: Manual Review — Platforms (major platforms, link to their own form) ----
  const platformLeaks = leaks.filter((l) => isMajorPlatform(l.url));
  const platformSheet = addLeaksSheet(workbook, 'Manual Review - Platforms', platformLeaks, [
    { header: 'Report Using This Form', key: 'reportLink', width: 50 },
  ]);
  platformSheet.eachRow((row, rowNum) => {
    if (rowNum === 1) return;
    const leak = platformLeaks[rowNum - 2];
    row.getCell('reportLink').value = getMajorPlatformReportLink(leak.url) || '(no known form for this domain)';
  });

  // ---- Tab 4: Manual Review — Google Images (non-major-platform image leaks) ----
  const imageLeaks = leaks.filter((l) => l.source === 'serper_image' && !isMajorPlatform(l.url));
  const imageSheet = addLeaksSheet(workbook, 'Manual Review - Google Images', imageLeaks, [
    { header: 'Submit Here to Delist', key: 'googleLink', width: 45 },
  ]);
  imageSheet.eachRow((row, rowNum) => {
    if (rowNum === 1) return;
    row.getCell('googleLink').value = GOOGLE_REMOVAL_TOOL_URL;
  });

  // ---- Summary tab ----
  const summarySheet = workbook.addWorksheet('Summary');
  summarySheet.columns = [
    { header: 'Metric', key: 'metric', width: 28 },
    { header: 'Count', key: 'count', width: 12 },
  ];
  summarySheet.getRow(1).font = { bold: true };
  summarySheet.addRow({ metric: 'Total leaks tracked', count: summary.total || 0 });
  summarySheet.addRow({ metric: 'Found (awaiting action)', count: summary.found || 0 });
  summarySheet.addRow({ metric: 'Auto-reported (notice sent)', count: summary.reported || 0 });
  summarySheet.addRow({ metric: 'Removed (confirmed)', count: summary.removed || 0 });
  summarySheet.addRow({ metric: 'Needs manual review — major platforms', count: platformLeaks.length });
  summarySheet.addRow({ metric: 'Needs manual review — Google Images', count: imageLeaks.length });
  summarySheet.addRow({ metric: '', count: '' });
  summarySheet.addRow({ metric: 'Report generated', count: new Date().toISOString() });
  summarySheet.addRow({ metric: 'Account', count: user.email });

  const noteRow = summarySheet.addRow({
    metric: 'Note on manual-review tabs',
    count: `Major platforms and Google Images require their own official forms — automating this isn't reliable or safe, so these tabs link directly to the right form for each leak instead.`,
  });
  noteRow.font = { italic: true };

  return workbook.xlsx.writeBuffer();
}

module.exports = { buildLeakExcelBuffer };
