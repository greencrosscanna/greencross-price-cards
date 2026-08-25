#!/usr/bin/env node
/* ─── live-price fallback + engineGet transport — tests ───────────────────────────────────────────
 *
 *   RUN:  node tests/live_price_fallback_test.js   (from the repo root; no deps, no network, no DOM)
 *
 * WHY THESE
 * The engine is an Apps Script web app, so its /exec URL is the same two-hop redirect GX Core's is,
 * and the second hop intermittently serves Google's "unable to open the file" HTML page instead of
 * JSON (~6% of rapid calls). engineGet used to be a single raw fetch. One miss rejected liveCatalog,
 * and the card builder fell through to the style/catalog.json TEMPLATE prices — which look exactly
 * like live ones in the results list. Staff printed shelf cards at stale prices and nothing on the
 * page appeared broken. That is the failure this file exists to keep fixed.
 *
 * WHAT IS TESTED WHERE
 * The retry itself is gx-theme's GXClient and is tested there; this repo must not grow a second copy
 * of it, so §3 asserts engineGet routes through the shared client rather than asserting retry counts.
 * §1 runs the real decision function. §2 covers the dev-guard list, which throws rather than warns.
 *
 * §1 IS A REAL BEHAVIOUR TEST, NOT A STRING MATCH. generator.js is one IIFE with no module boundary,
 * and standing up a DOM shim big enough to load 100KB of app code would test the shim. Instead the
 * decision function is sentinel-delimited in the source (`@test-slice priceIndexFor_`) and sliced out
 * and evaluated here — so this exercises the exact bytes that ship, and deleting the sentinels breaks
 * the test loudly instead of silently skipping it.
 */
'use strict';
const fs = require('fs');

const SRC  = fs.readFileSync(__dirname + '/../generator.js', 'utf8');
const HTML = fs.readFileSync(__dirname + '/../index.html',   'utf8');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } };

/* ── slice the real function out of the real file ───────────────────────────────────────────── */
// From the END of the opening sentinel comment (its `*/`) to the closing sentinel — i.e. the code
// between them and nothing else. Anchoring on the newline instead would start the slice inside the
// still-open comment block and fail to parse.
const m = SRC.match(/@test-slice priceIndexFor_[\s\S]*?\*\/\s*([\s\S]*?)\/\* ── @test-slice end/);
if (!m) {
  console.error('LOAD FAILED: the `@test-slice priceIndexFor_` sentinels are gone from generator.js.');
  console.error('Do not delete the test rather than the sentinels — restore them around priceIndexFor_.');
  process.exit(2);
}
let priceIndexFor_;
try {
  priceIndexFor_ = new Function(m[1] + '\n; return priceIndexFor_;')();
} catch (e) {
  console.error('LOAD FAILED: the sliced region did not evaluate — ' + e.message);
  process.exit(2);
}

const LIVE = [{ brand: 'Wyld', price: '18' }];
const TPL  = [{ brand: 'Wyld', price: '25' }];   // the stale template price, deliberately different

console.log('\n1. priceIndexFor_ — which prices the card builder may search');
{
  ok(priceIndexFor_({ liveReady: true, liveFailed: false, liveIndex: LIVE, catalogIndex: TPL }) === LIVE,
     'live data loaded -> the live index');

  // The bug. "No engine configured" and "engine unreachable" both leave liveReady false, and the old
  // code could not tell them apart, so both got template prices.
  const down = priceIndexFor_({ liveReady: false, liveFailed: true, liveIndex: [], catalogIndex: TPL });
  ok(Array.isArray(down) && down.length === 0,
     'engine configured but UNREACHABLE -> empty, never the template index');
  ok(down !== TPL,
     'and specifically not the stale template prices that would get printed on a shelf card');

  ok(priceIndexFor_({ liveReady: false, liveFailed: false, liveIndex: [], catalogIndex: TPL }) === TPL,
     'no engine configured at all -> templates, which IS the intended mode there');

  // A retry that eventually succeeds must fully clear the failure state, not leave search paused.
  ok(priceIndexFor_({ liveReady: true, liveFailed: false, liveIndex: LIVE, catalogIndex: TPL }) === LIVE,
     'a successful Retry restores live search');

  // Guard the degenerate case: liveReady with an empty index is not usable data.
  ok(priceIndexFor_({ liveReady: true, liveFailed: false, liveIndex: [], catalogIndex: TPL }) === TPL,
     'liveReady but an EMPTY live index still falls back rather than showing nothing');
}

console.log('\n2. every engineGet action is declared in GX_DEV_READS');
{
  // GXClient.getJSON calls GXDev.check(action), and check() THROWS on an undeclared action. On
  // localhost an action missing from this list is not a warning — it is a dead button. This caught
  // `grid`, which had never needed declaring while engineGet hand-rolled its own fetch.
  const declared = (HTML.match(/GX_DEV_READS\s*=\s*\[([\s\S]*?)\]/) || [, ''])[1]
    .split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  const used = [...SRC.matchAll(/engineGet\([^,]+,\s*["']action=([A-Za-z0-9_]+)/g)].map(x => x[1]);
  ok(used.length >= 6, 'found the engineGet read call sites (' + used.length + ')');
  const missing = [...new Set(used)].filter(a => declared.indexOf(a) < 0);
  ok(missing.length === 0, 'no engineGet action is missing from GX_DEV_READS' +
     (missing.length ? ' — missing: ' + missing.join(', ') : ''));
}

console.log('\n3. engineGet transport — shared retry, not a sixth hand-rolled one');
{
  const body = (SRC.match(/function engineGet\(base, query\)\s*\{[\s\S]*?\n  \}/) || [''])[0];
  ok(/GXClient\(base\)\.getJSON\(/.test(body),
     'engineGet routes through the shared GXClient (which carries the two-hop retry)');
  ok(/gxUnreachable\s*=\s*true/.test(body),
     'an exhausted retry is tagged gxUnreachable so callers can tell it from a refusal');
  // A rejection handler passed as then()'s SECOND argument sees transport failures only. Written as
  // .catch() it would also swallow the auth refusal thrown just above it, turning a "please sign in"
  // into "Google is down" and re-showing the search box to someone who has no session.
  ok(/\}, function \(e\) \{/.test(body),
     'the unreachable tag is a then(onOk, onErr) handler, so an auth refusal is not mislabelled');
  ok(!/for\s*\(|while\s*\(|setTimeout\([^)]*retr/i.test(body),
     'no bespoke retry loop was hand-rolled here alongside the shared one');

  const live = (SRC.match(/function fetchLive\(store\)\{[\s\S]*?\n  \}/) || [''])[0];
  ok(/STYLE\.liveFailed = true/.test(live) && /showLiveAlert\(/.test(live),
     'fetchLive surfaces an exhausted retry loudly instead of switching to template prices');
  // Comments stripped first: the code comment there NAMES the old message in order to explain why it
  // went away, and matching prose about a hazard is how a check starts crying wolf.
  const liveCode = live.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!/setSource\([^)]*"tpl"\s*\)/.test(liveCode.split('.catch(')[1] || ''),
     'the failure path no longer presents as the benign "tpl" (template-prices) source state');
}

console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' : 'PASSED all ') + (pass + fail) + ' assertions');
process.exit(fail ? 1 : 0);
