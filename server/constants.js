// Google has no public API for third-party copyright removal requests —
// their tool is a web form. See the note in scanner.js for the full
// explanation. This lives in its own file so both scanner.js and
// excelReport.js can reference it without a circular require.
const GOOGLE_REMOVAL_TOOL_URL = 'https://reportcontent.google.com/forms/dmca_search';

module.exports = { GOOGLE_REMOVAL_TOOL_URL };
