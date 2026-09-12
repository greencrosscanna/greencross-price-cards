#!/usr/bin/env node
/* ─── background polling stops while the tab is hidden — tests ─────────────────────────────────────
 *
 *   RUN:  node tests/poll_visibility_test.js   (repo root; no deps, no network, no DOM)
 *
 * WHY THIS EXISTS
 * Price Cards opens three background polls per tab — the shared queue every 30s, printed sheets every
 * 60s, new-in-Dutchie products every 120s. That is ~210 backend calls an hour, per open tab, for as
 * long as the tab exists. Sky's own reading of this app is that it is hardly used, which makes the
 * forgotten tab on a shop iPad the NORMAL case, not the edge case: measured 2026-09-11, Price Cards
 * was 51% of all traffic reaching GX Core (3,662 calls in 24h) and most of it came off screens nobody
 * was in front of. v1.437 pauses the polls while `document.hidden` is true and refreshes once on
 * return.
 *
 * WHAT EACH ASSERTION IS PINNED AGAINST — the fixture that makes it FAIL, named, because an assertion
 * with no such fixture is measuring the fixture and not the code:
 *
 *   §0  the code as it stood at ddf6872: pcStart handed the RAW refresh functions to setInterval, so
 *       the source check for an unguarded schedule fails, and the slice it needs does not exist.
 *   §1  that same old code: a hidden tab's ticks each call the backend — the counter reads 3, not 0.
 *   §2  a fix that only guards the ticks and never listens for `visibilitychange`: a tab hidden for
 *       hours shows hours-old counts, and the return refresh count stays 0.
 *   §3  a fix that clears the intervals while hidden and re-creates them on return: the tick after
 *       the return no longer fires on the ORIGINAL cadence, and §3's visible-tab ticks go missing.
 *   §4  dropping POLL_MIN_GAP: the visibility refresh and a tick landing in the same instant both
 *       fetch, and one screen coming back costs two of every call.
 *   §5  refreshing on EVERY visibilitychange rather than on becoming visible: going away fetches.
 *   §6  a poll list that forgets one of the three: that one keeps polling hidden, or never returns.
 *   §7  moving the listener registration out of pollStart_ to load time: the sign-in screen fetches.
 *
 * §1-§6 run the REAL scheduler, sliced out of generator.js at `@test-slice pollPause` and evaluated
 * with document/setInterval/Date and the three refresh functions injected — generator.js is one IIFE
 * with no module boundary, and a DOM shim big enough to load 130KB of app code would only test the
 * shim. §0 and §7 assert shape against the source text, which is the only place "nobody scheduled a
 * raw poll" can be checked.
 */
'use strict';
const fs = require('fs');

const SRC = fs.readFileSync(__dirname + '/../generator.js', 'utf8');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } };

/* ═══ 0. no poll is scheduled around the guard ═══════════════════════════════════════════════════ */
console.log('\n0. every background poll goes through the guard');
{
  // At ddf6872 all three of these are present, and each one is a tab that polls while nobody looks.
  const raw = ['refreshQueueCount', 'refreshNewProducts', 'refreshPrinted']
    .filter(fn => new RegExp('setInterval\\s*\\(\\s*' + fn + '\\b').test(SRC));
  ok(raw.length === 0,
     'no setInterval is handed a raw refresh function' + (raw.length ? ' — found: ' + raw.join(', ') : ''));

  // A fourth poll added later must join the guarded set rather than open its own hole.
  const intervals = SRC.match(/setInterval\s*\(\s*([A-Za-z0-9_$.]+)/g) || [];
  const unguarded = intervals.filter(m => !/poll[A-Za-z]*_/.test(m));
  ok(unguarded.length === 0,
     'and every setInterval in the file takes a poll* guard' +
     (unguarded.length ? ' — found: ' + unguarded.join(' | ') : ''));
}

/* ── slice the real scheduler out of the real file ──────────────────────────────────────────────── */
const m = SRC.match(/@test-slice pollPause[\s\S]*?\*\/\s*([\s\S]*?)\/\* ── @test-slice end/);
if (!m) {
  console.error('\nLOAD FAILED: the `@test-slice pollPause` sentinels are gone from generator.js.');
  console.error('Do not delete the test rather than the sentinels — restore them around pollStart_.');
  process.exit(2);
}

/* A fresh world per scenario. Shared state between scenarios is how a test starts passing for the
   previous scenario's reasons. */
function world() {
  const calls = { queue: 0, newprod: 0, printed: 0 };
  const timers = [];       // [{ fn, ms }] — the intervals the code actually asked for
  const listeners = {};    // event name -> handler
  let now = 1000000;

  const doc = {
    hidden: false,
    addEventListener(ev, fn) { listeners[ev] = fn; }
  };
  const P = new Function('document', 'setInterval', 'Date',
                         'refreshQueueCount', 'refreshNewProducts', 'refreshPrinted',
                         m[1] + '\n; return { pollStart_, pollAll_, pollQueue_, pollNewProd_,' +
                                ' pollPrinted_, POLL_MIN_GAP };')(
    doc,
    (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    { now: () => now },
    () => { calls.queue++; }, () => { calls.newprod++; }, () => { calls.printed++; }
  );

  return {
    P, calls, timers, doc,
    at: (t) => { now = t; },
    advance: (ms) => { now += ms; },
    // Fire every registered interval once, as a browser would at its period.
    tickAll: () => timers.forEach(t => t.fn()),
    tick: (ms) => timers.filter(t => t.ms === ms).forEach(t => t.fn()),
    hide: () => { doc.hidden = true; if (listeners.visibilitychange) listeners.visibilitychange(); },
    show: () => { doc.hidden = false; if (listeners.visibilitychange) listeners.visibilitychange(); },
    // A visibilitychange with no state change — what a badly-written listener also reacts to.
    fireVisibility: () => { if (listeners.visibilitychange) listeners.visibilitychange(); },
    hasListener: () => !!listeners.visibilitychange,
    total: () => calls.queue + calls.newprod + calls.printed
  };
}

/* ═══ 1. a hidden tab pays nothing ═══════════════════════════════════════════════════════════════ */
console.log('\n1. tab hidden — the ticks make no backend call at all');
{
  const w = world();
  w.P.pollStart_();                       // visible at start: the initial refresh is the normal one
  const afterStart = w.total();
  ok(afterStart === 3, 'a visible start refreshes all three once (' + afterStart + ')');

  w.hide();
  const atHide = w.total();
  w.advance(60000); w.tickAll();          // an hour of this is the real cost; one round is enough
  w.advance(60000); w.tickAll();
  w.advance(60000); w.tickAll();

  // THE ONE THAT MATTERS. At ddf6872 this is 9 — three ticks x three polls, all of them fetching.
  ok(w.total() === atHide, 'three rounds of ticks while hidden: 0 new calls (' + (w.total() - atHide) + ')');
  ok(w.timers.length === 3, 'and the intervals were never torn down — still 3 (' + w.timers.length + ')');
}

/* ═══ 2. coming back refreshes once, immediately ═════════════════════════════════════════════════ */
console.log('\n2. tab becomes visible — one immediate refresh of each, not a two-minute wait');
{
  const w = world();
  w.P.pollStart_();
  w.hide();
  w.advance(4 * 60 * 60 * 1000);          // hidden for four hours
  w.tickAll();
  const before = { ...w.calls };

  w.show();
  ok(w.calls.queue   - before.queue   === 1, 'the queue count refreshed exactly once');
  ok(w.calls.newprod - before.newprod === 1, 'new products refreshed exactly once');
  ok(w.calls.printed - before.printed === 1, 'printed sheets refreshed exactly once');
}

/* ═══ 3. a visible tab still polls on its normal cadence ═════════════════════════════════════════ */
console.log('\n3. tab visible — nothing changes for someone actually using the page');
{
  const w = world();
  w.P.pollStart_();
  const cadences = w.timers.map(t => t.ms).sort((a, b) => a - b);
  ok(JSON.stringify(cadences) === JSON.stringify([30000, 60000, 120000]),
     'the three cadences are unchanged: 30s / 60s / 120s (' + cadences.join(', ') + ')');

  const before = { ...w.calls };
  w.advance(30000);  w.tick(30000);
  w.advance(30000);  w.tick(30000); w.tick(60000);
  w.advance(60000);  w.tick(30000); w.tick(60000); w.tick(120000);
  ok(w.calls.queue   - before.queue   === 3, 'the 30s poll ran all 3 times (' + (w.calls.queue - before.queue) + ')');
  ok(w.calls.printed - before.printed === 2, 'the 60s poll ran both times (' + (w.calls.printed - before.printed) + ')');
  ok(w.calls.newprod - before.newprod === 1, 'the 120s poll ran once (' + (w.calls.newprod - before.newprod) + ')');
}

/* ═══ 4. the return refresh and a scheduled tick in the same instant are ONE refresh ═════════════ */
console.log('\n4. a tick landing on the moment of return does not double the round trip');
{
  const w = world();
  w.P.pollStart_();
  w.hide();
  w.advance(30000);
  const before = { ...w.calls };

  w.show();                               // the immediate refresh
  w.tickAll();                            // …and the browser's own tick, same millisecond

  ok(w.calls.queue   - before.queue   === 1, 'queue fetched once, not twice (' + (w.calls.queue - before.queue) + ')');
  ok(w.calls.newprod - before.newprod === 1, 'new products once (' + (w.calls.newprod - before.newprod) + ')');
  ok(w.calls.printed - before.printed === 1, 'printed once (' + (w.calls.printed - before.printed) + ')');

  // And the damping window is short enough that it never swallows a real poll: the next 30s tick runs.
  w.advance(w.P.POLL_MIN_GAP + 1);
  w.tick(30000);
  ok(w.calls.queue - before.queue === 2, 'the next real tick is not swallowed by the gap');
  ok(w.P.POLL_MIN_GAP < 30000, 'the gap is far shorter than the fastest cadence (' + w.P.POLL_MIN_GAP + 'ms)');
}

/* ═══ 5. going AWAY must not fetch ═══════════════════════════════════════════════════════════════ */
console.log('\n5. the listener reacts to becoming visible, not to any visibility change');
{
  const w = world();
  w.P.pollStart_();
  w.advance(10000);
  const before = w.total();
  w.hide();                               // a visibilitychange whose new state is hidden
  ok(w.total() === before, 'hiding the tab fetches nothing (' + (w.total() - before) + ')');
}

/* ═══ 6. all three are covered, individually ═════════════════════════════════════════════════════ */
console.log('\n6. every one of the three polls is guarded, none left behind');
{
  [['pollQueue_', 'queue'], ['pollNewProd_', 'newprod'], ['pollPrinted_', 'printed']].forEach(([fn, key]) => {
    const w = world();
    w.doc.hidden = true;
    w.P[fn]();
    ok(w.calls[key] === 0, fn + ' is a no-op while hidden');
    w.doc.hidden = false;
    w.advance(w.P.POLL_MIN_GAP + 1);
    w.P[fn]();
    ok(w.calls[key] === 1, fn + ' fetches when visible');
  });
}

/* ═══ 7. nothing is wired up before sign-in ══════════════════════════════════════════════════════ */
console.log('\n7. the visibility listener lives behind the sign-in gate');
{
  const w = world();
  ok(w.hasListener() === false, 'evaluating the block registers no listener on its own');
  w.P.pollStart_();
  ok(w.hasListener() === true, 'pollStart_ is what registers it');

  // pcStart is the function that runs only once there is a session; the listener must be reached
  // from there and nowhere else. A listener attached at load would let the SIGN-IN screen fetch the
  // shared queue from a page that has no session — the exact thing pcStart's own comment forbids.
  const pcStart = SRC.slice(SRC.indexOf('function pcStart(){'));
  ok(/pollStart_\(\)/.test(pcStart.slice(0, pcStart.indexOf('\n  }'))),
     'and pcStart is the caller');
  const registrations = (SRC.match(/addEventListener\(\s*["']visibilitychange["']/g) || []).length;
  ok(registrations === 1, 'exactly one visibilitychange registration in the file (' + registrations + ')');
}

console.log('\n──────────────────────────────');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
