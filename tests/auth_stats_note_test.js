#!/usr/bin/env node
/* ─── ?action=authStats carries its own caveat — tests ─────────────────────────────────────────────
 *
 *   RUN:  node tests/auth_stats_note_test.js   (repo root; no deps, no network, no credentials)
 *
 * WHY THIS EXISTS
 * The read counters lie, and they lie in the direction that would stop the read gate ever being
 * flipped on. Until v1.436 every read called GX Core even while the read gate was dark, and a good
 * token that Core was too slow or too broken to answer for was filed as `read_without` — the bucket
 * whose name means "this client is not signed in". Live on 2026-09-12: read_with ≈ 15,612 and
 * read_without ≈ 17,692 for getQueue, which reads as "half our clients aren't ready" and is not what
 * it says.
 *
 * Sky's call was NOT to reset: resetAuthStats() deletes one property holding BOTH sides, so clearing
 * the misleading read counters would throw away write counters that are real and took weeks. So the
 * numbers stay and the label travels with them, stamped at the point the numbers are read.
 *
 * WHAT EACH ASSERTION IS PINNED AGAINST — the fixture that makes it FAIL, named:
 *
 *   §1  the code as it stood at ddf6872: authStats_ returns the raw counters and nothing else, so
 *       `auth.note` is undefined and a reader has no way to know what read_without contains.
 *   §2  implementing the stamp as a stored property (props.setProperty) instead of a source
 *       constant: resetAuthStats() deletes it, and the caveat is gone at exactly the moment the
 *       old numbers are re-read against a cleared board.
 *   §3  the same stored-property implementation seen from the other side: the note would show up in
 *       the persisted JSON, where the next writer of authStatBump_ can overwrite or drop it.
 *   §4  a note naming buckets that no longer exist (a rename in authStats_'s sanitize list, or a
 *       typo): the caveat points a reader at a field that is not in the payload.
 *   §5  a stamp that only appears on an empty board, or one that a counter bump displaces.
 *   §6  a stamp with no date: "collected before" is not actionable without saying before when.
 *
 * Loads the real apps-script/Code.gs with Apps Script globals stubbed, so what is under test is the
 * shipped function and not a paraphrase of it.
 */
'use strict';
const fs = require('fs');

const SRC = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');

function world(seed) {
  const props = Object.assign({}, seed || {});
  const stubs = {
    SpreadsheetApp: {}, DriveApp: {}, HtmlService: {}, ContentService: {},
    MailApp: {}, GmailApp: {}, ScriptApp: {}, Session: {}, Logger: { log() {} },
    UrlFetchApp: { fetch: () => ({ getContentText: () => '{"ok":true}', getResponseCode: () => 200 }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
    Utilities: {
      getUuid: () => 'test-uuid',
      formatDate: () => '2026-09-12',
      computeDigest: (_a, s) => Array.from(Buffer.from(String(s), 'utf8')),
      base64Encode: (b) => Buffer.from(b).toString('base64'),
      base64EncodeWebSafe: (b) => Buffer.from(b).toString('base64url'),
      DigestAlgorithm: { SHA_256: 'sha256' }
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); },
        deleteProperty: (k) => { delete props[k]; }
      })
    }
  };
  const names = Object.keys(stubs);
  let P;
  try {
    P = new Function(...names, SRC +
      '\n; return { authStats_, resetAuthStats, authStatBump_, AUTH_STATS_PROP,' +
      ' AUTH_STATS_NOTE: (typeof AUTH_STATS_NOTE === "undefined" ? undefined : AUTH_STATS_NOTE) };'
    )(...names.map(n => stubs[n]));
  } catch (e) {
    console.error('LOAD FAILED: Code.gs did not evaluate under stubs — ' + e.message);
    console.error('Add the missing global to `stubs`. Do not let this pass quietly.');
    process.exit(2);
  }
  return { P, props, stored: () => props[P.AUTH_STATS_PROP] || '' };
}

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } };
const text = (n) => JSON.stringify(n || {});

/* ═══ 1. the route says what its own read counters mean ══════════════════════════════════════════ */
console.log('\n1. ?action=authStats carries the caveat');
{
  const w = world();
  const note = w.P.authStats_().auth.note;

  // At ddf6872 this is undefined: the counters ship bare and read as a readiness verdict.
  ok(!!note, 'authStats_ returns a note alongside the counters');
  ok(/read_without/.test(text(note)) && /read_with\b/.test(text(note)),
     'it names the counters it is a caveat ON');
  ok(/read_present_unverified/.test(text(note)) && /read_absent_unverified/.test(text(note)),
     'and it names the instrument to use instead');
  ok(/did not answer|unreachable|too slow/i.test(text(note)),
     'and says what the old buckets conflate — not merely that they are old');
}

/* ═══ 2. it survives a reset, because a reset is when it matters most ════════════════════════════ */
console.log('\n2. resetAuthStats() cannot take the caveat with it');
{
  const w = world();
  w.P.authStatBump_('r', 'getQueue', false, false, true);
  w.P.authStatBump_('w', 'submitCards', true, false);
  ok(w.P.authStats_().auth.read_present_unverified.getQueue === 1, 'counters accumulate as usual');

  const after = w.P.resetAuthStats().auth;
  ok(after.read_present_unverified === undefined && after.with === undefined,
     'the reset really did clear the counters');
  // A stored stamp is deleted by this same call. A source constant cannot be.
  ok(!!after.note && /read_without/.test(text(after.note)),
     'and the note is still there afterwards');
  ok(!!w.P.authStats_().auth.note, 'and on every read after the reset');
}

/* ═══ 3. it is a constant, not something the stats property carries ══════════════════════════════ */
console.log('\n3. the stamp lives in the source, not in Script Properties');
{
  const w = world();
  w.P.authStatBump_('r', 'getQueue', false, false, true);
  w.P.authStats_();
  ok(w.stored().length > 0, 'the counters ARE persisted');
  ok(!/read_present_unverified.{0,400}current instrument/s.test(w.stored()) && !/"note"/.test(w.stored()),
     'but the note is not written into the persisted JSON');
  ok(typeof w.P.AUTH_STATS_NOTE === 'object' && w.P.AUTH_STATS_NOTE,
     'it is a top-level constant in Code.gs (AUTH_STATS_NOTE)');
  // Both being undefined must NOT read as a match — that is the assertion measuring itself.
  const returned = w.P.authStats_().auth.note;
  ok(!!returned && !!w.P.AUTH_STATS_NOTE &&
     JSON.stringify(returned) === JSON.stringify(w.P.AUTH_STATS_NOTE),
     'and the route returns that same constant');
}

/* ═══ 4. every bucket the note names is a bucket the route reports ═══════════════════════════════ */
console.log('\n4. the caveat points at fields that actually exist');
{
  const w = world();
  const note = text(w.P.authStats_().auth.note);
  const named = ['read_with', 'read_without', 'read_present_unverified', 'read_absent_unverified'];
  // The sanitize list in authStats_ is the authoritative roster of buckets it reports.
  const roster = SRC.slice(SRC.indexOf('function authStats_()'));
  // Without this line the whole section goes silent when there is no note — and a section that
  // prints nothing is indistinguishable from one that checked everything and was happy.
  ok(named.some(function (b) { return new RegExp(b + '\\b').test(note); }),
     'the note names at least one real counter');
  named.forEach(function (b) {
    if (!new RegExp(b + '\\b').test(note)) return;         // not named, nothing to keep honest
    ok(new RegExp("'" + b + "'").test(roster),
       'the note names ' + b + ', and authStats_ still reports it');
  });
}

/* ═══ 5. it is there on a busy board too, not only an empty one ══════════════════════════════════ */
console.log('\n5. the stamp is not displaced by real data');
{
  const w = world({ PRICECARDS_AUTH_STATS: JSON.stringify({
    read_with: { getQueue: 15612 }, read_without: { getQueue: 17692 },
    with: { submitCards: 400 }, note: 'a stale note left in the property by an older build'
  }) });
  const auth = w.P.authStats_().auth;
  ok(auth.read_without.getQueue === 17692, 'the real counters come through untouched');
  ok(typeof auth.note === 'object' && /read_present_unverified/.test(text(auth.note)),
     'and the source constant wins over anything stored under the same key');
}

/* ═══ 6. it says WHEN ════════════════════════════════════════════════════════════════════════════ */
console.log('\n6. a "collected before" caveat has to name the date');
{
  const w = world();
  // `|| {}` on purpose: with no note at all this must report FAIL, not throw. A suite that dies
  // mid-run never prints its tally, and the gate reads a missing tally as a broken suite.
  const note = w.P.authStats_().auth.note || {};
  ok(/^\d{4}-\d{2}-\d{2}$/.test(String(note.as_of)),
     'the stamp carries a plain YYYY-MM-DD date (' + note.as_of + ')');
  ok(!!note.as_of && text(note).indexOf(note.as_of) !== text(note).lastIndexOf(note.as_of),
     'and the prose repeats it, so the cut-off is readable without joining two fields');
}

console.log('\n──────────────────────────────');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
