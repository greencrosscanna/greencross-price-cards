#!/usr/bin/env node
/* ─── reportBug_ fallback notices — tests ─────────────────────────────────────────────────────────
 *
 *   RUN:  node tests/bug_mail_fallback_test.js   (from the repo root; no deps, no network, no creds)
 *
 * WHY THESE
 * GX Core swallows its own mail failure on purpose: a report that reached the sheet has succeeded,
 * and mail must never be the thing that undoes it. The cost is a bug that FILES, whose email dies,
 * and which nobody is ever told about — the row sits on the board unread and nothing anywhere records
 * that a person reported a problem. Core v312 answers with `mailed` / `mail_error` / `mail_skipped`
 * so a caller can notice; noticing is this app's job.
 *
 * The four returns, three of which need us to act:
 *
 *   {ok:false, error}                      nothing filed        → tell someone, say re-file
 *   {ok:true, id, deduped:true}            already filed        → DO NOTHING
 *   {ok:true, id, mail_error|mail_skipped} filed, unannounced   → tell someone, say do NOT re-file
 *   {ok:true, id, mailed}                  filed and announced  → nothing
 *
 * THE TWO THAT ARE EASY TO GET BACKWARDS, and which most of these assertions are about:
 *
 *   A REFUSAL DOES NOT THROW. Core returns {ok:false} as a value. A fallback hung off the exception
 *   misses exactly the case it exists for.
 *
 *   A DEDUPED REPEAT CARRIES NO MAIL FIELD AT ALL — Core returns above its own send. So "no `mailed`"
 *   is only safe to read as failure because of that early return. Get it wrong and one /exec redirect
 *   chain, which re-executes a request, mails three times about a bug that filed perfectly — the
 *   duplicate-notification bug, recreated through the fix for it.
 *
 * Loads the real apps-script/Code.gs with Apps Script globals stubbed. Cannot reach Apps Script:
 * .claspignore excludes tests/.
 */
'use strict';
const fs = require('fs');

let sent = [];              // every MailApp.sendEmail
let cacheStore = {};        // the script cache, across calls within a case
let fetchImpl = () => { throw new Error('fetch not configured'); };

const stubs = {
  SpreadsheetApp:{}, DriveApp:{}, HtmlService:{}, ContentService:{}, ScriptApp:{}, Session:{},
  Logger:{log(){}}, GmailApp:{},
  UrlFetchApp:{ fetch: (...a) => fetchImpl(...a) },
  MailApp:{ sendEmail: (m) => { sent.push(m); } },
  CacheService:{ getScriptCache: () => ({
    get: (k) => (Object.prototype.hasOwnProperty.call(cacheStore, k) ? cacheStore[k] : null),
    put: (k, v) => { cacheStore[k] = v; },
    remove: (k) => { delete cacheStore[k]; },
  })},
  Utilities:{
    getUuid: () => 'test-uuid',
    formatDate: () => '9/9/26 10:00 PM',
    computeDigest: (_alg, str) => Array.from(String(str)).map(c => c.charCodeAt(0)),
    base64Encode: (b) => String(b),
    base64EncodeWebSafe: (b) => String(b),
    DigestAlgorithm:{ MD5:'md5', SHA_256:'sha256' },
    Charset:{ UTF_8:'utf8' },
  },
  LockService:{ getScriptLock: () => ({ waitLock(){}, releaseLock(){} }) },
  PropertiesService:{ getScriptProperties: () => ({ getProperty: () => 'test-secret', setProperty(){} }) },
};
const names = Object.keys(stubs);
let P;
try {
  P = new Function(...names, fs.readFileSync(__dirname + '/../apps-script/Code.gs','utf8') +
    '\n; return { reportBug_, pcBugMailOnce_, pcBugNotify_ };')(...names.map(n=>stubs[n]));
} catch (e) {
  console.error('LOAD FAILED: Code.gs did not evaluate under stubs — ' + e.message);
  process.exit(1);
}

let pass = 0, fail = 0;
function ok(cond, what) { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + what); } }
function eq(a, b, what) { ok(a === b, what + ' — got ' + JSON.stringify(a) + ', wanted ' + JSON.stringify(b)); }
function has(hay, needle, what) { ok(String(hay).indexOf(needle) >= 0, what + ' — missing: ' + needle); }

function reset() { sent = []; cacheStore = {}; }
/* Every assertion below reads a message through this rather than `sent[i]`. When an expectation about
   HOW MANY emails went out fails, the assertions after it are reading a message that was never sent —
   and a TypeError there buries the one line that actually explains the failure under a stack trace. */
function at(i) { return sent[i] || { subject: '(no email sent)', body: '(no email sent)', to: '' }; }
function respond(json, code) {
  fetchImpl = () => ({ getResponseCode: () => (code || 200), getContentText: () => JSON.stringify(json) });
}
const REPORT = { desc: 'the print preview is blank', title: 'Blank preview', reporter: 'tawny',
                 priority: 'high', appVer: '1.432',
                 context: JSON.stringify({ url: 'https://example/pricecards', ua: 'TestBrowser/1',
                                           errors: ['Uncaught TypeError: x is not a function'] }) };
function file(over) { return P.reportBug_(Object.assign({}, REPORT, over || {})); }

/* 1 ── filed and announced: the ordinary path sends NOTHING. The whole feature is worthless if it
       emails on success — that is just the duplicate-notification bug wearing a new hat. */
reset(); respond({ ok:true, id:'bug_1', mailed:'sky@greencrosscanna.com' });
let r = file();
eq(r.ok, true, 'happy path returns ok');
eq(r.id, 'bug_1', 'happy path returns the id');
eq(r.mailed, 'sky@greencrosscanna.com', 'happy path passes `mailed` back to the client');
eq(sent.length, 0, 'happy path sends no fallback email');

/* 2 ── DEDUPED: ok, an id, and NO mail field, because Core returned above its own send. This is the
       redirect-chain case; it must be silent. */
reset(); respond({ ok:true, id:'bug_1', deduped:true });
r = file();
eq(r.ok, true, 'deduped returns ok');
eq(r.deduped, true, 'deduped is passed back');
eq(sent.length, 0, 'DEDUPED REPEAT SENDS NOTHING — a missing `mailed` here is not a mail failure');

/* 3 ── filed but the send FAILED. */
reset(); respond({ ok:true, id:'bug_7', mail_error:'Service invoked too many times' });
r = file();
eq(r.ok, true, 'mail_error still reports the filing as a success — the row IS down');
eq(r.mail_error, 'Service invoked too many times', 'mail_error reaches the client');
eq(sent.length, 1, 'mail_error sends one notice');
has(at(0).subject, 'UNANNOUNCED', 'unannounced subject says so');
has(at(0).subject, 'high', 'subject carries the priority');
has(at(0).body, 'do NOT re-file', 'unannounced notice says do NOT re-file');
has(at(0).body, 'bug_7', 'unannounced notice carries the bug id to go and read');
has(at(0).body, 'Service invoked too many times', 'unannounced notice says why nobody was mailed');
has(at(0).body, 'failed', 'a mail_error reads as failed, not skipped');
eq(at(0).to, 'sky@greencrosscanna.com', 'notice goes to the watch address');

/* 4 ── filed but the send was SKIPPED. Reads as fine and is not: nobody was mailed, nothing failed. */
reset(); respond({ ok:true, id:'bug_8', mail_skipped:'no recipient — reporter has no email on file' });
r = file();
eq(sent.length, 1, 'mail_skipped sends one notice too');
has(at(0).subject, 'UNANNOUNCED', 'skipped is announced the same way');
has(at(0).body, 'skipped', 'a mail_skipped reads as skipped, not failed');
eq(r.mail_skipped, 'no recipient — reporter has no email on file', 'mail_skipped reaches the client');

/* 5 ── REFUSED, WITHOUT THROWING. The case the whole fallback exists for. */
reset(); respond({ ok:false, error:'title or detail required' });
r = file();
eq(r.ok, false, 'a refusal is reported as a failure, never flattened to success');
has(r.error, 'title or detail required', 'the refusal reason reaches the caller');
eq(sent.length, 1, 'a refusal sends the unfiled notice');
has(at(0).subject, 'UNFILED', 'unfiled subject says so');
has(at(0).body, 'NOT ON THE BUG BOARD', 'unfiled notice leads with the report being lost');
has(at(0).body, 'title or detail required', 'unfiled notice carries the reason');

/* 6 ── HTTP failure and 7 ── a thrown fetch: both unfiled, neither silent. */
reset(); respond({ ok:true, id:'x' }, 500);
r = file();
eq(r.ok, false, 'a non-2xx is a failure');
eq(sent.length, 1, 'a non-2xx sends the unfiled notice');
has(at(0).body, 'HTTP 500', 'unfiled notice names the HTTP status');

reset(); fetchImpl = () => { throw new Error('DNS exploded'); };
r = file();
eq(r.ok, false, 'a thrown fetch is a failure');
eq(sent.length, 1, 'a thrown fetch sends the unfiled notice');
has(at(0).body, 'DNS exploded', 'unfiled notice names the transport error');

/* 8 ── non-JSON, which is what an /exec redirect returning an HTML interstitial looks like. */
reset(); fetchImpl = () => ({ getResponseCode: () => 200, getContentText: () => '<html>nope</html>' });
r = file();
eq(r.ok, false, 'an HTML answer is a failure, not a success with no id');
eq(sent.length, 1, 'a non-JSON answer sends the unfiled notice');

/* 9 ── the guard ahead of all of it: no desc, no call, no mail. */
reset(); fetchImpl = () => { throw new Error('should not be reached'); };
r = P.reportBug_({ desc: '   ' });
eq(r.ok, false, 'an empty report is refused locally');
eq(sent.length, 0, 'an empty report mails nobody — nothing was attempted');

/* 10 ── ONE REPORT, ONE EMAIL PER KIND, inside the window. */
reset(); respond({ ok:true, id:'bug_9', mail_error:'boom' });
file(); file(); file();
eq(sent.length, 1, 'three identical unannounced reports send ONE email');

reset(); respond({ ok:false, error:'nope' });
file(); file();
eq(sent.length, 1, 'two identical unfiled reports send ONE email');

/* 11 ── …but the two KINDS do not collapse onto each other. They carry opposite instructions, and a
        shared key would drop whichever came second, leaving the wrong one standing. */
reset();
respond({ ok:false, error:'nope' });          file();
respond({ ok:true, id:'bug_9', mail_error:'boom' }); file();
eq(sent.length, 2, 'the same report unfiled THEN unannounced sends both notices');
has(at(0).subject, 'UNFILED', 'first is the unfiled one');
has(at(1).subject, 'UNANNOUNCED', 'second is the unannounced one');
ok(at(0).body.indexOf('do NOT re-file') < 0, 'the unfiled notice does not tell anyone to leave it alone');

/* 12 ── a DIFFERENT report is not the same report. */
reset(); respond({ ok:true, id:'bug_9', mail_error:'boom' });
file(); file({ title: 'A different thing entirely', desc: 'and different details' });
eq(sent.length, 2, 'two different reports send two emails');

/* 13 ── the diagnostics are the reason this app forwards `context` at all: they belong in the notice. */
reset(); respond({ ok:true, id:'bug_10', mail_error:'boom' });
file();
has(at(0).body, 'Uncaught TypeError: x is not a function', 'the caught JS error is in the notice');
has(at(0).body, 'Errors the page caught before submit (1)', 'the notice labels the error list and counts them');
has(at(0).body, 'https://example/pricecards', 'the page url is in the notice');
has(at(0).body, 'tawny', 'the reporter is in the notice');
has(at(0).body, '1.432', 'the app version is in the notice');
has(at(0).body, 'the print preview is blank', 'the report itself is in the notice');

/* 14 ── no errors captured is said plainly, not left as a blank heading. */
reset(); respond({ ok:true, id:'bug_11', mail_error:'boom' });
file({ context: JSON.stringify({ url:'https://example/pricecards' }) });
has(at(0).body, 'no JS errors', 'a clean page says so');

/* 15 ── malformed or absent context must not break the notice. Mail is the enhancement; the report
        is the thing, and a JSON.parse is not allowed to be what loses it. */
reset(); respond({ ok:true, id:'bug_12', mail_error:'boom' });
file({ context: 'not json at all{{{' });
eq(sent.length, 1, 'a malformed context still sends the notice');
reset(); respond({ ok:true, id:'bug_13', mail_error:'boom' });
file({ context: undefined });
eq(sent.length, 1, 'an absent context still sends the notice');

/* 16 ── a send that throws must not take the report down with it. */
reset(); respond({ ok:true, id:'bug_14', mail_error:'boom' });
const realMail = stubs.MailApp.sendEmail;
stubs.MailApp.sendEmail = () => { throw new Error('mail quota'); };
r = file();
eq(r.ok, true, 'a failing fallback email does not fail the report — it already filed');
stubs.MailApp.sendEmail = realMail;

/* 17 ── fails OPEN: a dead cache mails twice rather than going quiet. */
reset(); respond({ ok:true, id:'bug_15', mail_error:'boom' });
const realCache = stubs.CacheService.getScriptCache;
stubs.CacheService.getScriptCache = () => { throw new Error('cache down'); };
file(); file();
eq(sent.length, 2, 'a dead cache sends duplicates rather than swallowing the notice');
stubs.CacheService.getScriptCache = realCache;

console.log(fail === 0
  ? `  ${pass} passed, 0 failed`
  : `  ${pass} passed, ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
