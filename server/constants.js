// Google has no public API for third-party copyright removal requests —
// their tool is a web form. See the note in scanner.js for the full
// explanation. This lives in its own file so both scanner.js and
// excelReport.js can reference it without a circular require.
const GOOGLE_REMOVAL_TOOL_URL = 'https://reportcontent.google.com/forms/dmca_search';

// Major platforms have their own dedicated copyright/report forms — these
// are NOT automated (see the long comment in scanner.js for why), but each
// entry's URL gives the admin a direct link to the right form instead of
// having to go find it themselves.
const MAJOR_PLATFORM_REPORT_LINKS = {
  'youtube.com': 'https://www.youtube.com/copyright_complaint_form',
  'youtu.be': 'https://www.youtube.com/copyright_complaint_form',
  'ytimg.com': 'https://www.youtube.com/copyright_complaint_form',
  'googlevideo.com': 'https://www.youtube.com/copyright_complaint_form',
  'tiktok.com': 'https://www.tiktok.com/legal/report/copyright',
  'tiktokcdn.com': 'https://www.tiktok.com/legal/report/copyright',
  'tiktokv.com': 'https://www.tiktok.com/legal/report/copyright',
  'facebook.com': 'https://www.facebook.com/help/contact/634636770043106',
  'fb.com': 'https://www.facebook.com/help/contact/634636770043106',
  'fb.watch': 'https://www.facebook.com/help/contact/634636770043106',
  'fbcdn.net': 'https://www.facebook.com/help/contact/634636770043106',
  'instagram.com': 'https://help.instagram.com/contact/372592039493408',
  'instagr.am': 'https://help.instagram.com/contact/372592039493408',
  'cdninstagram.com': 'https://help.instagram.com/contact/372592039493408',
  'x.com': 'https://help.x.com/forms/dmca',
  'twitter.com': 'https://help.x.com/forms/dmca',
  // X/Twitter media + short-link domains (pbs.twimg.com for images,
  // video.twimg.com for videos, t.co for shortened links).
  'twimg.com': 'https://help.x.com/forms/dmca',
  't.co': 'https://help.x.com/forms/dmca',
  'reddit.com': 'https://www.reddit.com/report/copyright',
  // Reddit's media/short-link domains (i.redd.it, preview.redd.it, ...) —
  // images posted to Reddit live here, not on reddit.com, so without these
  // they were treated as ordinary sites and a notice went to Reddit's
  // hosting abuse address instead of using Reddit's own copyright form.
  'redd.it': 'https://www.reddit.com/report/copyright',
  'redditmedia.com': 'https://www.reddit.com/report/copyright',
  'redditstatic.com': 'https://www.reddit.com/report/copyright',
  'reddituploads.com': 'https://www.reddit.com/report/copyright',
  'pinterest.com': 'https://policy.pinterest.com/en/copyright-infringement-form',
  'pinimg.com': 'https://policy.pinterest.com/en/copyright-infringement-form',
  'tumblr.com': 'https://www.tumblr.com/dmca',
  'linkedin.com': 'https://www.linkedin.com/help/linkedin/ask/TSO-DMCA',
  'licdn.com': 'https://www.linkedin.com/help/linkedin/ask/TSO-DMCA',
  'snapchat.com': 'https://values.snap.com/en-US/report/copyright',
  'sc-cdn.net': 'https://values.snap.com/en-US/report/copyright',
  'threads.net': 'https://help.instagram.com/contact/372592039493408',
};

const MAJOR_PLATFORM_DOMAINS = Object.keys(MAJOR_PLATFORM_REPORT_LINKS);

// Checks whether a URL belongs to one of the major platforms above —
// matches the exact domain or any subdomain of it (e.g. m.youtube.com).
function isMajorPlatform(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return MAJOR_PLATFORM_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

// Returns the specific reporting form URL for a major-platform leak, or
// null if the URL isn't one of the platforms above.
function getMajorPlatformReportLink(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    const match = MAJOR_PLATFORM_DOMAINS.find((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
    return match ? MAJOR_PLATFORM_REPORT_LINKS[match] : null;
  } catch {
    return null;
  }
}

module.exports = {
  GOOGLE_REMOVAL_TOOL_URL,
  MAJOR_PLATFORM_DOMAINS,
  MAJOR_PLATFORM_REPORT_LINKS,
  isMajorPlatform,
  getMajorPlatformReportLink,
};
