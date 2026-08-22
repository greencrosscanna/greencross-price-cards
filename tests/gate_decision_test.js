#!/usr/bin/env node
/* ─── gateDecision_ + has_ — tests ────────────────────────────────────────────────────────────────
 *
 *   RUN:  node tests/gate_decision_test.js   (from the repo root; no deps, no network, no credentials)
 *
 * WHY THESE
 * gateDecision_ is the auth decision behind all nine writes, and write enforcement is LIVE. It has
 * three outcomes that are easy to collapse into two and must not be:
 *
 *   proceed          signed in, allowed
 *   read_only        signed in but view-only — NOT needsAuth. Bouncing this person to a sign-in
 *                    form is a dead end: they are already signed in and may read the app fine.
 *   needsAuth        not signed in at all
 *
 * has_ is the prototype-safe lookup. This app spent a session removing `MAP[value]` from its gates
 * after measuring inherited names passing a lookup check, so 'constructor' must not read as a known
 * action — on the router that dispatches writes.
 *
 * Loads the real apps-script/Code.gs with Apps Script globals stubbed. Cannot reach Apps Script:
 * .claspignore excludes tests/.
 */
'use strict';
const fs = require('fs');

const stubs = {
  SpreadsheetApp:{}, DriveApp:{}, UrlFetchApp:{}, HtmlService:{}, ContentService:{},
  CacheService:{ getScriptCache: () => ({ get: () => null, put(){}, remove(){} }) },
  MailApp:{}, GmailApp:{}, ScriptApp:{}, Session:{}, Logger:{log(){}},
  Utilities:{ getUuid: () => 'test-uuid', formatDate: () => '2026-08-22',
              computeDigest: () => [1,2,3], base64Encode: () => 'AAA', DigestAlgorithm:{SHA_256:'x'} },
  LockService:{ getScriptLock: () => ({ waitLock(){}, releaseLock(){} }) },
  PropertiesService:{ getScriptProperties: () => ({ getProperty: () => '', setProperty(){} }) },
};
const names = Object.keys(stubs);
let P;
try {
  P = new Function(...names, fs.readFileSync(__dirname + '/../apps-script/Code.gs','utf8') +
    '\n; return { gateDecision_, has_, countKeys_, WRITE_ACTIONS, READ_ACTIONS };')(...names.map(n=>stubs[n]));
} catch (e) {
  console.error('LOAD FAILED: Code.gs did not evaluate under stubs — ' + e.message);
  console.error('Add the missing global to `stubs`. Do not let this pass quietly.');
  process.exit(2);
}

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } };
const editor  = { ok:true, user:'sky',  role:'editor', canEdit:true  };
const viewer  = { ok:true, user:'ann',  role:'viewer', canEdit:false };
const nobody  = { ok:false };

console.log('\n1. enforcing — the three outcomes stay three');
{
  const a = P.gateDecision_(editor, true, true);
  ok(a.ok === true && a.user === 'sky', 'an editor proceeds on a write');

  const b = P.gateDecision_(viewer, true, true);
  ok(b.ok === false, 'a viewer is refused a write');
  ok(b.code === 'read_only', 'with code read_only');
  ok(!b.needsAuth, 'and NOT needsAuth — they are signed in; a sign-in form is a dead end for them');
  ok(b.readOnly === true && b.user === 'ann', 'the app stays usable and knows who they are');

  const c = P.gateDecision_(viewer, true, false);
  ok(c.ok === true, 'the same viewer PROCEEDS on a read');

  const d = P.gateDecision_(nobody, true, true);
  ok(d.ok === false, 'a signed-out user is refused');
  ok(d.needsAuth === true || d.code === 'auth_required', 'and IS sent to auth — the distinction that matters');
}

console.log('\n2. dark mode — validates and reports, never rejects');
{
  const a = P.gateDecision_(nobody, false, true);
  ok(a.ok === true, 'a signed-out user is ALLOWED through while dark');
  ok(a.unauthenticated === true, 'but flagged unauthenticated, so the counters stay honest');
  const b = P.gateDecision_(viewer, false, true);
  ok(b.ok === true && b.readOnly === true, 'a viewer is allowed through and flagged readOnly');
}

console.log('\n3. canEdit absent is not canEdit false');
{
  const noFlag = { ok:true, user:'x', role:'editor' };          // no canEdit at all
  ok(P.gateDecision_(noFlag, true, true).ok === true,
     'a missing canEdit does NOT deny — only an explicit false does');
  ok(P.gateDecision_({ ok:true, user:'x', role:'editor', canEdit:false }, true, true).ok === false,
     'an explicit canEdit:false denies');
}

console.log('\n4. degenerate auth objects do not throw or admit');
{
  ok(P.gateDecision_(null, true, true).ok === false, 'null auth refused');
  ok(P.gateDecision_(undefined, true, true).ok === false, 'undefined auth refused');
  ok(P.gateDecision_({}, true, true).ok === false, 'empty object refused');
  ok(P.gateDecision_(null, false, true).ok === true, 'and while dark, null is allowed but flagged');
}

console.log('\n5. has_ — an inherited name is not a known action');
{
  ok(P.has_(P.WRITE_ACTIONS, 'submitCards') === true, 'a real write is found');
  ok(P.has_(P.WRITE_ACTIONS, 'constructor') === false, '"constructor" is NOT a write action');
  ok(P.has_(P.WRITE_ACTIONS, '__proto__') === false, '"__proto__" is not either');
  ok(P.has_(P.WRITE_ACTIONS, 'toString') === false, 'nor "toString"');
  ok(P.has_(P.READ_ACTIONS, 'constructor') === false, 'and the same holds for the read router');
  ok(P.has_(P.WRITE_ACTIONS, 'nope') === false, 'an unknown name is simply absent');
  ok(P.countKeys_(P.WRITE_ACTIONS) === 9, 'nine writes are gated — the number authprobe reports');
}

console.log('\n6. reportBug is gated like every other write');
{
  // It shipped unauthenticated and the gate refused it on the first real call. That is the design:
  // no public-exception list, so a forgotten line ships UNREACHABLE rather than silently public.
  ok(P.has_(P.WRITE_ACTIONS, 'reportBug') === false,
     'reportBug is not in WRITE_ACTIONS — doPost gates every post regardless, no exception list');
  ok(P.gateDecision_(nobody, true, true).ok === false,
     'so a signed-out bug report is refused, not posted anonymously to the shared board');
}

console.log('\n──────────────────────────────');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
