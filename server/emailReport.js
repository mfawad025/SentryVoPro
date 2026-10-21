require('dotenv').config();
const nodemailer = require('nodemailer');
const { buildLeakExcelBuffer } = require('./excelReport');
const { GOOGLE_REMOVAL_TOOL_URL, GOOGLE_DMCA_FORM_URL, googleDelistUrl, getMajorPlatformReportLink, matchesAlias, leakActionUrl } = require('./constants');

function getMailer() {
  if (!process.env.SMTP_HOST || process.env.SMTP_HOST === 'smtp.yourprovider.com') return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

function statusBadge(status) {
  const colors = {
    found: '#0096F5',
    reported: '#5B8DEF',
    removed: '#22C3A6',
  };
  const labels = { found: 'Leak Found', reported: 'DMCA Sent', removed: 'Removed' };
  return `<span style="display:inline-block;padding:3px 10px;border-radius:20px;font-size:12px;font-family:sans-serif;background:${colors[status]}22;color:${colors[status]};">${labels[status]}</span>`;
}

// Leak URLs and names come from scraped pages, so escape them before they
// go into email HTML.
function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildReportHtml(user, newLeaks, summary) {
  const rows = newLeaks
    .map(
      (leak) => `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #F1EBE0;color:#2A2621;font-size:14px;">${esc(leak.matched_alias)}</td>
        <td style="padding:10px 0;border-bottom:1px solid #F1EBE0;">
          <a href="${esc(leak.url)}" style="color:#2A2621;font-size:13px;word-break:break-all;">${esc(leak.url)}</a>
        </td>
        <td style="padding:10px 0;border-bottom:1px solid #F1EBE0;">${statusBadge(leak.status)}</td>
      </tr>`
    )
    .join('');

  const noNewLeaksRow = `<tr><td colspan="3" style="padding:20px 0;color:#8C8275;font-size:14px;">No new leaks found today — nice and quiet.</td></tr>`;

  return `
  <div style="background:#FAF7F2;padding:32px;font-family:sans-serif;">
    <div style="max-width:560px;margin:0 auto;background:#FFFFFF;border-radius:14px;padding:32px;">
      <h2 style="color:#2A2621;font-family:sans-serif;margin:0 0 6px;">Your SentryVo Daily Report</h2>
      <p style="color:#8C8275;margin:0 0 24px;font-size:14px;">Hi ${esc(user.name)}, here's what happened in your case today.</p>

      <div style="display:flex;gap:10px;margin-bottom:26px;">
        <div style="flex:1;background:#FAF7F2;border-radius:10px;padding:14px;text-align:center;">
          <div style="color:#0096F5;font-size:22px;font-weight:700;">${summary.found || 0}</div>
          <div style="color:#8C8275;font-size:11px;text-transform:uppercase;">Found</div>
        </div>
        <div style="flex:1;background:#FAF7F2;border-radius:10px;padding:14px;text-align:center;">
          <div style="color:#5B8DEF;font-size:22px;font-weight:700;">${summary.reported || 0}</div>
          <div style="color:#8C8275;font-size:11px;text-transform:uppercase;">Reported</div>
        </div>
        <div style="flex:1;background:#FAF7F2;border-radius:10px;padding:14px;text-align:center;">
          <div style="color:#22C3A6;font-size:22px;font-weight:700;">${summary.removed || 0}</div>
          <div style="color:#8C8275;font-size:11px;text-transform:uppercase;">Removed</div>
        </div>
      </div>

      <h3 style="color:#2A2621;font-size:15px;margin-bottom:10px;">New today (${newLeaks.length})</h3>
      <table style="width:100%;border-collapse:collapse;">
        <tbody>${newLeaks.length ? rows : noNewLeaksRow}</tbody>
      </table>

      <p style="color:#6b6480;font-size:12px;margin-top:28px;">
        Automatic takedown notices are best-effort and may need manual follow-up for some hosts. Log in to your dashboard for full case history.
      </p>
    </div>
  </div>`;
}

async function sendDailyReportEmail(user, newLeaks, summary) {
  const mailer = getMailer();
  const html = buildReportHtml(user, newLeaks, summary);

  if (!mailer) {
    // Fail loudly: silently "succeeding" here made reports look sent (and
    // were marked as sent) when no email had gone out at all.
    throw new Error('SMTP is not configured (SMTP_HOST missing or still the placeholder) — no email was sent');
  }

  let attachments = [];
  try {
    const excelBuffer = await buildLeakExcelBuffer(user, newLeaks, summary);
    attachments = [
      {
        filename: `sentryvo-report-${new Date().toISOString().slice(0, 10)}.xlsx`,
        content: excelBuffer,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    ];
  } catch (err) {
    console.warn('Excel report generation failed, sending email without attachment:', err.message);
  }

  const info = await mailer.sendMail({
    from: process.env.REPORT_FROM_EMAIL,
    to: user.email,
    // Admin-added (Fiverr) clients: the admin gets a copy of every report,
    // so the link details are never missed if the client's inbox hides it.
    bcc: user.source === 'fiverr' ? (process.env.ADMIN_DIGEST_EMAIL || process.env.SMTP_USER || undefined) : undefined,
    subject: `SentryVo Daily Report — ${newLeaks.length} new item(s)`,
    html,
    attachments,
  });
  const result = {
    from: process.env.REPORT_FROM_EMAIL,
    to: user.email,
    bcc: user.source === 'fiverr' ? (process.env.ADMIN_DIGEST_EMAIL || process.env.SMTP_USER || null) : null,
    accepted: info.accepted,
    rejected: info.rejected,
    response: info.response,
  };
  console.log('Report email handed to SMTP:', JSON.stringify(result));
  return result;
}

/**
 * Sends a bare test email, independent of the scan/report pipeline —
 * exists purely so SMTP setup can be verified directly (via
 * POST /api/test-email in index.js) without needing an active subscriber
 * or waiting for the daily cron to fire.
 */
async function sendTestEmail(toAddress) {
  const mailer = getMailer();
  if (!mailer) {
    throw new Error('SMTP is not configured (SMTP_HOST is missing or still the placeholder value)');
  }

  await mailer.sendMail({
    from: process.env.REPORT_FROM_EMAIL,
    to: toAddress,
    subject: 'SentryVo — SMTP test email',
    text: 'If you are reading this, your SMTP configuration is working correctly.',
  });
}

async function sendPasswordResetEmail(toAddress, resetUrl) {
  const mailer = getMailer();
  if (!mailer) {
    throw new Error('SMTP is not configured (SMTP_HOST is missing or still the placeholder value)');
  }

  await mailer.sendMail({
    from: process.env.REPORT_FROM_EMAIL,
    to: toAddress,
    subject: 'Reset your SentryVo password',
    text: `We received a request to reset your SentryVo password. Click the link below to choose a new one — this link expires in 1 hour and can only be used once.\n\n${resetUrl}\n\nIf you didn't request this, you can safely ignore this email — your password won't be changed.`,
    html: `
      <div style="font-family:Arial,sans-serif; max-width:480px; margin:0 auto; color:#1a1a2e;">
        <h2 style="color:#0096F5;">Reset your SentryVo password</h2>
        <p>We received a request to reset your password. Click the button below to choose a new one — this link expires in <strong>1 hour</strong> and can only be used once.</p>
        <p style="margin:28px 0;">
          <a href="${resetUrl}" style="background:#0096F5; color:#fff; padding:12px 24px; border-radius:8px; text-decoration:none; font-weight:bold;">Reset Password</a>
        </p>
        <p style="font-size:.85rem; color:#666;">If you didn't request this, you can safely ignore this email — your password won't be changed.</p>
      </div>
    `,
  });
}

/**
 * Welcome email for a client the admin added directly (e.g. a Fiverr
 * client whose account was created on their behalf, not through the
 * normal self-serve checkout). Reuses the exact same reset-token mechanism
 * as sendPasswordResetEmail — the account is created with a random,
 * unusable password, and this email is the client's only way to actually
 * set one they know. Deliberately worded as a welcome, not a "reset,"
 * since nothing is actually being reset for them.
 */
async function sendWelcomeSetPasswordEmail(toAddress, resetUrl, creatorName) {
  const mailer = getMailer();
  if (!mailer) {
    throw new Error('SMTP is not configured (SMTP_HOST is missing or still the placeholder value)');
  }

  await mailer.sendMail({
    from: process.env.REPORT_FROM_EMAIL,
    to: toAddress,
    subject: 'Welcome to SentryVo — set up your account',
    text: `Hi ${creatorName},\n\nYour SentryVo account has been set up and is already active — daily scanning and takedown protection has started. Click the link below to set your password and log in:\n\n${resetUrl}\n\nThis link expires in 1 hour and can only be used once. If you have any questions, just reply to this email.`,
    html: `
      <div style="font-family:Arial,sans-serif; max-width:480px; margin:0 auto; color:#1a1a2e;">
        <h2 style="color:#0096F5;">Welcome to SentryVo</h2>
        <p>Hi ${esc(creatorName)},</p>
        <p>Your account has been set up and is already active — daily scanning and takedown protection has started. Click below to set your password and log in to your dashboard.</p>
        <p style="margin:28px 0;">
          <a href="${resetUrl}" style="background:#0096F5; color:#fff; padding:12px 24px; border-radius:8px; text-decoration:none; font-weight:bold;">Set Your Password</a>
        </p>
        <p style="font-size:.85rem; color:#666;">This link expires in 1 hour and can only be used once. If you have any questions, just reply to this email.</p>
      </div>
    `,
  });
}

/**
 * Builds and sends ONE consolidated email to the admin, aggregating every
 * "needs manual action" leak across ALL active subscribers — not per-client.
 * Grouped by creator, then split into the two categories that need
 * different actions:
 *   - Platforms: major-platform leaks, each with a direct link to that
 *     platform's own official reporting form
 *   - Google Images: generic-site image leaks worth also delisting from
 *     Google's own image search results
 * Only ever includes leaks that haven't been sent in a previous digest
 * (see admin_digest_sent_at in db.js) — the caller is responsible for
 * marking them sent after this succeeds, so nothing repeats daily forever.
 */
// Which list a leak goes in: big platforms are reported on the platform
// itself; everything else found through Google is reported to Google,
// split into web pages and images (Google Images and reverse image search).
function digestGroup(leak) {
  if (leak.status === 'manual_review') return 'platforms';
  if (leak.source === 'serper_image' || leak.source === 'serper_lens') return 'images';
  return 'web';
}

// Why the scanner kept this link, in plain words, so the admin can judge it
// at a glance.
function leakReason(leak) {
  const title = String(leak.title || '').replace(/^\[Verified match\] /, '');
  if (leak.fingerprint_distance !== null && leak.fingerprint_distance !== undefined) {
    return leak.source === 'serper_lens' ? 'Reverse image search: photo match' : 'Photo match with her original photos';
  }
  if (leak.source === 'search_expand') return "Listed with her name on the site's own search page";
  const alias = leak.matched_alias || '';
  const prefix = leak.source === 'serper_lens' ? 'Reverse image search: ' : leak.source === 'serper_image' ? 'Google Images: ' : '';
  if (alias && matchesAlias(alias, leak.url)) return `${prefix}"${alias}" is in the address`;
  if (title) return `${prefix}"${alias}" is in the page title: ${title.slice(0, 120)}`;
  return `${prefix}matched "${alias}"`;
}

function buildAdminDigestHtml(leaks) {
  const byCreator = {};
  for (const leak of leaks) {
    const key = leak.creator_email;
    if (!byCreator[key]) byCreator[key] = { name: leak.creator_name, email: leak.creator_email, web: [], images: [], platforms: [] };
    byCreator[key][digestGroup(leak)].push(leak);
  }

  const cell = 'padding:7px 10px; border-bottom:1px solid #eee; vertical-align:top;';
  const link = (href, label, color = '#D82F74') => `<a href="${esc(href)}" style="color:${color}; font-weight:bold; text-decoration:none;">${label}</a>`;
  // Report button, plus "Not a leak" (and "Approve" for big platforms) underneath.
  const action = (href, label, leak, approve = false) => `<td style="${cell} white-space:nowrap; text-align:right;">${href ? link(href, label) : '<span style="color:#888;">No known form</span>'}
        <br><span style="font-size:.78rem;">${approve ? `${link(leakActionUrl(leak.id, 'approve'), 'Approve', '#0B8F7C')} · ` : ''}${link(leakActionUrl(leak.id, 'dismiss'), 'Not a leak', '#888')}</span></td>`;
  const why = (leak) => `<br><span style="color:#888; font-size:.78rem;">Why: ${esc(leakReason(leak))}</span>`;
  const table = (title, note, rows) => rows ? `
        <p style="margin:18px 0 2px; font-weight:bold;">${title}</p>
        <p style="margin:0 0 6px; font-size:.8rem; color:#666;">${note}</p>
        <table style="width:100%; border-collapse:collapse; font-size:.85rem;">${rows}</table>` : '';

  const sections = Object.values(byCreator).map((creator) => {
    const webRows = creator.web.map((leak) => `
      <tr><td style="${cell} word-break:break-all;">${esc(googleDelistUrl(leak) || leak.url)}${why(leak)}</td>${action(GOOGLE_DMCA_FORM_URL, 'Report to Google', leak)}</tr>`).join('');

    // For Google Images the page is what gets delisted; the image file is
    // shown underneath because Google's form also accepts it.
    const imageRows = creator.images.map((leak) => {
      const page = googleDelistUrl(leak) || leak.url;
      const file = page !== leak.url ? `<br><span style="color:#888; font-size:.78rem;">Image: ${esc(leak.url)}</span>` : '';
      return `
      <tr><td style="${cell} word-break:break-all;">${esc(page)}${file}${why(leak)}</td>${action(GOOGLE_DMCA_FORM_URL, 'Report to Google', leak)}</tr>`;
    }).join('');

    const platformRows = creator.platforms.map((leak) => {
      const form = getMajorPlatformReportLink(leak.url);
      let host = '';
      try { host = new URL(leak.url).hostname.replace(/^www\./, ''); } catch { /* keep empty */ }
      const waiting = !leak.approved_at
        ? '<br><span style="color:#C77A12; font-size:.78rem; font-weight:bold;">Waiting for your approval: the client sees it only after you approve.</span>'
        : '';
      return `
      <tr><td style="${cell} word-break:break-all;">${esc(leak.url)}${why(leak)}${waiting}</td>${action(form, `Report on ${esc(host)}`, leak, !leak.approved_at)}</tr>`;
    }).join('');

    return `
      <h3 style="margin:30px 0 0; padding-top:14px; border-top:2px solid #1A1530;">${esc(creator.name)} <span style="font-weight:normal; color:#666; font-size:.85rem;">(${esc(creator.email)})</span></h3>
      ${table(`Web links (${creator.web.length})`, 'Pages found in Google Search. Report each to Google for removal from search results.', webRows)}
      ${table(`Google Images links (${creator.images.length})`, 'Pictures found in Google Images or by reverse image search. Report each to Google; in the form choose Google Image Search.', imageRows)}
      ${table(`Big platforms (${creator.platforms.length})`, 'Open each link first. If it really is her content, press Approve (the client then sees it) and report it on the platform with its copyright form. If not, press Not a leak.', platformRows)}
    `;
  }).join('');

  return `
    <div style="font-family:Arial,sans-serif; max-width:680px; margin:0 auto; color:#1A1530;">
      <h2 style="color:#D82F74; margin-bottom:4px;">SentryVo · Links to report today</h2>
      <p style="margin-top:0;">${leaks.length} link(s) across ${Object.keys(byCreator).length} creator(s).</p>
      <p style="font-size:.85rem; color:#555;">Each link has its report button beside it and the reason it was flagged under it. "Not a leak" removes a wrong link from the client's dashboard and future reports. The attached text file has the same Google links, grouped into web and image links, for copy and paste.</p>
      ${sections}
    </div>
  `;
}

async function sendAdminDigestEmail(leaks) {
  const mailer = getMailer();
  if (!mailer) {
    throw new Error('SMTP is not configured (SMTP_HOST is missing or still the placeholder value)');
  }
  const adminEmail = process.env.ADMIN_DIGEST_EMAIL || process.env.SMTP_USER;

  // Plain-text list of the Google links, grouped by creator and by web /
  // image, for pasting into Google's form.
  const lines = [];
  const byCreator = {};
  for (const leak of leaks) {
    const group = digestGroup(leak);
    if (group === 'platforms') continue;
    const url = googleDelistUrl(leak);
    if (!url) continue;
    const key = `${leak.creator_name} (${leak.creator_email})`;
    byCreator[key] = byCreator[key] || { web: new Set(), images: new Set() };
    byCreator[key][group].add(url);
  }
  for (const [creator, g] of Object.entries(byCreator)) {
    lines.push(`# ${creator}`);
    if (g.web.size) lines.push(`## Web links (${g.web.size})`, ...g.web);
    if (g.images.size) lines.push(`## Google Images links (${g.images.size})`, ...g.images);
    lines.push('');
  }

  await mailer.sendMail({
    from: process.env.REPORT_FROM_EMAIL,
    to: adminEmail,
    subject: `SentryVo — ${leaks.length} link(s) to report today`,
    html: buildAdminDigestHtml(leaks),
    attachments: lines.length
      ? [{ filename: `google-delist-links-${new Date().toISOString().slice(0, 10)}.txt`, content: lines.join('\n'), contentType: 'text/plain' }]
      : [],
  });
}

module.exports = {
  sendDailyReportEmail,
  buildReportHtml,
  sendTestEmail,
  sendPasswordResetEmail,
  sendAdminDigestEmail,
  buildAdminDigestHtml,
  leakReason,
  sendWelcomeSetPasswordEmail,
};
