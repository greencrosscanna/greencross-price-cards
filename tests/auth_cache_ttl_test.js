#!/usr/bin/env node
/* The two verification caches — WRITE_CACHE_TTL_S / READ_CACHE_TTL_S in apps-script/Code.gs.
 *
 * WHY THIS EXISTS
 * GX Core's request telemetry (2026-09-03) showed this app was its second-largest caller: the
 * `verify` route was 27% of ALL traffic reaching GX Core in a measured hour, and Price Cards
 * accounted for essentially all of it. requireRead_ calls gxAuthRead_ on every read whether or not
 * read-enforcement is on, so a 60s cache meant one Core round trip per user per minute, all day,
 * per store screen.
 *
 * The read TTL was raised to 300s for that. The WRITE TTL was deliberately NOT touched, and that is
 * the thing this file mainly guards: it sat at 300s once, was cut to 60s because that was far too
 * generous for the side that mutates shared state, and core-admin's actual ruling was to leave
 * writes uncached entirely. 60s there is already a concession. Someone chasing load later will find
 * WRITE_CACHE_TTL_S sitting next to a number that just got raised, and the obvious "make it match"
 * edit would quietly undo a security decision. This test is the thing that says no.
 *
 * The asymmetry is the design, not an oversight:
 *   · a stale READ answer buys a revoked account up to five minutes of looking at price cards a
 *     viewer could look at anyway;
 *   · a stale WRITE answer lets them change something.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'apps-script', 'Code.gs');
const src = fs.readFileSync(SRC, 'utf8');

let pass = 0, fail = 0;
const ok = (m, c) => { c ? (pass++, console.log('  ok   ' + m)) : (fail++, console.log('  FAIL ' + m)); };

const num = (name) => {
  const m = new RegExp('var ' + name + '\\s*=\\s*(\\d+)\\s*;').exec(src);
  return m ? Number(m[1]) : null;
};

const WRITE = num('WRITE_CACHE_TTL_S');
const READ = num('READ_CACHE_TTL_S');

console.log('\nVerification cache TTLs');

ok(`both constants still exist (write=${WRITE}, read=${READ})`, WRITE !== null && READ !== null);

/* THE ONE THAT MATTERS. */
ok(`the WRITE cache is still 60s (found ${WRITE})`, WRITE === 60);
ok('the write TTL is not raised to chase load — core-admin ruled for uncached writes; 60s is already the concession',
   WRITE <= 60);

/* The read side is allowed to be longer, but not unbounded. */
ok(`the READ cache is longer than the write cache (${READ}s vs ${WRITE}s)`, READ > WRITE);
ok(`the READ cache is at most 5 minutes (found ${READ}s)`, READ <= 300);

/* They must not be collapsed into one value or one namespace. The comment in the source says the two
   caches are "deliberately NOT shared"; a single shared entry would let a cached READ answer stand in
   for a write check, which is the exact failure requireWrite_/requireRead_ were split to prevent. */
ok('the two caches use different namespaces', /gxVerify_\(token, 'pcw'/.test(src) && /gxVerify_\(token, 'pcr'/.test(src));
ok('read and write gates are still separate functions',
   /function requireWrite_\(/.test(src) && /function requireRead_\(/.test(src));

/* Only successes may be cached. Caching a failure would turn a blip in GX Core — which has
   intermittent /exec bad spells — into minutes of locked-out managers. */
ok('only successful verifications are cached', /if \(out && out\.ok\) cache\.put\(/.test(src));

/* The cache key must stay a digest. It is not a place to park credentials. */
ok('the cache is keyed on a digest of the token, never the raw token',
   /computeDigest\(Utilities\.DigestAlgorithm\.SHA_256, String\(token\)\)/.test(src));

/* An absent token must short-circuit before any network call — otherwise every anonymous read would
   still cost a GX Core round trip, which is the load this change is about. */
ok('a missing token is refused without calling GX Core',
   /if \(!token\) return \{ ok: false, error: 'Not signed in'/.test(src));

/* The reasoning has to survive in the file, or the next person re-tunes it blind.
   Matched against whitespace-NORMALIZED source: these sentences are wrapped inside a block comment,
   so a single-line regex fails on where the line happens to break rather than on whether the
   reasoning is there. */
const prose = src.replace(/\s+/g, ' ');
ok('the source records WHY the write TTL is not a tuning knob',
   /not a number to tune for load/i.test(prose));
ok('and why reads can afford a longer window',
   /cannot mutate shared state|a viewer may read/i.test(prose));
ok('and that sessions themselves last far longer than either cache',
   /SEVEN DAYS|GX_SESSION_TTL_MS/i.test(prose));

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
