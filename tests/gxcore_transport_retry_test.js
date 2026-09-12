#!/usr/bin/env node
/* ─── GX Core reads survive a bounced /exec ───────────────────────────────────────────────────────
 *
 *   RUN:  node tests/gxcore_transport_retry_test.js   (repo root; no deps, no network, no credentials)
 *
 * WHY THIS EXISTS
 * Measured 2026-09-11/12: GX Core's /exec endpoint intermittently bounces. An identical request
 * either answers in ~2s or stalls and comes back as a Google HTML error page ("Sorry, unable to
 * open the file at this time"). Price Cards called it with no retry at all, so a bounce on the
 * session check refused a real staff member's save — `JSON.parse` on `<!DOCTYPE html>…` threw, the
 * catch returned core_unreachable, and the write was denied. The person did nothing wrong and had
 * nothing to act on.
 *
 * WHAT IS UNDER TEST: gxCoreGetJson_ (the read-only transport), and the two callers that pay for
 * it — gxVerify_ (the check behind every write) and dutchieStores_ (?action=stores).
 *
 * WHAT EACH ASSERTION IS PINNED AGAINST — the fixture that makes it FAIL, named, because an
 * assertion with no such fixture is measuring the fixture and not the code:
 *
 *   §1  the code before this fix: one fetch, no retry, and the HTML body throws — gxVerify_ returns
 *       core_unreachable and the user's save is refused on a blip. Also fails against a "retry"
 *       that only catches thrown fetches: an HTML body arrives as a perfectly ordinary 200.
 *   §2  an unbounded retry (never gives up) or one that caches its failure: the second call would
 *       fetch 0 times and every manager stays locked out for the whole TTL. Also fails against a
 *       retry that lets a transport failure through as ok:true — the write must still be refused.
 *   §3  retrying on any ok:false: a genuine `session_expired` would burn 3 fetches and ~2s of
 *       backoff to arrive at the same refusal. Also fails if the two failure kinds are returned
 *       indistinguishably — "Core said no" must not read as "Core never answered".
 *   §4  a retry written around the response object only: a thrown fetch skips it entirely and the
 *       fetch count stays 1.
 *   §5  any change to the caching contract: the success must still be cached once, under the write
 *       namespace, at WRITE_CACHE_TTL_S — the retry is a transport concern and must not touch it.
 *   §6  treating a non-200 as an answer: HTTP 500 with a JSON-ish body would be parsed and returned
 *       as Core's verdict.
 *   §7  leaving ?action=stores on the bare fetch: one HTML body and the store registry throws,
 *       taking ?action=stores and the all-stores live catalog down with it.
 *   §8  retrying a refusal on the stores route: a real "store registry refused" would be retried
 *       three times and the operator waits 2s longer for the same message.
 *   §9  a retry loop with no elapsed-time budget: three 130s stalls is 390s, past the 6-minute
 *       Apps Script execution cap — the write dies with a script timeout instead of a clean
 *       refusal, which is WORSE for the staff member than the bug being fixed.
 *
 * Loads the real apps-script/Code.gs with Apps Script globals stubbed, so what is under test is the
 * shipped function and not a paraphrase of it. Cannot reach Apps Script: .claspignore excludes tests/.
 */
'use strict';
const fs = require('fs');

const SRC = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');

const HTML_BOUNCE =
  '<!DOCTYPE html><html><head><title>Error</title></head><body>' +
  '<div>Sorry, unable to open the file at this time.</div></body></html>';

/* A scripted transport. `script` is a list of what the NEXT fetch does, consumed in order; the last
   entry repeats once the list runs dry, so "always bounces" is one entry. Each entry is either
   { html:true } · { code:500, body } · { throw:'…' } · { json:<object> } · { body:'<raw>' }. */
function world(opts) {
  opts = opts || {};
  const props = Object.assign({}, opts.props || {});
  const cache = new Map();          // key -> { value, ttl }
  const fetches = [];               // every URL actually requested
  const sleeps = [];                // every Utilities.sleep(ms)
  const script = (opts.script || []).slice();
  let clock = opts.clock ? opts.clock.slice() : null;   // ms consumed by each fetch, in order
  let now = 1000000;

  function nextStep() {
    if (!script.length) return { json: { ok: true } };
    return script.length === 1 ? script[0] : script.shift();
  }

  const stubs = {
    SpreadsheetApp: {}, DriveApp: {}, HtmlService: {}, ContentService: {},
    MailApp: {}, GmailApp: {}, ScriptApp: {}, Session: {}, Logger: { log() {} },
    UrlFetchApp: {
      fetch(url) {
        fetches.push(url);
        if (clock && clock.length) now += (clock.length === 1 ? clock[0] : clock.shift());
        const step = nextStep();
        if (step.throw) throw new Error(step.throw);
        const body = step.html ? HTML_BOUNCE
                   : step.body !== undefined ? step.body
                   : JSON.stringify(step.json);
        const code = step.code || 200;
        return { getContentText: () => body, getResponseCode: () => code };
      }
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (cache.has(k) ? cache.get(k).value : null),
        put: (k, v, ttl) => { cache.set(k, { value: v, ttl: ttl }); },
        remove: (k) => { cache.delete(k); }
      })
    },
    Utilities: {
      getUuid: () => 'test-uuid',
      formatDate: () => '2026-09-12',
      sleep: (ms) => { sleeps.push(ms); now += ms; },
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
    },
    /* The retry budget reads the clock. Feeding it a stub means a "130s stall" costs the test
       nothing in wall time while still being 130s as far as the code is concerned. */
    Date: class extends Date {
      constructor(...a) { if (a.length) { super(...a); } else { super(now); } }
      static now() { return now; }
    }
  };

  const names = Object.keys(stubs);
  let P;
  try {
    P = new Function(...names, SRC +
      '\n; return { gxVerify_, gxAuthWrite_, gxAuthRead_, requireWrite_, dutchieStores_,' +
      ' gxVerifyCacheKey_, authEnforced_, AUTH_ENFORCE_PROP, WRITE_CACHE_TTL_S, READ_CACHE_TTL_S,' +
      ' gxCoreGetJson_: (typeof gxCoreGetJson_ === "function" ? gxCoreGetJson_ : null) };'
    )(...names.map(n => stubs[n]));
  } catch (e) {
    console.error('LOAD FAILED: Code.gs did not evaluate under stubs — ' + e.message);
    console.error('Add the missing global to `stubs`. Do not let this pass quietly.');
    process.exit(2);
  }
  return {
    P, props, cache, fetches, sleeps,
    fetchCount: () => fetches.length,
    resetFetches: () => { fetches.length = 0; },
    enforceWrites: () => { props[P.AUTH_ENFORCE_PROP] = '1'; },
    cached: (token, ns) => cache.get(P.gxVerifyCacheKey_(token, ns)) || null
  };
}

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } };
const GOOD = { ok: true, user: 'ann', role: 'editor', canEdit: true, app: 'pricecards' };

/* ═══ 1. an HTML bounce, then a real answer — the save goes through ═══ */
console.log('\n1. gxVerify_: bounce → retry → success (the staff member never sees it)');
{
  const w = world({ script: [{ html: true }, { json: GOOD }] });
  const out = w.P.gxAuthWrite_('sess-abc');

  ok(out.ok === true, 'the session verifies (before the fix: ok=false, core_unreachable)');
  ok(out.user === 'ann' && out.role === 'editor', 'and Core\'s real answer is what comes back');
  ok(w.fetchCount() === 2, 'it took exactly 2 fetches — the HTML page was retried (got ' + w.fetchCount() + ')');
  ok(w.sleeps.length === 1 && w.sleeps[0] === 500, 'one 500ms backoff before the retry (got ' + JSON.stringify(w.sleeps) + ')');
  ok(w.cached('sess-abc', 'pcw') !== null, 'the success is cached, exactly as an unretried one is');
}

/* ═══ 2. three bounces in a row — fail CLOSED, and do not cache the failure ═══ */
console.log('\n2. gxVerify_: three bounces — refuse the write, cache nothing');
{
  const w = world({ script: [{ html: true }] });     // always bounces
  w.enforceWrites();
  const gate = w.P.requireWrite_({ action: 'submitCards', token: 'sess-abc' });

  ok(gate.ok === false, 'the write is REFUSED — a transport failure must never become "allowed"');
  ok(gate.needsAuth === true, 'and it refuses through the normal auth path, not a new branch');
  ok(gate.code === 'core_unreachable', 'code stays core_unreachable (authProbe_ and the client branch on it)');
  ok(w.fetchCount() === 3, 'exactly 3 attempts, then it stops (got ' + w.fetchCount() + ')');
  ok(JSON.stringify(w.sleeps) === '[500,1500]', 'backoff was 500ms then 1500ms (got ' + JSON.stringify(w.sleeps) + ')');
  ok(w.cached('sess-abc', 'pcw') === null, 'NOTHING was cached — a blip in Core must not lock managers out for a minute');

  // The proof that "not cached" is real and not an artifact of the key: ask again, it fetches again.
  w.resetFetches();
  w.P.gxAuthWrite_('sess-abc');
  ok(w.fetchCount() === 3, 'the next call tries Core again rather than replaying a cached refusal');
}

/* ═══ 3. a genuine refusal is an ANSWER — return it at once, and say so ═══ */
console.log('\n3. gxVerify_: {ok:false, session_expired} is Core answering correctly');
{
  const expired = { ok: false, error: 'Your session has expired', code: 'session_expired' };
  const w = world({ script: [{ json: expired }] });
  const out = w.P.gxAuthWrite_('sess-old');

  ok(w.fetchCount() === 1, 'asked ONCE — a real answer is never retried (got ' + w.fetchCount() + ')');
  ok(w.sleeps.length === 0, 'and nobody waited 2s of backoff to be told the same thing');
  ok(out.code === 'session_expired', 'Core\'s own code is passed through untouched');
  ok(out.transport !== true, 'it is NOT flagged as a transport failure — Core said no, it did answer');
  ok(w.cached('sess-old', 'pcw') === null, 'a refusal is still not cached');

  // The other half of the distinction: the bounce IS flagged, so the two are told apart.
  const b = world({ script: [{ html: true }] });
  const bounced = b.P.gxAuthWrite_('sess-abc');
  ok(bounced.transport === true, 'a bounce carries transport:true — "did not answer" vs "said no"');
  ok(bounced.attempts === 3, 'and reports how many times it asked (got ' + bounced.attempts + ')');
  ok(/did not answer/i.test(String(bounced.error)), 'its message says Core did not answer, not that it refused');
}

/* ═══ 4. a THROWN fetch is a transport failure too ═══ */
console.log('\n4. gxVerify_: a thrown fetch retries');
{
  const w = world({ script: [{ throw: 'DNS failure' }, { throw: 'DNS failure' }, { json: GOOD }] });
  const out = w.P.gxAuthWrite_('sess-abc');

  ok(out.ok === true, 'two thrown fetches, then success — the session verifies');
  ok(w.fetchCount() === 3, 'all three attempts were used (got ' + w.fetchCount() + ')');
}

/* ═══ 5. the caching contract is untouched ═══ */
console.log('\n5. gxVerify_: success caching is exactly as before');
{
  const w = world({ script: [{ json: GOOD }] });
  const first = w.P.gxAuthWrite_('sess-abc');
  ok(first.ok === true && w.fetchCount() === 1, 'a clean success still costs exactly one fetch');

  const entry = w.cached('sess-abc', 'pcw');
  ok(entry !== null, 'cached under the WRITE namespace');
  ok(entry.ttl === w.P.WRITE_CACHE_TTL_S && entry.ttl === 60, 'at WRITE_CACHE_TTL_S = 60 (got ' + (entry && entry.ttl) + ')');
  ok(w.cached('sess-abc', 'pcr') === null, 'and NOT under the read namespace — the two stay separate');

  w.P.gxAuthWrite_('sess-abc');
  ok(w.fetchCount() === 1, 'the second call is served from cache, no new fetch');

  const r = world({ script: [{ json: GOOD }] });
  r.P.gxAuthRead_('sess-abc');
  ok(r.cached('sess-abc', 'pcr').ttl === r.P.READ_CACHE_TTL_S, 'the read path still caches at READ_CACHE_TTL_S = 300');
}

/* ═══ 6. a non-200 is a transport failure, whatever the body says ═══ */
console.log('\n6. gxVerify_: HTTP 500 is retried, not believed');
{
  const w = world({ script: [{ code: 500, body: '{"ok":true,"user":"nobody"}' }, { json: GOOD }] });
  const out = w.P.gxAuthWrite_('sess-abc');

  ok(w.fetchCount() === 2, 'the 500 was retried (got ' + w.fetchCount() + ')');
  ok(out.user === 'ann', 'and the 500\'s body was never treated as Core\'s verdict');
}

/* ═══ 7. ?action=stores gets the same transport ═══ */
console.log('\n7. dutchieStores_: bounce → retry → success');
{
  const stores = { ok: true, stores: [{ dutchie_name: 'Green Cross River Rd' }, { dutchie_name: 'Green Cross Baseline' }] };
  const w = world({ script: [{ html: true }, { json: stores }] });
  const out = w.P.dutchieStores_();

  ok(Array.isArray(out) && out.length === 2, 'the store registry loads (before the fix: it threw)');
  ok(w.fetchCount() === 2, 'one retry was enough (got ' + w.fetchCount() + ')');
  ok(w.fetches[0].indexOf('action=stores') > -1, 'and it is the stores route being retried');
}

/* ═══ 8. a refused store registry is an answer — do not retry it ═══ */
console.log('\n8. dutchieStores_: {ok:false} returns at once');
{
  const w = world({ script: [{ json: { ok: false, error: 'store registry refused' } }] });
  let threw = '';
  try { w.P.dutchieStores_(); } catch (e) { threw = String(e.message || e); }

  ok(w.fetchCount() === 1, 'asked ONCE (got ' + w.fetchCount() + ')');
  ok(/refused/i.test(threw), 'and the operator is told Core refused it: ' + JSON.stringify(threw));
  ok(!/did not answer/i.test(threw), 'not that it was unreachable — those are different problems');
}

/* ═══ 9. the retry has an elapsed-time budget ═══ */
console.log('\n9. gxCoreGetJson_: a stalled bounce is not retried into a script timeout');
{
  // Each fetch stalls 130s before returning the Google error page — the shape measured on 2026-09-11.
  const w = world({ script: [{ html: true }], clock: [130000] });
  const out = w.P.gxAuthWrite_('sess-abc');

  ok(out.ok === false && out.transport === true, 'it still fails closed');
  ok(w.fetchCount() === 1, 'but it did NOT queue up 390s of stalls under a 360s cap (got ' + w.fetchCount() + ')');
  ok(out.attempts === 1, 'and it reports the one attempt it actually made');

  // The budget must not fire on the fast bounce, which is the case the retry exists for.
  const f = world({ script: [{ html: true }, { json: GOOD }], clock: [1500] });
  ok(f.P.gxAuthWrite_('sess-abc').ok === true, 'a fast bounce (1.5s) is still retried and still succeeds');
}

console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
