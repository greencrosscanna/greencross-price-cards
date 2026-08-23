#!/usr/bin/env node
/* ─── submitCards_ idempotency — tests ────────────────────────────────────────────────────────────
 *
 *   RUN:  node tests/submit_dedup_test.js   (from the repo root; no deps, no network, no credentials)
 *
 * WHY THESE
 * "Send it to print" POSTs through /exec's second hop and takes seconds. Staff read the silence as a
 * dead button and tap again — and before the subId guard, every tap appended another copy of the same
 * cards to the shared queue. Tawny then printed the duplicate.
 *
 * The client guard (a _submitting flag) is not enough on its own and is not what these cover: it dies
 * with a reload, and it cannot help a retry whose FIRST response was merely lost in transit. The
 * engine has to be the one that decides, which is what submitCards_ now does.
 *
 * The four properties that must hold, and the two that are easy to get wrong:
 *   - a repeat subId inside the window appends NOTHING          (the bug)
 *   - a DIFFERENT batch still queues                            (over-dedup would eat real work)
 *   - the same cards after the window still queue               (a reprint next week is legitimate)
 *   - no subId at all still queues                              (an older cached client must not break)
 *
 * Loads the real apps-script/Code.gs with Apps Script globals stubbed, against a live in-memory
 * PropertiesService so the queue and the dedup ledger actually round-trip.
 * Cannot reach Apps Script: .claspignore excludes tests/.
 */
'use strict';
const fs = require('fs');

let NOW = 1_700_000_000_000;                 // frozen clock; tests advance it deliberately
let uuidN = 0;
const store = {};                            // the in-memory ScriptProperties

const stubs = {
  SpreadsheetApp:{}, DriveApp:{}, UrlFetchApp:{}, HtmlService:{}, ContentService:{},
  CacheService:{ getScriptCache: () => ({ get: () => null, put(){}, remove(){} }) },
  MailApp:{}, GmailApp:{}, ScriptApp:{}, Session:{}, Logger:{log(){}},
  Utilities:{ getUuid: () => 'uuid-' + (++uuidN), formatDate: () => '2026-08-22',
              computeDigest: () => [1,2,3], base64Encode: () => 'AAA', DigestAlgorithm:{SHA_256:'x'} },
  LockService:{ getScriptLock: () => ({ waitLock(){}, releaseLock(){} }) },
  PropertiesService:{ getScriptProperties: () => ({
    getProperty: (k) => (k in store ? store[k] : null),
    setProperty(k, v){ store[k] = String(v); },
  }) },
  Date: class extends Date {                 // freeze both Date.now() and new Date()
    constructor(...a){ super(...(a.length ? a : [NOW])); }
    static now(){ return NOW; }
  },
};
const names = Object.keys(stubs);
let P;
try {
  P = new Function(...names, fs.readFileSync(__dirname + '/../apps-script/Code.gs','utf8') +
    '\n; return { submitCards_, readQueue_, writeQueue_, SUBMIT_DEDUP_MS, SUBMIT_DEDUP_CAP, readSubmits_ };'
  )(...names.map(n=>stubs[n]));
} catch (e) {
  console.error('LOAD FAILED: Code.gs did not evaluate under stubs — ' + e.message);
  process.exit(1);
}

let pass = 0, fail = 0;
function ok(label, cond){ if(cond){ pass++; console.log('  PASS  ' + label); }
                          else     { fail++; console.log('  FAIL  ' + label); } }
function reset(){ for (const k of Object.keys(store)) delete store[k]; uuidN = 0; }
function qlen(){ return P.readQueue_().length; }

const CARD_A = { brand:'Wyld', item:'Gummies', price:'18', store:'river-rd' };
const CARD_B = { brand:'Grön',  item:'Chews',   price:'22', store:'century' };

console.log('\n1. The bug: a re-tap of the same batch must not queue a second copy');
reset();
const first = P.submitCards_({ cards:[CARD_A], subId:'abc-123' });
ok('the first submit queues the card', first.ok && first.added === 1 && qlen() === 1);
const again = P.submitCards_({ cards:[CARD_A], subId:'abc-123' });
ok('the second tap appends NOTHING', qlen() === 1);
ok('and is reported as a duplicate, not an error', again.ok === true && again.duplicate === true);
ok('replaying the original added count keeps the UI message honest', again.added === 1);
ok('count reflects the real queue, not a stale echo', again.count === 1);

console.log('\n2. A third and fourth tap are still absorbed (staff tap more than twice)');
P.submitCards_({ cards:[CARD_A], subId:'abc-123' });
P.submitCards_({ cards:[CARD_A], subId:'abc-123' });
ok('queue is still 1 after four taps total', qlen() === 1);

console.log('\n3. Over-dedup would be worse than the bug — real work must still queue');
reset();
P.submitCards_({ cards:[CARD_A], subId:'key-a' });
P.submitCards_({ cards:[CARD_B], subId:'key-b' });
ok('a genuinely different batch queues', qlen() === 2);
reset();
P.submitCards_({ cards:[CARD_A, CARD_B], subId:'multi' });
ok('a multi-card batch queues every card', qlen() === 2);
const dupMulti = P.submitCards_({ cards:[CARD_A, CARD_B], subId:'multi' });
ok('and a re-tap of it adds none of them', qlen() === 2 && dupMulti.duplicate === true);
ok('while still replaying the full added count', dupMulti.added === 2);

console.log('\n4. It is a window, not a ledger — a legitimate reprint later must go through');
reset();
P.submitCards_({ cards:[CARD_A], subId:'same-card' });
NOW += P.SUBMIT_DEDUP_MS + 1000;                     // next week, or just past the window
P.submitCards_({ cards:[CARD_A], subId:'same-card' });
ok('the identical card queues again once the window has passed', qlen() === 2);
NOW -= P.SUBMIT_DEDUP_MS + 1000;

console.log('\n5. An older cached client sends no subId — it must still work');
reset();
P.submitCards_({ cards:[CARD_A] });
P.submitCards_({ cards:[CARD_A] });
ok('two un-keyed submits both queue (undeduped, but never refused)', qlen() === 2);
ok('an empty-string subId is treated as absent, not as a key', 
   (reset(), P.submitCards_({ cards:[CARD_A], subId:'' }),
             P.submitCards_({ cards:[CARD_A], subId:'' }), qlen() === 2));

console.log('\n6. Guards that were already there stay there');
reset();
const none = P.submitCards_({ cards:[] });
ok('an empty batch is refused before any dedup work', none.ok === false && none.error === 'no-cards');
ok('and a missing body does not throw', P.submitCards_(null).ok === false);

console.log('\n7. The dedup ledger cannot grow without bound');
reset();
for (let i = 0; i < P.SUBMIT_DEDUP_CAP + 25; i++) P.submitCards_({ cards:[CARD_A], subId:'k-'+i });
ok('records are capped', P.readSubmits_().length <= P.SUBMIT_DEDUP_CAP);
ok('the cap keeps the NEWEST keys, so a fresh re-tap is still caught',
   (P.submitCards_({ cards:[CARD_A], subId:'k-'+(P.SUBMIT_DEDUP_CAP+24) }).duplicate === true));
ok('expired records are pruned, not merely capped',
   (reset(), P.submitCards_({ cards:[CARD_A], subId:'old' }),
             NOW += P.SUBMIT_DEDUP_MS + 1,
             P.submitCards_({ cards:[CARD_B], subId:'new' }),
             P.readSubmits_().every(r => r.subId !== 'old')));

console.log('\n──────────────────────────────');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
