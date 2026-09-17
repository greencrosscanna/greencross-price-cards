#!/usr/bin/env node
/* ─── the scrub on the way out actually redacts — RUN it, don't read it ───────────────────────────
 *   RUN:  node tests/mail_scrub_test.js
 *
 * WHY THIS EXISTS ALONGSIDE tests/exit_scrub_test.js. That one is shared, it reads source text, and
 * it says so in its own header: it cannot prove the scrub is applied to the right argument, or that
 * the regex behind it is correct. Crew's regex was anchored and walked past `connector_secret=` for
 * weeks while passing every check of that kind. So the shared test answers "is there an exit nobody
 * looked at", and this one answers the different question it explicitly declines: "does the thing at
 * that exit work". A repo with only the first has a green gate over an untested scrub.
 *
 * It loads the real apps-script/Code.gs into a sandbox with the Apps Script globals stubbed, calls
 * the real pcBugNotify_ and the real sendQueueDigest, and inspects what MailApp was handed. Nothing
 * here re-implements the scrub; a copy of the regex in a test proves only that the copy works.
 *
 * THE FIELDS IT PUSHES A SECRET THROUGH are the five that reach a body from somewhere this engine
 * does not control -- three from the browser (page url, user agent, captured JS errors) and two from
 * GX Core (its refusal text, its mail_error). The browser three were printed raw until 2026-09-17
 * while the server's own failure line one field away was already scrubbed.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } };

/* A FIXTURE, never a real credential -- it is the string the assertions hunt for in what MailApp and
   UrlFetchApp were handed, so it has to LOOK like a deploy secret to be worth hunting for. That shape
   is also what gx-preflight's credential-literal check exists to stop reaching a tracked file, and it
   flagged this line on the first push attempt -- correctly, on shape alone, which is the only thing a
   scanner can judge. `@notasecret` is that check's own sanctioned marker (gx-preflight.sh:163) and is
   the right answer here; `git push --no-verify` would have been the wrong one, most of all on a commit
   whose entire subject is credentials not leaving. If this value is ever the real secret, the test
   passes while proving nothing. */
const SECRET = 'S3CR3T-deploy-value-do-not-leak';   // @notasecret

/* A fresh engine per case, so one case's stubbed state cannot color the next. `sent` collects every
   message MailApp is handed -- the assertion is about what ARRIVES there, not about what any
   intermediate string looked like. */
function loadEngine() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  const sent = [];
  const props = {};
  const sandbox = {
    MailApp: { sendEmail: (m) => sent.push(m) },
    Utilities: {
      formatDate: () => '9/17/26 6:00 PM',
      getUuid: () => 'uuid',
      base64EncodeWebSafe: () => 'b64',
      computeDigest: () => [1],
      DigestAlgorithm: { MD5: 'MD5' },
      Charset: { UTF_8: 'UTF_8' },
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = v; },
        deleteProperty: (k) => { delete props[k]; },
        getProperties: () => props,
        setProperties: (o) => { Object.keys(o).forEach(k => { props[k] = o[k]; }); },
      }),
    },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {} }) },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    SpreadsheetApp: {}, UrlFetchApp: {}, ScriptApp: {}, ContentService: {}, Session: {},
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'Code.gs' });
  return { sandbox, sent, props };
}

function textOf(msg) {
  return [msg.subject, msg.body, msg.htmlBody].filter(v => v != null).join('\n');
}

console.log('mail scrub — the secret does not reach MailApp\n');

/* ── 1. the bug notice, through every field that carries outside text ─────────────────────────── */
{
  const { sandbox, sent } = loadEngine();
  const ctx = {
    url: 'https://greencrosscanna.github.io/greencross-price-cards/?store=river-rd&secret=' + SECRET,
    ua: 'Mozilla/5.0 (probe ?token=' + SECRET + ')',
    errors: [
      'TypeError: failed to fetch https://script.google.com/…/exec?action=dutchie_products&secret=' + SECRET,
      'Error: 401 from …?connector_secret=' + SECRET,     // the underscore-prefixed name crew missed
      'Error: …?gx_session=' + SECRET,
    ],
  };
  sandbox.pcBugNotify_({
    subject: '⚠️ UNFILED Price Cards bug [normal]: card stuck ?password=' + SECRET,
    lead: ['GX Core refused the report: fetch to …?action=ingest_bug&secret=' + SECRET + ' failed,'],
    body: { context: JSON.stringify(ctx), priority: 'normal', appVer: 'v1.443' },
    title: 'card stuck', desc: 'it hangs', reporter: 'sky',
  });

  ok(sent.length === 1, 'the notice was actually sent (guard against a vacuous pass on zero sends)');
  const t = textOf(sent[0]);
  ok(t.indexOf(SECRET) === -1, 'no secret value survives into the message MailApp receives');
  ok(sent[0].subject.indexOf(SECRET) === -1, 'the SUBJECT is scrubbed too, not only the body');
  ok(t.indexOf('connector_secret=[redacted]') !== -1, 'an underscore-PREFIXED name redacts (crew\'s bug)');
  ok(t.indexOf('gx_session=[redacted]') !== -1, 'a prefixed session name redacts');
  /* Redaction that also destroys the message is not a fix -- these notices exist to be read. */
  ok(t.indexOf('action=ingest_bug') !== -1, 'the non-secret parameters survive, so the notice still says what failed');
  ok(t.indexOf('store=river-rd') !== -1, 'the store parameter is not collateral damage');
  ok(t.indexOf('it hangs') !== -1, 'the reporter\'s own words survive');
  ok(t.indexOf('Mozilla/5.0') !== -1, 'the user agent is still identifiable');
}

/* ── 2. the queue digest, which has nothing to scrub TODAY ────────────────────────────────────────
 * Routed through the same door anyway rather than waived with a marker, so the case that matters is
 * the one below: a field added to a card tomorrow is covered without anybody remembering to be. */
{
  const { sandbox, sent, props } = loadEngine();
  props[sandbox.GC_QUEUE_PROP] = JSON.stringify([
    { id: 'a', at: '2026-09-17T10:00:00Z', by: 'sky',
      card: { brand: 'Kiva & Co "special"', item: 'Gummies', size: '10mg', price: '18', store: 'River Rd' } },
    { id: 'b', at: '2026-09-17T11:00:00Z', by: 'sky',
      card: { brand: 'Leak Co', item: 'imported from …?api_key=' + SECRET, size: '1g', price: '40', store: 'Redmond' } },
  ]);
  const out = sandbox.sendQueueDigest();

  ok(out && out.sent === true, 'the digest actually sent (it skips when nothing is new)');
  ok(sent.length === 1, 'exactly one digest message reached MailApp');
  const t = textOf(sent[0]);
  ok(t.indexOf(SECRET) === -1, 'a secret pasted into a CARD FIELD does not leave in the digest either');
  ok(t.indexOf('Gummies') !== -1, 'ordinary card text is untouched');
  /* The HTML must still be HTML afterwards: the scrub runs over a built htmlBody, and a regex that
     ate an entity or an attribute quote would corrupt every digest to stop a leak in none of them. */
  ok(t.indexOf('&amp;') !== -1, 'an HTML entity in a card field is not mangled by the scrub');
  ok(t.indexOf('&quot;') !== -1, 'an escaped quote in a card field is not mangled by the scrub');
  ok(/<table[^>]*>/.test(t) && t.indexOf('</table>') !== -1, 'the digest table survives intact');
}

/* ── 3. the stored copy, which no shared test can see ─────────────────────────────────────────────
 * The browser blob does not stop at the email: it is forwarded to GX Core's ingest_bug and stored in
 * bug_reports, which the bug board and Core's own bug-filed email then read back out.
 *
 * THIS DRIVES THE REAL reportBug_ AND READS THE OUTBOUND URL. An earlier version of this case called
 * scrubSecrets_ on a blob directly and asserted the result -- and it passed against the UNFIXED
 * engine, because the helper was never what was missing. It proved the regex and said nothing about
 * whether the call site used it, which is the entire bug in every app audited this week. */
{
  const { sandbox } = loadEngine();
  const fetched = [];
  sandbox.PropertiesService.getScriptProperties().setProperty('GX_DEPLOY_SECRET', SECRET);
  sandbox.UrlFetchApp.fetch = (url) => {
    fetched.push(url);
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true, id: 'bug_1' }) };
  };
  const ctx = { url: 'https://x/?store=river-rd&secret=' + SECRET, errors: ['…?token=' + SECRET] };
  const out = sandbox.reportBug_({ desc: 'it hangs', reporter: 'sky', context: JSON.stringify(ctx) });

  ok(out && out.ok === true, 'the report was actually filed (guard against passing on an early return)');
  ok(fetched.length === 1, 'exactly one call went out to GX Core');
  /* The engine's OWN secret is in this URL by design -- that is what gates ingest_bug. What must not
     be there is a second copy that arrived from the browser inside `context`. */
  const ctxParam = decodeURIComponent(/[?&]context=([^&]*)/.exec(fetched[0])[1]);
  ok(ctxParam.indexOf(SECRET) === -1, 'the forwarded context carries no secret into bug_reports');
  ok(ctxParam.indexOf('store=river-rd') !== -1, 'the rest of the captured page address still reaches the board');
  let reparsed = null;
  try { reparsed = JSON.parse(ctxParam); } catch (e) {}
  ok(reparsed !== null, 'the scrubbed blob is still valid JSON, so Core can still read it');
  ok(reparsed && reparsed.errors && reparsed.errors.length === 1, 'its structure survives the scrub');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
