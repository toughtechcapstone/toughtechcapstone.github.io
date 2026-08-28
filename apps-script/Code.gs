/**
 * Tough Tech Weekly — Gmail intake.
 *
 * Polls the submissions inbox, keeps only mail from UCLA senders, pulls out the
 * link and the student's optional note, and appends a row to the "inbox" tab of
 * the submissions sheet. Nothing is approved or edited; the site build reads the
 * sheet on a schedule.
 *
 * Setup: see SETUP.md in the site repo.
 */

const CONFIG = {
  SHEET_ID: 'PASTE_SPREADSHEET_ID_HERE',
  TAB: 'inbox',
  ALLOWED_DOMAINS: ['anderson.ucla.edu', 'ucla.edu', 'g.ucla.edu'],
  PROCESSED_LABEL: 'ttw-processed',
  MAX_THREADS: 50,
};

function processInbox() {
  const sheet = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName(CONFIG.TAB);
  if (!sheet) throw new Error('Tab "' + CONFIG.TAB + '" not found');

  let label = GmailApp.getUserLabelByName(CONFIG.PROCESSED_LABEL);
  if (!label) label = GmailApp.createLabel(CONFIG.PROCESSED_LABEL);

  const threads = GmailApp.search(
    'in:inbox -label:' + CONFIG.PROCESSED_LABEL + ' newer_than:30d', 0, CONFIG.MAX_THREADS);

  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (msg) {
      try {
        const row = parseMessage(msg);
        if (row) sheet.appendRow(row);
      } catch (err) {
        console.error('Failed on message: ' + err);
      }
    });
    thread.addLabel(label);
    thread.moveToArchive();
  });
}

function parseMessage(msg) {
  const from = msg.getFrom();                       // e.g. "Jane Wu <jane@ucla.edu>"
  const addr = (from.match(/<([^>]+)>/) || [null, from])[1].trim().toLowerCase();
  const domain = addr.split('@')[1] || '';

  // The spam filter: UCLA senders only. Everything else is dropped silently.
  const allowed = CONFIG.ALLOWED_DOMAINS.some(function (d) {
    return domain === d || domain.endsWith('.' + d);
  });
  if (!allowed) {
    console.log('Dropped non-UCLA sender: ' + addr);
    return null;
  }

  // Sender authentication. A pass is expected for UCLA Workspace mail; if the
  // headers do not confirm it, still record the submission but hold it for review.
  let status = '';
  try {
    const raw = msg.getRawContent().slice(0, 8000).toLowerCase();
    if (!/dkim=pass|spf=pass/.test(raw)) status = 'held';
  } catch (e) {
    status = 'held';
  }

  const body = msg.getPlainBody() || '';
  const url = firstLink(body);
  if (!url) {
    console.log('No link found in message from ' + addr);
    return null;
  }

  const note = extractNote(body, url);
  const displayName = (from.split('<')[0] || '').replace(/["']/g, '').trim();
  const firstName = (displayName || addr.split('@')[0]).split(/[\s.]+/)[0];
  const tag = /\bsocal\b|\bel segundo\b|\blos angeles\b|\blocal\b/i.test(note) ? 'socal' : '';

  return [
    Utilities.formatDate(msg.getDate(), 'America/Los_Angeles', 'yyyy-MM-dd HH:mm:ss'),
    firstName,
    url,
    '',        // title — filled in by the site build
    note,
    tag,
    status,
    addr,      // private; never published (see SETUP.md on the "queue" tab)
  ];
}

/** First real link in the body, skipping list-management and tracking URLs. */
function firstLink(body) {
  const matches = body.match(/https?:\/\/[^\s<>()\[\]"']+/g) || [];
  for (let i = 0; i < matches.length; i++) {
    let u = matches[i].replace(/[.,;:)\]]+$/, '');
    // Unwrap Google redirect wrappers.
    const wrapped = u.match(/[?&](?:url|q)=(https?%3A%2F%2F[^&]+|https?:\/\/[^&]+)/);
    if (wrapped) u = decodeURIComponent(wrapped[1]);
    if (/unsubscribe|list-manage|mailchi\.mp\/.*unsub|\.gif|\.png|\.jpg/i.test(u)) continue;
    if (/^https?:\/\/(mail\.google\.com|accounts\.google\.com)/i.test(u)) continue;
    return u;
  }
  return null;
}

/**
 * The student's own words: whatever they typed above the forwarded content,
 * or above the first link if they just pasted one in.
 */
function extractNote(body, url) {
  const markers = [
    /-{2,}\s*Forwarded message\s*-{2,}/i,
    /^\s*Begin forwarded message:/im,
    /^\s*On .{5,80} wrote:\s*$/im,
    /^\s*From:\s.+$/im,
  ];
  let head = body;
  markers.forEach(function (m) {
    const hit = head.search(m);
    if (hit > -1) head = head.slice(0, hit);
  });

  const urlAt = head.indexOf(url);
  if (urlAt > -1) head = head.slice(0, urlAt);

  const lines = head.split('\n').filter(function (line) {
    const t = line.trim();
    if (!t) return false;
    if (t.startsWith('>')) return false;                       // quoted text
    if (/^(sent from|get outlook|--\s*$)/i.test(t)) return false;  // signatures
    if (/^https?:\/\//i.test(t)) return false;
    return true;
  });

  return lines.join(' ').replace(/\s+/g, ' ').trim().slice(0, 600);
}

/** Run once from the editor to poll every 5 minutes. */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processInbox') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('processInbox').timeBased().everyMinutes(5).create();
  console.log('Trigger installed: processInbox every 5 minutes.');
}
