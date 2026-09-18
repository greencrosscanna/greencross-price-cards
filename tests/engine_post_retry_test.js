#!/usr/bin/env node
/* ─── engine WRITE transport: enginePost retry + replay safety — tests ─────────────────────────────
 *
 *   RUN:  node tests/engine_post_retry_test.js   (from the repo root; no deps, no network, no DOM)
 *
 * WHY THESE
 * v1.421 moved every engine READ onto GXClient's retry. The six WRITE posts were not moved with it
 * and stayed bare fetches, so roughly one rapid submit in sixteen died on the /exec second hop and
 * told a budtender "Couldn't send" about a submit they had done nothing wrong to. It never got
 * reported because it reads as a flaky network. v1.422 put all six behind one door, enginePost.
 *
 * THE PART THESE TESTS REALLY GUARD is not "does it retry" but "may it retry". The failure is on the
 * SECOND hop, so the write may ALREADY HAVE RUN and a retry re-runs it — a retry is only safe where
 * re-running is a no-op. §2 pins that: an action absent from POST_RETRY_SAFE gets exactly one
 * attempt. If someone adds a write and it silently starts retrying, §2 is what fails.
 *
 * §1 and §2 run the REAL enginePost, sliced out of the real file at `@test-slice enginePost` and
 * evaluated with fetch/pcSign/window/setTimeout injected — generator.js is one IIFE with no module
 * boundary, and a DOM shim big enough to load 100KB of app code would only test the shim. §3 asserts
 * shape: that no seventh raw POST has crept back in, and that markPrinted still carries the replay
 * id the engine de-dupes on.
 */
'use strict';
const fs = require('fs');

const SRC = fs.readFileSync(__dirname + '/../generator.js', 'utf8');
const GAS = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } };

/* ── slice the real function out of the real file ───────────────────────────────────────────── */
// From the END of the opening sentinel comment (its `*/`) to the closing sentinel, exactly as the
// live-price test does. Anchoring on the newline would start the slice inside the open comment.
const m = SRC.match(/@test-slice enginePost[\s\S]*?\*\/\s*([\s\S]*?)\/\* ── @test-slice end/);
if (!m) {
  console.error('LOAD FAILED: the `@test-slice enginePost` sentinels are gone from generator.js.');
  console.error('Do not delete the test rather than the sentinels — restore them around enginePost.');
  process.exit(2);
}

// The free variables enginePost closes over in the browser, handed in so each case can drive them.
// GXClient stays undefined: `typeof GXClient !== "undefined"` is then false and we exercise this
// repo's own loop, which is the code under test until gx-theme grows a POST door.
function build(fetchImpl, windowImpl, gxImpl) {
  return new Function('window', 'fetch', 'pcSign', 'GXClient', 'setTimeout',
                      m[1] + '\n; return { enginePost: enginePost, boundedRead: boundedRead, SAFE: POST_RETRY_SAFE, RETRIES: POST_RETRIES, BUDGET: POST_REPLAY_BUDGET_MS };')(
    windowImpl || {}, fetchImpl, (p) => p, gxImpl,
    (fn) => fn()   // backoff collapsed to nothing; the delays are not what is being tested
  );
}

// Google's second hop: a cheerful HTTP 200 carrying an HTML page instead of our JSON. The status is
// useless as a tell, which is why enginePost reads the body shape.
const HTML_PAGE = { text: () => Promise.resolve('<!DOCTYPE html><html><body>Sorry, unable to open the file…') };
const jsonBody  = (o) => ({ text: () => Promise.resolve(JSON.stringify(o)) });

console.log('\n1. a retry-safe write survives the second-hop HTML page');
{
  let calls = 0;
  const { enginePost } = build(() => { calls++; return Promise.resolve(calls < 3 ? HTML_PAGE : jsonBody({ ok: true, added: 2 })); });
  const done = enginePost('https://e/exec', { action: 'submitCards', cards: [1, 2], subId: 'abc' })
    .then(d => {
      ok(d && d.ok === true && d.added === 2, 'two misses then success -> the caller sees the real payload');
      ok(calls === 3, 'and it took exactly the 3 attempts (' + calls + ')');
    });

  // Exhausting every attempt must fail LOUDLY and distinguishably: callers branch on gxUnreachable
  // to tell "Google's redirect is broken" from "the engine said no".
  let calls2 = 0;
  const { enginePost: ep2, RETRIES } = build(() => { calls2++; return Promise.resolve(HTML_PAGE); });
  const done2 = ep2('https://e/exec', { action: 'submitCards', cards: [1] })
    .then(() => ok(false, 'an all-miss write must not resolve as success'),
          e => {
            ok(e && e.gxUnreachable === true, 'an exhausted retry rejects tagged gxUnreachable');
            ok(calls2 === RETRIES + 1, 'and it stopped at POST_RETRIES+1 attempts (' + calls2 + ')');
          });

  // A REFUSAL IS NOT A MISS. It is well-formed JSON, so it must come back on the first attempt —
  // otherwise a signed-out iPad turns one dead write into a five-attempt retry storm.
  let calls3 = 0;
  const { enginePost: ep3 } = build(() => { calls3++; return Promise.resolve(jsonBody({ needsAuth: true, error: 'sign in' })); });
  const done3 = ep3('https://e/exec', { action: 'submitCards', cards: [1] })
    .then(d => {
      ok(d && d.needsAuth === true, 'an auth refusal resolves to the caller, which owns the wording');
      ok(calls3 === 1, 'and is NOT retried (' + calls3 + ' attempt)');
    });

  var section1 = Promise.all([done, done2, done3]);
}

const section2 = section1.then(() => {
  console.log('\n2. an action absent from POST_RETRY_SAFE is sent exactly once');
  // The safety property. Retrying re-runs a write that may already have run, so anything not
  // explicitly cleared as a no-op-on-replay must keep the old one-shot behavior.
  let calls = 0;
  const { enginePost, SAFE } = build(() => { calls++; return Promise.resolve(HTML_PAGE); });
  ok(!Object.prototype.hasOwnProperty.call(SAFE, 'somethingNew'),
     'the fixture action is genuinely unlisted (otherwise this proves nothing)');
  return enginePost('https://e/exec', { action: 'somethingNew' })
    .then(() => ok(false, 'must not resolve'), e => {
      ok(calls === 1, 'an unlisted write got ONE attempt, not a retry (' + calls + ')');
      ok(e && e.gxUnreachable === true, 'and still fails loudly rather than silently');
    })
    .then(() => {
      // Prototype members are not entries. `SAFE['toString']` is truthy on every object, and this
      // engine has already shipped that exact hole once — ?action=toString passed Code.gs's router.
      let c2 = 0;
      const { enginePost: ep } = build(() => { c2++; return Promise.resolve(HTML_PAGE); });
      return ep('https://e/exec', { action: 'toString' })
        .then(() => ok(false, 'must not resolve'), () => ok(c2 === 1, 'a prototype member is not a retry-safe action (' + c2 + ')'));
    });
});

const section3 = section2.then(() => {
  console.log('\n3. one door, and the one non-idempotent write is protected');
  // No seventh raw POST. enginePost owns the only fetch(..., {method:"POST"}) in the file; a new one
  // anywhere else is a write that skipped the dev guard, the token AND the retry.
  const posts = SRC.match(/method:\s*"POST"/g) || [];
  ok(posts.length === 1, 'exactly one raw POST remains in generator.js — the one inside enginePost (' + posts.length + ')');

  const body = (SRC.match(/function enginePost\(base, payload\)\s*\{[\s\S]*?\n  \}/) || [''])[0];
  ok(/gx\.postJSON\(/.test(body),
     'enginePost hands off to GXClient.postJSON the day gx-theme grows one, instead of owning this forever');
  ok(/window\.GXDev\.check\(action\)/.test(body) && /Promise\.reject\(e\)/.test(body),
     'the dev write-guard moved into the door, and its synchronous throw becomes a rejection callers can catch');

  // markPrinted appends an archive entry with a fresh UUID per call: the ONLY write here that a
  // replay would duplicate. It may only sit in POST_RETRY_SAFE while both halves of its dedup exist.
  ok(/action:"markPrinted"[^}]*subId:/.test(SRC),
     'the markPrinted call stamps a content-derived subId');
  ok(/function markPrinted_[\s\S]*?recent\[j\]\.subId === subId/.test(GAS),
     'and markPrinted_ in the engine replays that subId instead of archiving twice');
  ok(/mp:/.test(SRC),
     "markPrinted's ids are namespaced so they cannot collide with submitCards' in the shared store");

  // The bug reporter was never signed; it hit the doPost auth gate and came back needsAuth for a
  // perfectly signed-in user. It goes through the door now, and the door stamps the token.
  ok(/return enginePost\(endpoint, payload\)/.test(SRC),
     'the bug reporter posts through the door too, so its payload is actually signed');
});

/* ── 4. every attempt has a deadline, and a TIMED-OUT write is never re-sent ──────────────────────
 * A fetch that never answers used to leave "Sending…" up until the tab closed. The deadline fixes
 * that, and creates the hazard these cases guard: Apps Script finishes a request the browser gave up
 * on, so a re-sent timeout is a second write. The setTimeout injected by build() fires at once, so
 * the deadline expires immediately; a fetch stub that only settles when ABORTED therefore proves
 * the deadline really ends a hung request, rather than asserting a comment. */
function hangsUntilAborted(counter) {
  return (url, init) => { counter.n++; return new Promise((_, rej) => {
    const die = () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); };
    if (init && init.signal) { if (init.signal.aborted) die(); else init.signal.addEventListener('abort', die); }
  }); };
}
const section4 = section3.then(() => {
  console.log('\n4. a hung write ends, reports "may have saved", and is not re-sent');
  const c = { n: 0 };
  const { enginePost } = build(hangsUntilAborted(c));
  const raw = enginePost('https://e/exec', { action: 'submitCards', cards: [1], subId: 's' })
    .then(() => ok(false, 'a hung write must not resolve'), e => {
      ok(e && e.gxTimedOut === true && e.gxUnreachable === true, 'a hung raw POST is ended by its own deadline and tagged gxTimedOut');
      ok(c.n === 1, 'and a RETRY-SAFE action was still sent exactly once after timing out (' + c.n + ')');
    });

  // Through the shared client: the door must ask it for ONE attempt and own the replay decision,
  // because GXClient.postJSON retries a timeout like any other miss.
  const seen = [];
  const gxTimeout = () => ({ postJSON: (a, p, o) => { seen.push(o); return Promise.reject(new Error('GX postJSON "' + a + '" failed after 1 try: post timed out after 60000ms')); } });
  const { enginePost: epGx } = build(() => { throw new Error('raw fetch must not run when GXClient is loaded'); }, {}, gxTimeout);
  const viaGx = epGx('https://e/exec', { action: 'submitCards', cards: [1], subId: 's' })
    .then(() => ok(false, 'must not resolve'), e => {
      ok(seen.length === 1, 'a shared-client timeout is not re-sent (' + seen.length + ' call)');
      ok(seen[0] && seen[0].retries === 0 && seen[0].timeoutMs > 0, 'and the shared client is asked for exactly one bounded attempt');
      ok(e && e.gxTimedOut === true, 'and the caller can tell it apart from a refusal or a plain miss');
    });

  // The fast Drive-HTML miss keeps its retry through the shared client — the fix must not cost that.
  let g2 = 0;
  const gxMiss = () => ({ postJSON: () => { g2++; return g2 < 3 ? Promise.reject(new Error('non-JSON body (HTTP 200) — Drive HTML page')) : Promise.resolve({ ok: true }); } });
  const { enginePost: epMiss } = build(() => { throw new Error('unused'); }, {}, gxMiss);
  const miss = epMiss('https://e/exec', { action: 'submitCards', cards: [1], subId: 's' })
    .then(d => ok(d && d.ok === true && g2 === 3, 'an HTML miss through the shared client still retries to success (' + g2 + ' attempts)'));

  return Promise.all([raw, viaGx, miss]).then(() => {
    // No retry may START once the engine's 90s replay window could have closed behind it.
    const realNow = Date.now; let clock = 1e12, n = 0;
    Date.now = () => clock;
    const { enginePost: epSlow, BUDGET } = build(() => { n++; clock += BUDGET + 1; return Promise.resolve(HTML_PAGE); });
    return epSlow('https://e/exec', { action: 'submitCards', cards: [1], subId: 's' })
      .then(() => ok(false, 'must not resolve'), e => {
        ok(n === 1, 'a miss that arrives after the replay budget is NOT retried (' + n + ' attempt)');
        ok(e && e.gxUnreachable === true && !e.gxTimedOut, 'and fails as unreachable, not as a timeout');
      })
      .then(() => { Date.now = realNow; }, err => { Date.now = realNow; throw err; });
  });
});

const section5 = section4.then(() => {
  console.log('\n5. no fetch in this app can wait forever');
  const c = { n: 0 };
  const { boundedRead } = build(hangsUntilAborted(c));
  return boundedRead('style/tags.json').then(() => ok(false, 'a hung read must not resolve'),
    e => ok(/timed out/.test(String(e && e.message)), 'boundedRead ends a hung read with a timeout error'))
    .then(() => {
      // Exactly two fetch( calls in the file: enginePost's bounded attempt and boundedRead. A third is
      // a new call site that skipped both deadlines.
      const calls = SRC.match(/\bfetch\(/g) || [];
      ok(calls.length === 2, 'generator.js has exactly two fetch( calls, both inside a deadline (' + calls.length + ')');
    });
});

section5.then(() => {
  console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' : 'PASSED all ') + (pass + fail) + ' assertions');
  process.exit(fail ? 1 : 0);
});
