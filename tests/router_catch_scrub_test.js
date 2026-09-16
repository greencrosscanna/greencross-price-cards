#!/usr/bin/env node
/* ─── the router's catch must not print a credential ─────────────────────────────────────────────
 *
 *   RUN:  node tests/router_catch_scrub_test.js   (repo root; no deps, no network, no credentials)
 *
 * WHY THIS EXISTS
 * When a UrlFetchApp call fails at the network layer, Google's exception message is
 * "Address unavailable: <the whole URL>", query string and all. Price Cards reaches GX Core over
 * HTTP on purpose — it binds no library — so the URLs it builds carry `secret=` (GX_DEPLOY_SECRET,
 * on every dutchie_* proxy call and on ingest_bug) and `token=` (the caller's own session, on
 * verify). doGet and doPost each ended with `return json({ ok:false, error: String(err) })`, which
 * handed that message, unscrubbed, to the browser: a live deploy secret in an error banner on a
 * shop iPad. Reported by core-admin 2026-09-16; both catches confirmed present in this file before
 * anything was changed.
 *
 * WHAT MAKES EACH ASSERTION FAIL — named, because an assertion with no such fixture is measuring
 * its fixture and not the code:
 *
 *   §1  removing scrubSecrets_ from json(): a real Address-unavailable throw out of
 *       ?action=dutchieProbe reaches doGet's catch and the deploy secret is in the reply.
 *   §2  removing scrubSecrets_ from the ROUTER CATCH ITSELF. This one is read off the SOURCE of
 *       doGet and doPost, sliced to those two functions, because the behavioral checks are covered
 *       twice over (the catch scrubs, and json() scrubs again on the way out) and so cannot see
 *       one of the two go missing. SPIFF's first version of this test grepped the WHOLE FILE for
 *       the scrub, matched an occurrence inside a different function, and went green over a catch
 *       it never opened — hence the slice, and hence §1 executing the catch for real.
 *   §3  the errors map liveCatalog_ RETURNS: a per-store failure never passes through doGet's
 *       catch at all, so a catch-only fix leaves it leaking.
 *   §4  reportBug_'s "GX Core could not be reached" — the ingest_bug URL carries the deploy secret,
 *       and that string is returned to the reporter AND printed in the unfiled-report email.
 *   §5  gxCoreGetJson_'s "fetch failed" — that URL carries the CALLER'S session token, quoted
 *       verbatim into the refusal the browser shows.
 *   §6  anchoring the regex at the start of the parameter name: crew's
 *       /([?&](?:secret|token|…)=)/ walks straight past connector_secret= because of the
 *       underscore in front of it.
 *   §7  letting the scrub's name list drift from the names the auth code actually accepts. Three of
 *       the four spokes that shipped this fix first leak a parameter their own auth takes, because
 *       the check and the regex were two hand-maintained lists.
 *   §7b REMOVING a name from that list. §7 reads the names off the implementation, so it cannot see
 *       a deletion — it just checks one name fewer and passes, which is how core-admin's first
 *       version of this test went 23 of 23 with `session` deleted from the source. §7b hardcodes
 *       the floor here, where the code under test cannot reach it. A test may not take its facts
 *       from the thing it is checking.
 *   §8  a scrub that eats the whole message: the parameter names and the action have to survive or
 *       nobody can debug a real outage from the reply.
 *
 * Loads the real apps-script/Code.gs with Apps Script globals stubbed, so what is under test is the
 * shipped function and not a paraphrase of it. Cannot reach Apps Script: .claspignore excludes tests/.
 */
'use strict';
const fs = require('fs');

const SRC = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');

/* The two credentials that must never appear in a reply. Distinctive on purpose: a substring search
   for these is the assertion, and a generic value could match something innocent. */
/* Both of these are INVENTED, exist only in this file, and open nothing — the marker below is what
   gx-preflight reads to tell a fixture apart from a real credential, and it blocked the push until
   it was there, which is the gate working. */
const SECRET = 'pc-deploy-secret-4a9f7c2e';   // @notasecret
const TOKEN  = 'sess-token-11b3ee90';         // @notasecret

function world(opts) {
  opts = opts || {};
  const props = Object.assign({ GX_DEPLOY_SECRET: SECRET }, opts.props || {});
  const cache = new Map();
  const sent = [];           // replies, as the strings ContentService would serve
  const mail = [];
  const fetches = [];

  /* Every fetch is answered by the scenario. `throwOn` names the substring of the URL that should
     blow up the way Google blows up — with the URL in the message, which is the entire hazard. */
  function fetchStub(url) {
    fetches.push(url);
    if (opts.throwOn && String(url).indexOf(opts.throwOn) !== -1) {
      throw new Error('Address unavailable: ' + url);
    }
    const body = opts.reply ? opts.reply(url) : { ok: true };
    return { getContentText: () => JSON.stringify(body), getResponseCode: () => 200 };
  }

  const stubs = {
    SpreadsheetApp: opts.SpreadsheetApp || {},
    DriveApp: {}, HtmlService: {}, ScriptApp: {},
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (s) => { sent.push(String(s)); return { setMimeType: () => ({ getContent: () => String(s) }) }; }
    },
    MailApp: { sendEmail: (o) => { mail.push(JSON.stringify(o)); } },
    GmailApp: {},
    Session: { getScriptTimeZone: () => 'America/Los_Angeles', getEffectiveUser: () => ({ getEmail: () => 'x@y.z' }) },
    Logger: { log() {} },
    UrlFetchApp: { fetch: fetchStub },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (cache.has(k) ? cache.get(k) : null),
        put: (k, v) => { cache.set(k, v); },
        remove: (k) => { cache.delete(k); }
      })
    },
    Utilities: {
      getUuid: () => 'test-uuid',
      sleep: () => {},
      formatDate: () => '2026-09-16',
      computeDigest: (_alg, str) => Array.from(Buffer.from(String(str), 'utf8')),
      base64Encode: (b) => Buffer.from(b).toString('base64'),
      base64EncodeWebSafe: (b) => Buffer.from(b).toString('base64url'),
      DigestAlgorithm: { SHA_256: 'sha256', MD5: 'md5' },
      Charset: { UTF_8: 'utf-8' }
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); },
        setProperties: (o) => { Object.keys(o).forEach((k) => { props[k] = String(o[k]); }); },
        getProperties: () => Object.assign({}, props),
        deleteProperty: (k) => { delete props[k]; }
      })
    }
  };

  const names = Object.keys(stubs);
  let P;
  try {
    P = new Function(...names, SRC +
      '\n; return { doGet, doPost, json, scrubSecrets_, requireRead_,' +
      ' SECRET_PARAM_WORDS_, SECRET_PARAM_RE_, AUTH_TOKEN_PARAM_, GX_SECRET_PARAM_,' +
      ' READ_ENFORCE_PROP, AUTH_ENFORCE_PROP, GXCORE_URL };'
    )(...names.map(n => stubs[n]));
  } catch (e) {
    console.error('LOAD FAILED: Code.gs did not evaluate under stubs — ' + e.message);
    console.error('Add the missing global to `stubs`. Do not let this pass quietly.');
    process.exit(2);
  }
  return { P, props, cache, sent, mail, fetches, last: () => sent[sent.length - 1] || '' };
}

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } };

/* A store registry answer, so the Dutchie proxy is reached the way a real request reaches it. */
const storesReply = (url) => (String(url).indexOf('action=stores') !== -1
  ? { ok: true, stores: [{ dutchie_name: 'River Rd', display_name: 'River Road', sort_order: 1 }] }
  : { ok: true, rows: [] });

/* ═══ 1. doGet's catch, executed for real, with a real Address-unavailable exception ═══ */
console.log('\n1. doGet catch — ?action=dutchieProbe, the proxy fetch dies at the network layer');
{
  const w = world({ throwOn: 'dutchie_inventory', reply: storesReply });
  w.P.doGet({ parameter: { action: 'dutchieProbe' } });
  const out = w.last();

  // The path is real: gxDutchieRows_ wraps only its JSON.parse, so the throw walks up through
  // dutchieInventory_ and dutchieProbe_ to the router with nothing in between to catch it.
  ok(w.fetches.some(u => u.indexOf('dutchie_inventory') !== -1 && u.indexOf(SECRET) !== -1),
     'the URL that failed really did carry the deploy secret (otherwise this test proves nothing)');
  ok(out.indexOf(SECRET) === -1, 'THE ONE THAT MATTERS: the deploy secret is not in the reply');
  ok(out.indexOf('secret=[redacted]') !== -1, 'it is redacted in place, not deleted wholesale');
  ok(out.indexOf('Address unavailable') !== -1 && out.indexOf('dutchie_inventory') !== -1,
     'and the reply still says what failed — a scrub nobody can debug gets removed later');
  ok(/"ok":false/.test(out), 'still an ok:false reply');
}

/* ═══ 2. the ROUTER CATCHES THEMSELVES, read off the source and nowhere else ═══ */
console.log('\n2. doGet / doPost catch blocks — asserted on the catch, not on the file');
{
  // Slice each router to its own function body. A whole-file grep for scrubSecrets_ passes on a
  // file where the catch does not use it, which is exactly how SPIFF's first version went green.
  function routerBody(name) {
    const start = SRC.indexOf('function ' + name + '(e) {');
    if (start === -1) return null;
    const next = SRC.indexOf('\nfunction ', start + 1);
    return SRC.slice(start, next === -1 ? SRC.length : next);
  }
  ['doGet', 'doPost'].forEach(function (name) {
    const body = routerBody(name);
    ok(!!body, name + ' is in this file and could be sliced');
    const m = body && body.match(/catch\s*\(\s*err\s*\)\s*\{[\s\S]*?\n  \}/);
    ok(!!m, name + ' ends in a top-level catch (err)');
    const block = (m && m[0]) || '';
    ok(/return json\(/.test(block), name + "'s catch builds the reply");
    ok(block.indexOf('scrubSecrets_(String(err))') !== -1,
       name + "'s catch passes the exception through scrubSecrets_");
    ok(!/error:\s*String\(err\)/.test(block),
       name + "'s catch does not return a bare String(err)");
  });
}

/* ═══ 3. the surface the router's catch does NOT cover: an error map that is RETURNED ═══ */
console.log('\n3. liveCatalog_ — a per-store failure is caught locally and returned in `errors`');
{
  const w = world({ throwOn: 'dutchie_inventory', reply: storesReply });
  w.P.doGet({ parameter: { action: 'liveCatalog', store: 'River Rd' } });
  const out = w.last();
  ok(/"ok":true/.test(out) && out.indexOf('"errors"') !== -1,
     'this really is the non-catch path — an ok:true reply carrying an errors map');
  ok(out.indexOf(SECRET) === -1, 'and the deploy secret is not in it');
}

/* ═══ 4. reportBug_ — the reply AND the email it sends when nothing reached the board ═══ */
console.log('\n4. reportBug_ — "GX Core could not be reached" carries the ingest_bug URL');
{
  const w = world({ throwOn: 'ingest_bug' });
  w.P.doPost({ postData: { contents: JSON.stringify({ action: 'reportBug', desc: 'labels print blank' }) } });
  const out = w.last();
  ok(w.fetches.some(u => u.indexOf('ingest_bug') !== -1 && u.indexOf(SECRET) !== -1),
     'the ingest_bug URL carried the deploy secret');
  ok(out.indexOf('could not be reached') !== -1, 'the reporter is still told it failed');
  ok(out.indexOf(SECRET) === -1, 'and the reply does not carry the secret');
  ok(w.mail.every(m => m.indexOf(SECRET) === -1),
     'nor does the unfiled-report email — scrubbed at the source, not only on the way out');
}

/* ═══ 5. the CALLER'S OWN session token, on the verify hop ═══ */
console.log('\n5. gxCoreGetJson_ — a dead verify call must not echo the session token back');
{
  const w = world({ throwOn: 'action=verify' });
  w.props[w.P.READ_ENFORCE_PROP] = '1';                     // enforcing: the read really verifies
  w.P.doGet({ parameter: { action: 'getQueue', token: TOKEN } });
  const out = w.last();
  ok(w.fetches.some(u => u.indexOf('action=verify') !== -1 && u.indexOf(TOKEN) !== -1),
     'the verify URL carried the session token');
  ok(out.indexOf(TOKEN) === -1, 'the refusal does not quote the token back at the browser');
  ok(out.indexOf('token=[redacted]') !== -1, 'it is redacted by name');
}

/* ═══ 6. a PREFIXED parameter name — the anchored-regex failure ═══ */
console.log('\n6. prefixed and suffixed names redact too');
{
  const w = world();
  const s = w.P.scrubSecrets_(
    'Address unavailable: https://core/exec?action=x&connector_secret=' + SECRET +
    '&gx_token=' + TOKEN + '&token_hash=abc&store=River%20Rd');
  ok(s.indexOf(SECRET) === -1, 'connector_secret= redacts (crew\'s regex walks past this one)');
  ok(s.indexOf(TOKEN) === -1, 'gx_token= redacts');
  ok(s.indexOf('token_hash=[redacted]') !== -1, 'token_hash= redacts');
  ok(s.indexOf('store=River%20Rd') !== -1, 'a harmless parameter is left alone');
}

/* ═══ 7. the list is DERIVED from what this engine accepts and sends ═══ */
console.log('\n7. no second hand-maintained list');
{
  const w = world();
  const words = w.P.SECRET_PARAM_WORDS_;
  ok(words.indexOf(w.P.AUTH_TOKEN_PARAM_) !== -1,
     'the parameter the auth code accepts (' + w.P.AUTH_TOKEN_PARAM_ + ') is in the scrub list');
  ok(words.indexOf(w.P.GX_SECRET_PARAM_) !== -1,
     'the parameter every GX Core call sends (' + w.P.GX_SECRET_PARAM_ + ') is in the scrub list');

  // And the auth code really does read the token under that name — if someone renames the constant,
  // both the gate and the scrub move together or this fails.
  const p = {}; p[w.P.AUTH_TOKEN_PARAM_] = TOKEN;
  w.props[w.P.READ_ENFORCE_PROP] = '1';
  w.P.requireRead_('getQueue', p);
  ok(w.fetches.some(u => u.indexOf(TOKEN) !== -1),
     'requireRead_ reads the credential from the parameter named by AUTH_TOKEN_PARAM_');

  // Every name in the list actually redacts, so a word can't be added to the list and do nothing.
  // NOTE THIS LOOP IS CIRCULAR ON ITS OWN — it takes its facts from the thing it is checking, so
  // DELETING a word from SECRET_PARAM_WORDS_ makes it check one name fewer and still pass. That is
  // precisely the bug inventory, sales and crew each shipped. MUST_COVER below is the floor that
  // makes a removal fail; this loop only catches a name added to the list that does not work.
  words.forEach(function (word) {
    const line = 'x?' + word + '=' + SECRET;
    ok(w.P.scrubSecrets_(line).indexOf(SECRET) === -1, '?' + word + '= redacts');
  });
}

/* ═══ 7b. THE FLOOR — hardcoded here, deliberately not read from the implementation ═══ */
console.log('\n7b. a removal from the scrub list must break this test, not shrink it');
{
  const w = world();
  /* Written out longhand ON PURPOSE. Every name below is one this engine either accepts or sends,
     or one GX Core accepts on a route this engine calls, and the point of the list is that it lives
     somewhere the code under test cannot edit. Deleting `session` from SECRET_PARAM_WORDS_ passed
     23 of 23 in core-admin's first version of this test because the loop above was the only check;
     here it fails. Add to this list when a new credential parameter appears — never remove from it
     to make a run go green. */
  const MUST_COVER = ['token', 'secret', 'key', 'password', 'pass', 'sig', 'session', 'auth'];
  MUST_COVER.forEach(function (word) {
    const plain    = 'Address unavailable: https://core/exec?action=x&' + word + '=' + SECRET;
    const prefixed = 'Address unavailable: https://core/exec?action=x&connector_' + word + '=' + SECRET;
    ok(w.P.scrubSecrets_(plain).indexOf(SECRET) === -1,    'floor: &' + word + '= is redacted');
    ok(w.P.scrubSecrets_(prefixed).indexOf(SECRET) === -1, 'floor: &connector_' + word + '= is redacted');
    ok(w.P.scrubSecrets_('x?' + word + '=' + SECRET).indexOf(SECRET) === -1,
       'floor: ?' + word + '= (first parameter) is redacted');
  });
}

/* ═══ 8. it scrubs values, not messages ═══ */
console.log('\n8. the message survives, the value does not');
{
  const w = world();
  const s = w.P.scrubSecrets_('GX Core dutchie_products unreachable after 5 tries — HTTP 500');
  ok(s === 'GX Core dutchie_products unreachable after 5 tries — HTTP 500',
     'a message with no credential in it is returned unchanged');
  ok(w.P.scrubSecrets_(null) === '' && w.P.scrubSecrets_(undefined) === '',
     'null and undefined do not throw inside a catch block');
  // json() is the choke point for all 33 reply exits, so it scrubs whatever it is handed.
  const j = w.P.json({ ok: false, error: 'boom ?secret=' + SECRET });
  ok(j.getContent().indexOf(SECRET) === -1, 'json() scrubs every reply, not just the two catches');
}

console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
