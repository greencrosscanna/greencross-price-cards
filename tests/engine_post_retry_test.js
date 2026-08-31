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
function build(fetchImpl, windowImpl) {
  return new Function('window', 'fetch', 'pcSign', 'GXClient', 'setTimeout',
                      m[1] + '\n; return { enginePost: enginePost, SAFE: POST_RETRY_SAFE, RETRIES: POST_RETRIES };')(
    windowImpl || {}, fetchImpl, (p) => p, undefined,
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

section3.then(() => {
  console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' : 'PASSED all ') + (pass + fail) + ' assertions');
  process.exit(fail ? 1 : 0);
});
