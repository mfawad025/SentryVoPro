require('dotenv').config();
const nodemailer = require('nodemailer');
const { buildLeakExcelBuffer } = require('./excelReport');
const { GOOGLE_REMOVAL_TOOL_URL, getMajorPlatformReportLink } = require('./constants');

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

function buildReportHtml(user, newLeaks, summary) {
  const rows = newLeaks
    .map(
      (leak) => `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #F1EBE0;color:#2A2621;font-size:14px;">${leak.matched_alias || ''}</td>
        <td style="padding:10px 0;border-bottom:1px solid #F1EBE0;">
          <a href="${leak.url}" style="color:#2A2621;font-size:13px;word-break:break-all;">${leak.url}</a>
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
      <p style="color:#8C8275;margin:0 0 24px;font-size:14px;">Hi ${user.name}, here's what happened in your case today.</p>

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
    console.log(`[email disabled — SMTP not configured] Would have emailed ${user.email}:`);
    console.log(`  New leaks: ${newLeaks.length}, summary:`, summary);
    return;
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

  await mailer.sendMail({
    from: process.env.REPORT_FROM_EMAIL,
    to: user.email,
    subject: `SentryVo Daily Report — ${newLeaks.length} new item(s)`,
    html,
    attachments,
  });
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
function buildAdminDigestHtml(leaks) {
  const byCreator = {};
  for (const leak of leaks) {
    const key = leak.creator_email;
    if (!byCreator[key]) byCreator[key] = { name: leak.creator_name, email: leak.creator_email, platforms: [], images: [] };
    if (leak.status === 'manual_review') {
      byCreator[key].platforms.push(leak);
    } else if (leak.source === 'serper_image') {
      byCreator[key].images.push(leak);
    }
  }

  const sections = Object.values(byCreator).map((creator) => {
    const platformRows = creator.platforms.map((leak) => `
      <tr>
        <td style="padding:6px 10px; border-bottom:1px solid #eee;">${leak.url}</td>
        <td style="padding:6px 10px; border-bottom:1px solid #eee;"><a href="${getMajorPlatformReportLink(leak.url) || '#'}">${getMajorPlatformReportLink(leak.url) ? 'Report here' : 'No known form'}</a></td>
      </tr>`).join('');

    const imageRows = creator.images.map((leak) => `
      <tr>
        <td style="padding:6px 10px; border-bottom:1px solid #eee;">${leak.url}</td>
        <td style="padding:6px 10px; border-bottom:1px solid #eee;"><a href="${GOOGLE_REMOVAL_TOOL_URL}">Submit to Google</a></td>
      </tr>`).join('');

    return `
      <h3 style="margin-top:28px;">${creator.name} (${creator.email})</h3>
      ${creator.platforms.length ? `
        <p style="margin:8px 0 4px; font-weight:bold;">Platforms (${creator.platforms.length})</p>
        <table style="width:100%; border-collapse:collapse; font-size:.85rem;">${platformRows}</table>
      ` : ''}
      ${creator.images.length ? `
        <p style="margin:16px 0 4px; font-weight:bold;">Google Images (${creator.images.length})</p>
        <table style="width:100%; border-collapse:collapse; font-size:.85rem;">${imageRows}</table>
      ` : ''}
    `;
  }).join('');

  return `
    <div style="font-family:Arial,sans-serif; max-width:640px; margin:0 auto; color:#1a1a2e;">
      <h2 style="color:#0096F5;">SentryVo — Admin Manual Review Digest</h2>
      <p>${leaks.length} item(s) across ${Object.keys(byCreator).length} creator(s) need manual reporting today.</p>
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

  await mailer.sendMail({
    from: process.env.REPORT_FROM_EMAIL,
    to: adminEmail,
    subject: `SentryVo — ${leaks.length} item(s) need manual reporting today`,
    html: buildAdminDigestHtml(leaks),
  });
}

module.exports = {
  sendDailyReportEmail,
  buildReportHtml,
  sendTestEmail,
  sendPasswordResetEmail,
  sendAdminDigestEmail,
};
