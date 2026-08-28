/**
 * Tough Tech Weekly — Gmail intake.
 *
 * Polls the submissions inbox, keeps only mail from UCLA senders, pulls out the
 * link and the student's optional note, and appends a row to the "inbox" tab of
 * the submissions spreadsheet. Nothing is approved or edited; the site build
 * reads the sheet on a schedule.
 *
 * First run: setup() then installTrigger(). See SETUP.md in the site repo.
 */

const CONFIG = {
  TAB: 'inbox',
  ALLOWED_DOMAINS: ['anderson.ucla.edu', 'ucla.edu', 'g.ucla.edu'],
  PROCESSED_LABEL: 'ttw-processed',
  MAX_THREADS: 50,
  HEADERS: ['timestamp', 'name', 'url', 'title', 'note', 'tag', 'status', 'email'],
};

/**
 * Run this once. Creates the submissions spreadsheet with both tabs and
 * remembers its ID, so nothing has to be pasted in by hand.
 */
function setup() {
  const props = PropertiesService.getScriptProperties();
  const existing = props.getProperty('SHEET_ID');
  if (existing) {
    console.log('Already set up. Spreadsheet: https://docs.google.com/spreadsheets/d/' + existing);
    console.log('To start over with a fresh sheet, run resetSetup() first.');
    return;
  }

  const ss = SpreadsheetApp.create('Tough Tech Weekly submissions');

  const inbox = ss.getSheets()[0].setName(CONFIG.TAB);
  inbox.getRange(1, 1, 1, CONFIG.HEADERS.length).setValues([CONFIG.HEADERS]).setFontWeight('bold');
  inbox.setFrozenRows(1);
  inbox.setColumnWidth(3, 320);   // url
  inbox.setColumnWidth(5, 420);   // note

  // Public mirror: every column except H (email), which is never published.
  const queue = ss.insertSheet('queue');
  queue.getRange('A1').setFormula('={' + CONFIG.TAB + '!A:G}');

  props.setProperty('SHEET_ID', ss.getId());

  console.log('Created: ' + ss.getUrl());
  console.log('');
  console.log('Next:');
  console.log('  1. Run installTrigger() to start polling every 5 minutes.');
  console.log('  2. In the spreadsheet: File > Share > Publish to web >');
  console.log('     select the "queue" tab, choose CSV, Publish. Copy that URL');
  console.log('     into config.json as sheet_csv_url.');
}

/** Forget the current spreadsheet so setup() can make a new one. */
function resetSetup() {
  PropertiesService.getScriptProperties().deleteProperty('SHEET_ID');
  console.log('Cleared. Run setup() to create a fresh spreadsheet.');
}

function getSheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('No spreadsheet yet. Run setup() first.');
  const sheet = SpreadsheetApp.openById(id).getSheetByName(CONFIG.TAB);
  if (!sheet) throw new Error('Tab "' + CONFIG.TAB + '" not found in the spreadsheet.');
  return sheet;
}

function processInbox() {
  const sheet = getSheet_();

  let label = GmailApp.getUserLabelByName(CONFIG.PROCESSED_LABEL);
  if (!label) label = GmailApp.createLabel(CONFIG.PROCESSED_LABEL);

  const threads = GmailApp.search(
    'in:inbox -label:' + CONFIG.PROCESSED_LABEL + ' newer_than:30d', 0, CONFIG.MAX_THREADS);

  let added = 0;
  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (msg) {
      try {
        const row = parseMessage_(msg);
        if (row) { sheet.appendRow(row); added++; }
      } catch (err) {
        console.error('Failed on a message: ' + err);
      }
    });
    thread.addLabel(label);
    thread.moveToArchive();
  });

  if (threads.length) console.log(threads.length + ' threads processed, ' + added + ' rows added.');
}

function parseMessage_(msg) {
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
  const url = firstLink_(body);
  if (!url) {
    console.log('No link found in message from ' + addr);
    return null;
  }

  const note = extractNote_(body, url);
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
    addr,      // private; the "queue" tab omits this column
  ];
}

/** First real link in the body, skipping list-management and tracking URLs. */
function firstLink_(body) {
  const matches = body.match(/https?:\/\/[^\s<>()\[\]"']+/g) || [];
  for (let i = 0; i < matches.length; i++) {
    let u = matches[i].replace(/[.,;:)\]]+$/, '');
    // Unwrap Google redirect wrappers.
    const wrapped = u.match(/[?&](?:url|q)=(https?%3A%2F%2F[^&]+|https?:\/\/[^&]+)/);
    if (wrapped) u = decodeURIComponent(wrapped[1]);
    if (/unsubscribe|list-manage|\.gif|\.png|\.jpg/i.test(u)) continue;
    if (/^https?:\/\/(mail\.google\.com|accounts\.google\.com)/i.test(u)) continue;
    return u;
  }
  return null;
}

/**
 * The student's own words: whatever they typed above the forwarded content,
 * or above the first link if they just pasted one in.
 */
function extractNote_(body, url) {
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
    if (t.startsWith('>')) return false;                          // quoted text
    if (/^(sent from|get outlook|--\s*$)/i.test(t)) return false; // signatures
    if (/^https?:\/\//i.test(t)) return false;
    return true;
  });

  return lines.join(' ').replace(/\s+/g, ' ').trim().slice(0, 600);
}

/** Run once to poll every 5 minutes. */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processInbox') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('processInbox').timeBased().everyMinutes(5).create();
  console.log('Trigger installed: processInbox runs every 5 minutes.');
}
