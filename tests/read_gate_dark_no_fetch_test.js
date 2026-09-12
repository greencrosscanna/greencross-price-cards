#!/usr/bin/env node
/* ─── requireRead_ — while the read gate is DARK, nobody pays GX Core ─────────────────────────────
 *
 *   RUN:  node tests/read_gate_dark_no_fetch_test.js   (repo root; no deps, no network, no credentials)
 *
 * WHY THIS EXISTS
 * Measured on 2026-09-11: Price Cards was 51% of ALL traffic reaching GX Core — 3,662 of 7,181 calls
 * in 24h — and every single one was the `verify` route. Read enforcement is OFF here
 * (?action=authStats says enforcing_reads:false), and gateDecision_(auth, false, …) returns ok:true
 * whatever the verifier said. So every one of those round trips bought an answer that was thrown
 * away. Core's /exec has bad spells where an identical request hangs 50-130s and comes back as a
 * Google "unable to open the file" page, so the price was not zero: it was up to ninety seconds of a
 * staff member standing at a shop iPad.
 *
 * WHAT EACH ASSERTION IS PINNED AGAINST — the fixture that makes it FAIL, named, because an
 * assertion with no such fixture is measuring the fixture and not the code:
 *
 *   §1  the code as it stood at 7e29d73: requireRead_ called gxAuthRead_ unconditionally, so the
 *       fetch counter reads 1, not 0.
 *   §2  the same old code: a token-bearing dark read landed in `read_without`, manufacturing the
 *       "clients aren't sending tokens" signal the flip gets decided on.
 *   §3  any future "skip verification" that also skipped the cache read: the user/role echo dies.
 *   §4  encoding "off" as a constant, a build flag, or a giant TTL: enforcing stops fetching too.
 *   §5  letting the shortcut reach requireWrite_ / gxAuthWrite_: writes stop verifying.
 *   §6  collapsing the pcr/pcw namespaces: a cached READ answer authorizes a WRITE with no fetch.
 *   §7  reading readEnforced_() once at load instead of per call: the flip needs a deploy.
 *   §8  bumping the new buckets without statBucket_: `toString` stores the inherited function.
 *
 * Loads the real apps-script/Code.gs with Apps Script globals stubbed, so what is under test is the
 * shipped function and not a paraphrase of it. Cannot reach Apps Script: .claspignore excludes tests/.
 */
'use strict';
const fs = require('fs');

const SRC = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');

/* A fresh world per scenario: its own script properties, its own cache, its own fetch counter.
   Shared state between scenarios is how a test starts passing for the previous test's reasons. */
function world(opts) {
  opts = opts || {};
  const props = Object.assign({}, opts.props || {});
  const cache = new Map();
  const fetches = [];
  const reply = opts.reply || { ok: true, user: 'ann', role: 'editor', canEdit: true, app: 'pricecards' };

  const stubs = {
    SpreadsheetApp: {}, DriveApp: {}, HtmlService: {}, ContentService: {},
    MailApp: {}, GmailApp: {}, ScriptApp: {}, Session: {}, Logger: { log() {} },
    UrlFetchApp: {
      fetch(url) {
        fetches.push(url);
        return { getContentText: () => JSON.stringify(reply), getResponseCode: () => 200 };
      }
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (cache.has(k) ? cache.get(k) : null),
        put: (k, v) => { cache.set(k, v); },
        remove: (k) => { cache.delete(k); }
      })
    },
    Utilities: {
      getUuid: () => 'test-uuid',
      formatDate: () => '2026-09-11',
      // Distinct per token, so two tokens cannot collide onto one cache key.
      computeDigest: (_alg, str) => Array.from(Buffer.from(String(str), 'utf8')),
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
      '\n; return { requireRead_, requireWrite_, authStats_, gateDecision_, authStatBump_,' +
      ' readEnforced_, authEnforced_, AUTH_STATS_PROP, READ_ENFORCE_PROP, AUTH_ENFORCE_PROP };'
    )(...names.map(n => stubs[n]));
  } catch (e) {
    console.error('LOAD FAILED: Code.gs did not evaluate under stubs — ' + e.message);
    console.error('Add the missing global to `stubs`. Do not let this pass quietly.');
    process.exit(2);
  }
  return {
    P, props, cache, fetches,
    stats: () => P.authStats_().auth,
    fetchCount: () => fetches.length,
    resetFetches: () => { fetches.length = 0; },
    darkReads:  () => { delete props[P.READ_ENFORCE_PROP]; },
    enforceReads: () => { props[P.READ_ENFORCE_PROP] = '1'; },
    darkWrites: () => { delete props[P.AUTH_ENFORCE_PROP]; },
    enforceWrites: () => { props[P.AUTH_ENFORCE_PROP] = '1'; }
  };
}

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } };
const count = (bucket, key) => (bucket && bucket[key]) || 0;

/* ═══ 1. dark + a real token + a cold cache: no Core call, and the read still works ═══ */
console.log('\n1. read gate DARK, cache cold — the round trip is not paid');
{
  const w = world();
  w.darkReads();
  const gate = w.P.requireRead_('getQueue', { token: 'sess-abc' });

  // THE ONE THAT MATTERS. At 7e29d73 this is 1.
  ok(w.fetchCount() === 0, 'GX Core is never called (fetches: ' + w.fetchCount() + ')');
  ok(gate.ok === true, 'and the read still succeeds — the gate is dark, nothing may be refused');
  ok(gate.unauthenticated === true, 'flagged unauthenticated, so nothing pretends it was checked');
}

/* ═══ 2. the readiness counters keep meaning what they say ═══ */
console.log('\n2. counters — "nobody asked" is not "GX Core refused"');
{
  const w = world();
  w.darkReads();
  w.P.requireRead_('getQueue', { token: 'sess-abc' });
  w.P.requireRead_('getConfig', {});                       // no token at all
  const s = w.stats();

  // At 7e29d73 the token-bearing read landed in read_without, because Core was asked, answered, and
  // the answer was discarded — except by the counter. That is the false "clients aren't ready".
  ok(count(s.read_without, 'getQueue') === 0,
     'a token-bearing dark read does NOT land in read_without');
  ok(count(s.read_with, 'getQueue') === 0,
     'nor in read_with — Core confirmed nothing, so neither bucket may claim it did');
  ok(count(s.read_present_unverified, 'getQueue') === 1,
     'it is counted as present-but-unverified');
  ok(count(s.read_absent_unverified, 'getConfig') === 1,
     'and a tokenless read as absent-and-unverified');
  ok(count(s.read_present_unverified, 'getConfig') === 0,
     'the two unverified buckets are keyed on whether a token was PRESENT, not on the outcome');
  ok(typeof s.read_last_unverified_at === 'string',
     'with its own timestamp, so the unverified stretch is datable');

  /* The sharp version of the same thing. The first assertion above passes against the OLD code by
     luck — Core accepted, so the old counter said read_with. The false signal appeared when Core
     did NOT answer, which during the /exec bad spells was often: a perfectly good token came back
     core_unreachable and was filed as a client that isn't sending one. */
  const u = world({ reply: { ok: false, error: 'nope', code: 'invalid_session' } });
  u.darkReads();
  u.P.requireRead_('getQueue', { token: 'sess-abc' });
  const su = u.stats();
  ok(count(su.read_without, 'getQueue') === 0,
     'a good token is never filed as a refusal just because Core was unreachable or unhappy');
  ok(count(su.read_present_unverified, 'getQueue') === 1, 'it is filed as unverified instead');
}

/* ═══ 3. a warm cache entry is still used — identity comes back for free ═══ */
console.log('\n3. dark + a WARM cache entry — used, still no new call');
{
  const w = world();
  // Warm it through the shipped enforcing path rather than hand-writing a cache key: a key the test
  // computes itself would keep passing after the production key changed shape.
  w.enforceReads();
  const first = w.P.requireRead_('getQueue', { token: 'sess-abc' });
  ok(w.fetchCount() === 1 && first.ok === true, 'an enforcing read verified once and cached it');

  w.darkReads();
  w.resetFetches();
  const gate = w.P.requireRead_('getQueue', { token: 'sess-abc' });
  ok(w.fetchCount() === 0, 'the dark read that follows makes no call');
  ok(gate.ok === true && gate.user === 'ann' && gate.role === 'editor',
     'and still echoes the real user and role back — paid for already');
  ok(count(w.stats().read_with, 'getQueue') === 2,
     'a cache hit counts as CONFIRMED, because GX Core really did say yes inside the TTL');
  ok(count(w.stats().read_present_unverified, 'getQueue') === 0,
     'so it does not land in the unverified bucket');
}

/* ═══ 4. flip the gate on and full verification is back — no deploy ═══ */
console.log('\n4. read gate ENFORCING — the Core check happens, and refusals refuse');
{
  const w = world({ reply: { ok: false, error: 'Session expired', code: 'session_expired' } });
  w.enforceReads();
  const gate = w.P.requireRead_('getQueue', { token: 'stale-token' });
  ok(w.fetchCount() === 1, 'GX Core IS called (fetches: ' + w.fetchCount() + ')');
  ok(gate.ok === false, 'and a token Core rejects is refused');
  ok(gate.needsAuth === true && gate.code === 'session_expired', 'with Core\'s own code passed through');
  ok(count(w.stats().read_without, 'getQueue') === 1,
     'a real refusal still lands in read_without — that bucket kept its meaning');
  ok(count(w.stats().read_absent_unverified, 'getQueue') === 0,
     'and not in an unverified bucket');
}
{
  const w = world();                                        // Core accepts
  w.enforceReads();
  const gate = w.P.requireRead_('getQueue', { token: 'good' });
  ok(w.fetchCount() === 1 && gate.ok === true && gate.user === 'ann',
     'and an accepted token proceeds, verified, with its identity');
}

/* ═══ 5. the WRITE path is untouched — it verifies every time ═══ */
console.log('\n5. writes still verify unconditionally');
{
  const w = world();
  w.darkReads();                                            // reads dark …
  w.darkWrites();                                           // … writes dark too
  w.P.requireWrite_({ action: 'submitCards', token: 'sess-abc' });
  ok(w.fetchCount() === 1, 'a DARK write still calls GX Core (fetches: ' + w.fetchCount() + ')');
  ok(count(w.stats().with, 'submitCards') === 1,
     'and is counted in the original write bucket, unchanged');
  ok(count(w.stats().read_present_unverified, 'submitCards') === 0,
     'the write path can never reach the unverified buckets');
}
{
  const w = world({ reply: { ok: false, error: 'Not signed in', code: 'auth_required' } });
  w.darkReads();
  w.enforceWrites();                                        // writes are LIVE in production
  const gate = w.P.requireWrite_({ action: 'clearQueue', token: 'forged' });
  ok(w.fetchCount() === 1, 'an ENFORCING write verifies against Core');
  ok(gate.ok === false && gate.needsAuth === true,
     'and a forged token is refused even though the read gate is dark');
}

/* ═══ 6. a cached READ answer must never authorize a WRITE ═══ */
console.log('\n6. pcr and pcw stay separate namespaces');
{
  const w = world();
  w.enforceReads();
  w.P.requireRead_('getQueue', { token: 'sess-abc' });       // fills the pcr cache
  ok(w.fetchCount() === 1, 'the read cached its verification under pcr');

  w.resetFetches();
  w.enforceWrites();
  const gate = w.P.requireWrite_({ action: 'submitCards', token: 'sess-abc' });
  ok(w.fetchCount() === 1,
     'the write with the SAME token verifies again — it cannot read the pcr entry');
  ok(gate.ok === true, 'and proceeds on its own verification');
}

/* ═══ 7. the branch is evaluated per call, so the flip needs no deploy ═══ */
console.log('\n7. enableReadAuth() takes effect on the very next request');
{
  const w = world();                                        // ONE loaded module, start to finish
  w.darkReads();
  w.P.requireRead_('liveCatalog', { token: 'sess-abc' });
  ok(w.fetchCount() === 0, 'dark: no call');

  w.enforceReads();                                         // what enableReadAuth() does
  w.P.requireRead_('liveCatalog', { token: 'sess-other' });  // a token with no warm entry
  ok(w.fetchCount() === 1, 'flipped on, without reloading anything: the call is made again');

  w.darkReads();                                            // and disableReadAuth() rolls back
  w.resetFetches();
  w.P.requireRead_('liveCatalog', { token: 'sess-third' });
  ok(w.fetchCount() === 0, 'flipped back off: quiet again');
}

/* ═══ 8. the new buckets are prototype-safe like the old ones ═══ */
console.log('\n8. the new counters cannot be poisoned by an inherited name');
{
  const w = world();
  w.darkReads();
  // `toString` is not a real action, but an unknown ?action= reaches the router before requireRead_
  // and this counter has been corrupted by exactly this once already, in the LIVE stats.
  w.P.authStatBump_('r', 'toString', false, false, true);
  w.P.authStatBump_('r', 'toString', false, false, true);
  const s = w.stats();
  ok((s.read_present_unverified || {}).toString === 2,
     'a bucket keyed on "toString" holds the number 2, not the inherited function plus a digit');

  // And a value corrupted by an older build is dropped rather than reported as a count.
  const w2 = world({ props: { PRICECARDS_AUTH_STATS: JSON.stringify({
    read_present_unverified: { getQueue: 'function toString() { [native code] }1', getConfig: 4 } }) } });
  const s2 = w2.stats();
  ok((s2.read_present_unverified || {}).getQueue === undefined &&
     (s2.read_present_unverified || {}).getConfig === 4,
     'authStats_ sanitizes the new buckets: the corrupt entry is dropped, the real count survives');
}

console.log('\n──────────────────────────────');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
