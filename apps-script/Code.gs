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
  MAX_THREADS: 150,
  HEADERS: ['timestamp', 'name', 'url', 'title', 'note', 'tag', 'status'],
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

/** Message ids already handled. Tracked per message, not per thread. */
function seenIds_() {
  const raw = PropertiesService.getScriptProperties().getProperty('PROCESSED_IDS');
  try {
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function rememberIds_(ids) {
  const kept = ids.slice(-400);   // plenty of history, well inside the size limit
  PropertiesService.getScriptProperties().setProperty('PROCESSED_IDS', JSON.stringify(kept));
}

function processInbox() {
  // The 5-minute trigger and a manual run must never overlap, or both append
  // the same message and the sheet gets duplicate rows.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    console.log('Another run is in progress; skipping this one.');
    return;
  }
  try {
    processInboxLocked_();
  } finally {
    lock.releaseLock();
  }
}

function processInboxLocked_() {
  const sheet = getSheet_();

  let label = GmailApp.getUserLabelByName(CONFIG.PROCESSED_LABEL);
  if (!label) label = GmailApp.createLabel(CONFIG.PROCESSED_LABEL);

  // in:anywhere, not in:inbox, so nothing can get permanently stranded: a reply
  // into an already-archived thread, or a message Gmail filed as spam, is still
  // seen. Re-scanning costs nothing because dedupe is per message id.
  const threads = GmailApp.search('in:anywhere -in:trash newer_than:30d', 0, CONFIG.MAX_THREADS);

  // Links already in the sheet. A message whose link is already there repairs
  // that row's note when its own is fuller, rather than adding a duplicate.
  const existing = {};
  const last = sheet.getLastRow();
  if (last >= 2) {
    sheet.getRange(2, 3, last - 1, 3).getValues().forEach(function (v, i) {
      existing[String(v[0])] = { row: i + 2, note: String(v[2] || '') };
    });
  }

  const seen = seenIds_();
  const seenSet = {};
  seen.forEach(function (id) { seenSet[id] = true; });

  let added = 0, repaired = 0, skipped = 0, rescued = 0;
  threads.forEach(function (thread) {
    const wasSpam = thread.isInSpam();
    let tookSomething = false;
    thread.getMessages().forEach(function (msg) {
      const id = msg.getId();
      if (seenSet[id]) { skipped++; return; }
      try {
        const row = parseMessage_(msg);
        if (row) {
          // The address is split off here and never written to the published
          // spreadsheet. It goes to a separate private file instead.
          const email = row.pop();
          const prior = existing[row[2]];
          if (prior) {
            if (row[4].length > prior.note.length) {
              sheet.getRange(prior.row, 5).setValue(row[4]);
              prior.note = row[4];
              repaired++;
            }
          } else {
            sheet.appendRow(row);
            existing[row[2]] = { row: sheet.getLastRow(), note: row[4] };
            sendersSheet_().appendRow([row[0], row[2], email]);
            added++;
          }
          tookSomething = true;
        }
        seen.push(id);
        seenSet[id] = true;
      } catch (err) {
        console.error('Failed on a message: ' + err);
      }
    });
    // A real submission sitting in spam would be deleted by Gmail after 30 days.
    if (wasSpam && tookSomething) {
      thread.moveToInbox();
      rescued++;
      console.log('Rescued from spam: ' + thread.getFirstMessageSubject());
    }
    thread.addLabel(label);
    thread.moveToArchive();
  });

  rememberIds_(seen);
  console.log(threads.length + ' threads scanned: ' + added + ' new rows, ' +
              repaired + ' notes repaired, ' + rescued + ' rescued from spam, ' +
              skipped + ' already seen.');
}

/**
 * Sender addresses live in their own spreadsheet, which is never published.
 * Keeping them out of the submissions file means that however that file is
 * shared, no student address travels with it.
 */
function sendersSheet_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('SENDERS_SHEET_ID');
  if (id) {
    try {
      return SpreadsheetApp.openById(id).getSheetByName('senders');
    } catch (e) {
      id = null;   // deleted or unreachable; make a fresh one below
    }
  }
  const ss = SpreadsheetApp.create('Tough Tech Weekly senders (PRIVATE, do not publish)');
  const sh = ss.getSheets()[0].setName('senders');
  sh.getRange(1, 1, 1, 3).setValues([['timestamp', 'url', 'email']]).setFontWeight('bold');
  sh.setFrozenRows(1);
  props.setProperty('SENDERS_SHEET_ID', ss.getId());
  console.log('Created the private senders sheet: ' + ss.getUrl());
  return sh;
}

/**
 * One-time cleanup. Moves every address already stored in the submissions
 * spreadsheet into the private senders sheet, then wipes the column, header
 * included, so the published CSV stops carrying student addresses.
 */
function scrubEmails() {
  const sheet = getSheet_();
  const last = sheet.getLastRow();
  if (last < 2) {
    console.log('No rows yet, nothing to scrub.');
    return;
  }

  // 1. Move any sender addresses in column H to the private file, then clear it.
  const width = Math.max(sheet.getLastColumn(), 8);
  const data = sheet.getRange(2, 1, last - 1, width).getValues();
  const moved = [];
  data.forEach(function (r) {
    if (r[7]) moved.push([r[0], r[2], r[7]]);
  });
  if (moved.length) {
    const senders = sendersSheet_();
    senders.getRange(senders.getLastRow() + 1, 1, moved.length, 3).setValues(moved);
  }
  sheet.getRange(2, 8, last - 1, 1).clearContent();
  sheet.getRange(1, 8).clearContent();

  // 2. Clean every published note: salutations, signatures, addresses, phone numbers.
  const noteRange = sheet.getRange(2, 5, last - 1, 1);
  const notes = noteRange.getValues();
  let cleaned = 0;
  const fixed = notes.map(function (r) {
    const before = String(r[0] || '');
    const after = cleanNote_(before);
    if (after !== before) cleaned++;
    return [after];
  });
  noteRange.setValues(fixed);

  console.log(moved.length + ' sender addresses moved to the private sheet and cleared here.');
  console.log(cleaned + ' notes cleaned of salutations, signatures and contact details.');
}

/**
 * The one button. Cleans the sheet, then re-reads the last 30 days of mail,
 * including spam, so stranded submissions come in and cut-off notes get repaired
 * in place. Safe to run more than once.
 */
function runAllFixes() {
  scrubEmails();
  reprocess();
  processInbox();
  console.log('');
  console.log('All done. The site rebuilds within 3 hours, or sooner if Claude triggers it.');
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
  const firstName = firstName_(from.split('<')[0] || '', addr);
  const tag = /\bsocal\b|\bel segundo\b|\blos angeles\b|\blocal\b/i.test(note) ? 'socal' : '';

  return [
    Utilities.formatDate(msg.getDate(), 'America/Los_Angeles', 'yyyy-MM-dd HH:mm:ss'),
    firstName,
    url,
    '',        // title — filled in by the site build
    note,
    tag,
    status,
    addr,      // popped off in processInbox; never written to this file
  ];
}

/**
 * First name only. UCLA directory display names arrive as "Wu, Jane", so a plain
 * split on whitespace would publish the surname.
 */
function firstName_(displayName, addr) {
  let n = (displayName || '').replace(/["']/g, '').trim();
  if (n.indexOf(',') > -1) {
    const after = n.split(',')[1];
    n = (after && after.trim()) ? after.trim() : n.split(',')[0];
  }
  if (!n) n = addr.split('@')[0];
  n = n.trim().split(/[\s.]+/)[0];
  n = n.replace(/[^A-Za-zÀ-ɏ'\-]/g, '');
  // Mail clients often send the display name shouting; "JACK" reads badly.
  if (n.length > 2 && n === n.toUpperCase()) {
    n = n.charAt(0) + n.slice(1).toLowerCase();
  }
  return n;
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
  // Everything the student wrote themselves, which is whatever sits above the
  // forwarded message. Links are stripped out of the prose rather than used as
  // a stopping point: people write "this article (https://...) shows that ...",
  // and cutting at the first link threw away the actual point.
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

  // Angle-bracketed and bare links come out; surrounding punctuation is tidied
  // below so "article (<link>) shows" does not leave stray brackets behind.
  head = head.replace(/<https?:\/\/[^>\s]+>/gi, ' ')
             .replace(/https?:\/\/[^\s<>()\[\]"']+/gi, ' ');

  const paragraphs = [];
  head.split(/\n\s*\n/).forEach(function (block) {
    const lines = block.split('\n').filter(function (line) {
      const t = line.trim();
      if (!t) return false;
      if (t.startsWith('>')) return false;                      // quoted text
      if (/^(sent from|get outlook|confidential)/i.test(t)) return false;
      if (/^--\s*$/.test(t)) return false;                      // signature marker
      if (/^[\d\s]*[.):\-•*]+\s*$/.test(t)) return false;       // "1:" left behind by a removed link
      return true;
    });
    let text = lines.join(' ').replace(/[ \t]+/g, ' ').trim();
    text = text.replace(/\(\s*\)|\[\s*\]|<\s*>/g, '')           // emptied brackets
               .replace(/\s+([,.;:!?])/g, '$1')
               .replace(/\s{2,}/g, ' ')
               .trim();
    if (text) paragraphs.push(text);
  });

  return cleanNote_(paragraphs.join('\n\n')).slice(0, 4000);
}

// --- notes: what a student typed, minus anything that should never be published.
// Shared by intake and scrubEmails(), so old rows get the same treatment as new
// ones. Mirrors tidy_note() in build.py; keep the two in step.
const SALUTE_ = /^\s*((?:hi|hello|hey|dear|professor|prof|good (?:morning|afternoon|evening))[^\n,]{0,30}),\s*/i;
const SIGNOFF_LINE_ = /^(very respectfully|v\/r|best regards|warm regards|warmest regards|kind regards|best wishes|all the best|many thanks|thank you|thanks so much|best|regards|thanks|cheers|sincerely|warmly|respectfully|gratefully)\b[\s,!.]*([A-Za-z][\w'’-]*\s*){0,3}[.!]?$/i;
const SIGNOFF_INLINE_ = /\b(very respectfully|best regards|warm regards|kind regards|best wishes|many thanks|thank you|best|regards|thanks|cheers|sincerely|warmly|respectfully)\s*[,!]/i;
const SEPARATOR_ = /^[\s•·*_=~.\-–—]+$/;
const SIG_CS_ = /\b(MBA|MD|JD|PhD)\b[\s\/A-Z]{0,8}Candidate\b|\bClass of 20\d\d\b/;
const SIG_CI_ = /\b(cell|mobile|phone|tel)\s*:|\b(she|he|they)\s*\/\s*(her|him|them)\b|\[cid:|\|\s*linkedin\b|\blinkedin\s*$/i;
const EMAIL_RE_ = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const PHONE_RE_ = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b|\+\d{1,3}(?:[\s.-]?\d{1,4}){3,5}/g;
const CID_RE_ = /\[cid:[^\]]*\]/gi;

function looksLikeSignature_(p) {
  return SIG_CS_.test(p) || SIG_CI_.test(p);
}

function nameLine_(p) {
  const words = p.split(/\s+/).filter(Boolean).length;
  return words > 0 && words <= 4 && !/[.!?]$|\d/.test(p);
}

/**
 * Strip the salutation, cut the signature block, and remove contact details.
 *
 * A signature starts at the first later paragraph that is a sign-off ("Best,
 * Gladys", "Very Respectfully,"), a separator ("• • •"), or looks like a
 * signature (a degree candidacy, "Class of 2027", a "Cell:" label, pronouns, an
 * inline image). Email addresses and phone numbers are removed wherever they
 * appear, as a backstop for any signature shape not caught above.
 */
function cleanNote_(note) {
  let n = String(note || '').replace(/\r/g, '');

  const m = n.match(SALUTE_);
  if (m && m[1].trim().split(/\s+/).length <= 3) n = n.slice(m[0].length);

  const paras = n.split(/\n\s*\n/)
                 .map(function (p) { return p.replace(/\s+/g, ' ').trim(); })
                 .filter(Boolean);
  let cut = paras.length;
  for (let i = 1; i < paras.length; i++) {
    const p = paras[i];
    const bare = p.replace(CID_RE_, '').replace(EMAIL_RE_, '').replace(PHONE_RE_, '')
                  .replace(/\s+/g, ' ').trim();
    if (SIGNOFF_LINE_.test(bare) || SEPARATOR_.test(p)) { cut = i; break; }
    if (looksLikeSignature_(p)) {
      const inner = p.search(SIGNOFF_INLINE_);
      if (inner > 0) {
        paras[i] = p.slice(0, inner).trim();
        cut = i + 1;
      } else {
        cut = (i >= 2 && nameLine_(paras[i - 1])) ? i - 1 : i;
      }
      break;
    }
  }
  if (cut === paras.length && paras.length && looksLikeSignature_(paras[0])) {
    const inner = paras[0].search(SIGNOFF_INLINE_);
    if (inner > 0) paras[0] = paras[0].slice(0, inner).trim();
  }

  const out = [];
  paras.slice(0, cut).forEach(function (p) {
    p = p.replace(CID_RE_, '').replace(EMAIL_RE_, '').replace(PHONE_RE_, '');
    p = p.replace(/\s+/g, ' ').trim();
    if (p) out.push(p);
  });
  n = out.join('\n\n');
  n = n.replace(/[\s(\[<]+$/, '').replace(/\s*\b\d+:\s*$/, '');
  return n.trim();
}

/**
 * Why didn't my test email show up? Run this and read the log.
 * It looks at recent mail whether or not it has already been processed, and
 * prints the verdict for each message without changing anything.
 */
function diagnose() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  console.log('SHEET_ID set: ' + (id ? 'yes' : 'NO -- run setup() first'));

  const trigs = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'processInbox';
  });
  console.log('processInbox triggers installed: ' + trigs.length +
              (trigs.length ? '' : '  <-- run installTrigger()'));
  console.log('Allowed sender domains: ' + CONFIG.ALLOWED_DOMAINS.join(', '));
  console.log('');

  // in:anywhere so Spam and Trash show up too; plain search hides them.
  const threads = GmailApp.search('newer_than:60d in:anywhere', 0, 60);
  console.log(threads.length + ' threads in the last 60 days (including spam, trash and archived).');
  if (!threads.length) {
    console.log('Nothing arrived at all. Check the message was sent to this exact address.');
    return;
  }

  const seenSet = {};
  seenIds_().forEach(function (id) { seenSet[id] = true; });

  threads.forEach(function (thread) {
    const labels = thread.getLabels().map(function (l) { return l.getName(); });
    thread.getMessages().forEach(function (msg) {
      const from = msg.getFrom();
      const addr = (from.match(/<([^>]+)>/) || [null, from])[1].trim().toLowerCase();
      const domain = addr.split('@')[1] || '';
      const allowed = CONFIG.ALLOWED_DOMAINS.some(function (d) {
        return domain === d || domain.endsWith('.' + d);
      });
      const url = firstLink_(msg.getPlainBody() || '');

      let verdict;
      if (seenSet[msg.getId()]) verdict = 'ALREADY PROCESSED - a row was added for this message';
      else if (!allowed) verdict = 'DROPPED - sender domain "' + domain + '" is not a UCLA domain';
      else if (!url) verdict = 'DROPPED - no link found in the message body';
      else verdict = 'OK - this would add a row on the next run';

      console.log('---');
      console.log('subject : ' + msg.getSubject());
      console.log('date    : ' + msg.getDate());
      console.log('from    : ' + addr);
      console.log('link    : ' + (url || '(none)'));
      console.log('labels  : ' + (labels.join(', ') || '(none)'));
      console.log('in spam : ' + thread.isInSpam());
      console.log('verdict : ' + verdict);
      if (allowed && url) console.log('note    : ' + (extractNote_(msg.getPlainBody() || '', url) || '(empty)'));
    });
  });

  console.log('');
  console.log('Messages listed as ALREADY PROCESSED are skipped by processInbox.');
  console.log('To make it look at everything again, run reprocess().');
}

/** Clear the processed label from recent mail so processInbox reconsiders it. */
function reprocess() {
  const label = GmailApp.getUserLabelByName(CONFIG.PROCESSED_LABEL);
  if (!label) {
    console.log('No ' + CONFIG.PROCESSED_LABEL + ' label exists yet; nothing to clear.');
    return;
  }
  const threads = label.getThreads(0, 50);
  threads.forEach(function (t) {
    t.removeLabel(label);
    t.moveToInbox();
  });
  PropertiesService.getScriptProperties().deleteProperty('PROCESSED_IDS');
  console.log(threads.length + ' threads moved back to the inbox and untagged.');
  console.log('Processed-message memory cleared too.');
  console.log('Run processInbox() to try them again. Duplicate links are collapsed');
  console.log('when the site builds, so re-adding an old one is harmless.');
}

/** Run once to poll every 5 minutes. */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processInbox') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('processInbox').timeBased().everyMinutes(5).create();
  console.log('Trigger installed: processInbox runs every 5 minutes.');
}
