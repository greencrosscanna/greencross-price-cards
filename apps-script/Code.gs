/*****************************************************************
 * GX PRICE CARDS — DATA ENGINE (Apps Script Web App)
 * -------------------------------------------------------------
 * Thin read/write API between the hosted HTML app (GitHub Pages)
 * and this Google Sheet. The label DESIGN lives in the HTML/CSS,
 * NOT here — this script only moves data:
 *
 *   GET  /exec?gid=<tabId>   -> { ok, grid:[[headers...],[row...]...] }
 *                               (every row; the app filters "Done"
 *                                rows out client-side)
 *   POST /exec  body:
 *        { action:"markDone", gid, doneHeader }
 *                            -> { ok, marked:<count> }
 *                               checks the Done box on every
 *                               content row not already Done.
 *
 * WHY a web app: the front-end fetches rows THROUGH this script,
 * which runs as you — so the Sheet can stay PRIVATE (no public
 * link sharing required).
 *
 * ------------------------- DEPLOY -----------------------------
 *   1. In the Sheet:  Extensions ▸ Apps Script.
 *   2. Paste this file (replace everything). Save.
 *   3. Deploy ▸ New deployment ▸ (gear) Web app
 *        Execute as:        Me
 *        Who has access:    Anyone           ← required: the
 *                           hosted page calls it without a login
 *      Deploy, authorize when prompted.
 *   4. Copy the Web app URL (ends in /exec).
 *   5. In the label app: ⚙ Sheet settings ▸ paste the /exec URL.
 *
 * After re-deploying code changes, use "Manage deployments ▸ Edit
 * ▸ New version" so the same /exec URL keeps working.
 *****************************************************************/

// Optional: hard-lock to one tab by gid ('' = first sheet, or
// whatever gid the request passes). Leave '' for normal use.
var SHEET_GID = '';

/* ---------------------- ONE-TIME AUTHORIZE -------------------- *
 * Run this ONCE in the editor (select "authorize" ▸ Run) to grant
 * the script its scopes. RE-RUN after a scope change (e.g. when we
 * added Dutchie/external requests). The web app can't serve until
 * the owner has authorized. Safe to re-run.
 * -------------------------------------------------------------- */
function authorize() {
  var name = SpreadsheetApp.getActiveSpreadsheet().getName();
  var report = { sheet: name, dutchie: {} };
  // Touch the external-request scope + verify Dutchie connectivity per store.
  /* Connectivity is now GX Core's to report, not ours: this app holds no Dutchie credential, so
     there is nothing here to authorize against Dutchie directly. dutchie_whoami asks Dutchie what
     each key opens and checks it against the stores registry — a stronger check than the HTTP code
     this used to print, and it cannot be fooled by a mislabelled map. */
  try {
    var wu = GXCORE_URL + '?action=dutchie_whoami&secret='
           + encodeURIComponent(gxDeploySecret_());
    var wr = UrlFetchApp.fetch(wu, { muteHttpExceptions: true });
    var wd = JSON.parse(wr.getContentText() || 'null');
    if (wd && wd.ok === true) {
      (wd.stores || []).forEach(function (st) {
        report.dutchie[st.store] = st.ok ? ('opens ' + (st.location || st.location_id)) : ('ERR ' + st.error);
      });
    } else {
      report.dutchie = 'GX Core refused: ' + ((wd && wd.error) || 'no response');
    }
  } catch (e1) { report.dutchie = 'GX Core unreachable: ' + e1.message; }
  Logger.log('Authorized. ' + JSON.stringify(report));
  return report;
}

/* ---------------------------- READ ---------------------------- */
function doGet(e) {
  try {
    var p = (e && e.parameter) || {};

    /* authStats is the ONE ungated read: counters and a flag, no shop data in
       it. It has to answer without a session, because it is how we decide
       whether flipping enforcement on is safe yet. */
    if (p.action === 'authStats')  return json(authStats_());
    if (p.action === 'libversion') return json(getLibVersion_());
    if (p.action === 'authprobe')  return json(authProbe_());
    if (p.action === 'queueCount') return json(queueCount_());

    /* THERE IS NO DEFAULT BRANCH ANY MORE. doGet used to fall through to
       "return the bound Sheet", so a bare GET of the /exec URL handed live
       pricing to anyone holding the link — no knowledge of the API required at
       all, which made it a worse leak than the unauthenticated writes were.
       A bare ?gid= is still honored as an ALIAS for action=grid, because
       iPads on cached JS ask that way; that is not a catch-all — a request
       naming neither an action nor a gid now gets an error, not the Sheet.
       Retire the alias once the read gate is enforcing. */
    var action = p.action || (p.gid ? 'grid' : '');
    if (!has_(READ_ACTIONS, action)) return json({ ok: false, error: 'unknown-action' });

    var gate = requireRead_(action, p);
    if (!gate.ok) return json(gate);

    switch (action) {
      case 'stores':       return json({ ok: true, stores: dutchieStores_() });
      case 'dutchieProbe': return json(dutchieProbe_(p));
      case 'liveCatalog':  return json(liveCatalog_(p));
      case 'getConfig':    return json(getConfig_());
      case 'getQueue':     return json(getQueue_());
      case 'getPrinted':   return json(getPrinted_());
      case 'newProducts':  return json(newProducts_());
      case 'scanNow':      return json(scanNewProducts());
      case 'grid':         return json(readGrid_(p.gid));
    }
    // No fall-through to the Sheet. If an action reached here it is in
    // READ_ACTIONS but has no case, which is a bug, not a request for the grid.
    return json({ ok: false, error: 'unknown-action' });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

/* ═══════════════════ WRITE AUTH — GX Core session tokens ═══════════════════ *
 * Every mutating action requires a valid GX Core session with a `pricecards`
 * grant. Before this, doPost dispatched nine writes with no auth of any kind:
 * anyone holding the /exec URL could clear the shared print queue or overwrite
 * config. The client gate (generator.js) stops a passerby at a shop iPad; it
 * does NOT protect this endpoint, because a gate in the browser is advice.
 *
 * PATTERN: copied from SPIFF (greencross-spiff/apps-script/Code.gs gxAuth_),
 * not from Crew. Crew binds the GXCore LIBRARY; we deliberately do not — a
 * pinned library snapshot goes stale silently (see the v153 re-pin note), and
 * this app has no other reason to bind one. An HTTP call to Core's `validate`
 * route always hits current Core and needs no pin. Scope for the outbound call
 * (script.external_request) was already declared for Dutchie.
 *
 * READS ARE GATED TOO (Sky, 2026-08-20). The writes were the noisier problem;
 * the reads were the bigger one, because getQueue / getPrinted / liveCatalog /
 * newProducts / getConfig leak live pricing and inventory to anyone with the
 * URL. They differ from writes in one way that matters: FREQUENCY. Writes are
 * occasional, reads run several times per page load, so the read gate caches
 * its verification for 60s (keyed on a digest of the token) rather than paying
 * a Core round trip five times a load. The read cache and the write cache are
 * separate namespaces on purpose — a read verification must never authorize a
 * write.
 *
 * ROLLOUT — BOTH GATES SHIP DARK, and they flip INDEPENDENTLY. authEnforced_()
 * and readEnforced_() each read a Script Property that starts unset, so calls
 * are validated and COUNTED but never rejected. That closes the window where an
 * iPad running cached JS would have its writes refused or its catalog blanked.
 * Check readiness with ?action=authStats, then run enableWriteAuth() /
 * enableReadAuth() from the Apps Script editor to enforce. disableWriteAuth()
 * and disableReadAuth() are the rollbacks, and none of them need a code deploy.
 * Flip the writes first and let them sit: two dark gates flipped together means
 * two ways for a stale iPad to break at once, with no way to tell which did it.
 * ══════════════════════════════════════════════════════════════════════════ */
var APP        = 'pricecards';   // matches .gx_app AND the app_access grants in GX Core
var GXCORE_URL = 'https://script.google.com/macros/s/AKfycbx9mjeCBbDpxNYaqBv2hyZaO1hpbGG6PZM9AebFdwl0UwkdtRCGSWrH-8ohEtdF1K_6/exec';

var AUTH_ENFORCE_PROP = 'PRICECARDS_REQUIRE_AUTH';       // '1' = reject unauthenticated WRITES
var READ_ENFORCE_PROP = 'PRICECARDS_REQUIRE_AUTH_READ';  // '1' = reject unauthenticated READS
var AUTH_STATS_PROP   = 'PRICECARDS_AUTH_STATS';         // readiness telemetry for both flips

/* Two verification caches, two namespaces, deliberately NOT shared. 60s is the
   whole budget for a revocation to bite; the write path was on 300s, which was
   far too generous for the side that mutates shared state. Core-admin's ruling
   was to leave the writes uncached entirely — this keeps a 60s cache there
   because queue work is click-by-click and a Core round trip has been measured
   at ~7s, which would put a 7s spinner on every button in the print queue. */
var WRITE_CACHE_TTL_S = 60;
var READ_CACHE_TTL_S  = 60;

/* The nine mutating actions. markDone writes to the bound Sheet; the other
   eight mutate shared Script-Property state (queue, printed history, config). */
/* Object.create(null) — NO prototype, so these tables cannot be indexed into an
   inherited member even by code that forgets has_(). Inventory's improvement on
   my fix and the better one: it defends the PATTERN rather than this instance,
   so whoever copies it onto a new route inherits the safe version instead of
   the lucky one. has_() stays as well; two cheap defenses on the hole that
   handed the whole pricing sheet to ?action=toString.

   NOTE ON WRITE_ACTIONS: it is no longer the gate — doPost authenticates every
   post regardless. It survives as the documented inventory of writes and as the
   count the probe reports, so adding a write here is now bookkeeping rather than
   the thing that makes it safe. READ_ACTIONS IS still the read router, and that
   is the right shape for reads: it lists what is PUBLICLY ROUTABLE, so a
   forgotten line makes a read unreachable rather than making the Sheet public. */
var WRITE_ACTIONS = Object.assign(Object.create(null), {
  saveConfig: 1, submitCards: 1, queueRemove: 1, clearQueue: 1, markPrinted: 1,
  removePrintedSheet: 1, clearPrinted: 1, ackProducts: 1, markDone: 1
});

/* Every read this app serves, named explicitly. This list IS the router — an
   action that is not in it is an error, which is what removed the old default
   branch. scanNow sits here because it arrives as a GET, but it mutates, so it
   is gated like everything else. authStats is handled before the lookup. */
var READ_ACTIONS = Object.assign(Object.create(null), {
  stores: 1, dutchieProbe: 1, liveCatalog: 1, getConfig: 1,
  getQueue: 1, getPrinted: 1, newProducts: 1, scanNow: 1, grid: 1
});

function authEnforced_() {
  return PropertiesService.getScriptProperties().getProperty(AUTH_ENFORCE_PROP) === '1';
}
function readEnforced_() {
  return PropertiesService.getScriptProperties().getProperty(READ_ENFORCE_PROP) === '1';
}

/* Flip enforcement from the Apps Script editor (owner-only) rather than over
   HTTP — an endpoint that can disable the endpoint's own auth is a back door. */
function enableWriteAuth()  { PropertiesService.getScriptProperties().setProperty(AUTH_ENFORCE_PROP, '1'); return authStats_(); }
function disableWriteAuth() { PropertiesService.getScriptProperties().deleteProperty(AUTH_ENFORCE_PROP);   return authStats_(); }
function enableReadAuth()   { PropertiesService.getScriptProperties().setProperty(READ_ENFORCE_PROP, '1'); return authStats_(); }
function disableReadAuth()  { PropertiesService.getScriptProperties().deleteProperty(READ_ENFORCE_PROP);   return authStats_(); }
function resetAuthStats()   { PropertiesService.getScriptProperties().deleteProperty(AUTH_STATS_PROP);     return authStats_(); }

/* Validate a GX Core session token and resolve this user's role on `pricecards`.
   Core's `verify` route runs verifySession(): HMAC signature + expiry + a live
   re-check of the grant. A forged or expired token fails here, not in the browser.

   IT MUST BE `verify`, NOT `validate`. Both authenticate, and this called
   `validate` for a day — copied from SPIFF's helper rather than from the spec
   core-admin actually wrote for us, which said `v.ok && v.canEdit`. Reading
   Core's source (v170) shows why that matters:

     validate -> requireAuth()    -> { ok, user, role }
     verify   -> verifySession()  -> { ok, user, app, role, canEdit }

   validate never returns canEdit, so the write gate could only ever ask "does
   this person have a grant?" — never "may they edit?". A viewer-granted account
   passed it. The role was being read and thrown away. */
function gxVerify_(token, ns, ttl) {
  if (!token) return { ok: false, error: 'Not signed in', code: 'auth_required' };
  var cache = CacheService.getScriptCache();
  // Key on a DIGEST, never the raw token — the cache is not a place to park credentials.
  var ckey = ns + ':' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(token)));
  var hit = cache.get(ckey);
  if (hit) return JSON.parse(hit);
  try {
    var url = GXCORE_URL + '?action=verify&app=' + encodeURIComponent(APP) +
              '&token=' + encodeURIComponent(token);
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    var out = JSON.parse(res.getContentText());
    // Cache ONLY successes. Caching a failure would turn a blip in Core into a
    // minute of locked-out managers.
    if (out && out.ok) cache.put(ckey, JSON.stringify(out), ttl);
    return out;
  } catch (e) {
    return { ok: false, error: 'Could not reach GX Core to verify your session',
             code: 'core_unreachable' };
  }
}
function gxAuthWrite_(token) { return gxVerify_(token, 'pcw', WRITE_CACHE_TTL_S); }
function gxAuthRead_(token)  { return gxVerify_(token, 'pcr', READ_CACHE_TTL_S); }

/* Best-effort counters answering one question: are real clients sending tokens
   yet? Undercounts under concurrency (Properties writes are not transactional)
   and that is fine — it is a readiness signal, not an audit log.

   PROBES MUST SAY SO: pass probe=1 and the attempt is tallied under `probes`
   instead of with/without, so testing cannot be mistaken for a stale client in
   the data a flip gets decided on. This exists because it has now happened
   twice — my own tokenless curl left a "?" in the write counters, and
   core-admin's post-flip probes added six ackProducts hits that look exactly
   like a real client whose writes are being refused. We each nearly
   manufactured the ghost we spent a day chasing.

   It is SELF-DECLARED, so it is not audit-grade: anyone can set probe=1 and
   stay out of the counters. That costs nothing, because the flag has no effect
   on the gate — a probe is refused exactly like any other unauthenticated
   request. It buys a clean instrument, not a security property, and it would be
   a mistake to ever treat `without` as a record of who tried. */
/* JSON.parse hands back plain objects, WITH a prototype — so a counter keyed on
   an action name does `bucket['toString'] || 0`, finds the inherited function,
   and stores "function toString() { [native code] }1". Found in the LIVE stats,
   in my own telemetry, days after I sent every app in the suite a warning about
   this exact class and grepped my gates for it. Counters did not look like a
   place the bug could live, which is precisely why it lived there.

   Not a security hole — but these counters are the evidence the auth flip gets
   decided on, and a corrupted count is worse than no count. */
function statBucket_(s, name) {
  var clean = Object.create(null);
  var raw = s[name];
  if (raw) {
    for (var k in raw) {
      if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
      var n = Number(raw[k]);
      if (isFinite(n)) clean[k] = n;      // drop anything a previous build corrupted
    }
  }
  s[name] = clean;
  return clean;
}

function authStatBump_(kind, action, ok, isProbe) {
  try {
    var props = PropertiesService.getScriptProperties();
    var s = JSON.parse(props.getProperty(AUTH_STATS_PROP) || '{}');
    // Writes keep the original bucket names so the counts already collected stay
    // comparable; reads get their own, because the two gates flip separately and
    // a mixed count could not tell you which one was ready.
    if (isProbe) {
      var pb = statBucket_(s, 'probes');
      var pk = (kind === 'r' ? 'read:' : 'write:') + String(action || '?');
      pb[pk] = (pb[pk] || 0) + 1;
      s.last_probe_at = new Date().toISOString();
      props.setProperty(AUTH_STATS_PROP, JSON.stringify(s));
      return;
    }
    var withKey = (kind === 'r') ? 'read_with' : 'with';
    var noKey   = (kind === 'r') ? 'read_without' : 'without';
    var bucket  = statBucket_(s, ok ? withKey : noKey);
    statBucket_(s, ok ? noKey : withKey);          // sanitize the other side too
    var key = String(action || '?');
    bucket[key] = (bucket[key] || 0) + 1;
    var stamp = (kind === 'r') ? 'read_' : '';
    if (ok) s[stamp + 'last_ok_at'] = new Date().toISOString();
    else    s[stamp + 'last_missing_at'] = new Date().toISOString();
    props.setProperty(AUTH_STATS_PROP, JSON.stringify(s));
  } catch (e) { /* telemetry must never break a write */ }
}

/* ?action=libversion — inventory's snippet (their note, 2026-08-21). For most
   spokes it reports which GXCore snapshot the DEPLOYMENT runs, which is the only
   trustworthy answer: the repo manifest, HEAD and the deployment can all
   disagree. Here it will always say "not bound", and that is the point — this
   app reaches Core over HTTP precisely so there is no pin to drift, and now that
   claim is assertable over HTTP instead of taken on faith from a repo file. */
function getLibVersion_() {
  try {
    if (typeof GXCore === 'undefined' || !GXCore) {
      return { ok: false, error: 'GXCore not bound', bound: false,
               note: 'by design — pricecards calls GX Core over HTTP, so there is no pinned snapshot' };
    }
    if (typeof GXCore.libVersion !== 'function') {
      return { ok: false, error: 'pinned GXCore has no libVersion() - pre-v153', bound: true };
    }
    return { ok: true, bound: true, gxcore: GXCore.libVersion() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ?action=authprobe — inventory's writeauthprobe, adapted. Answers "are the
   gates really wired?" without a real session and without flipping enforcement.
   It mints a garbage token, runs it through the REAL verification and the REAL
   decision function with enforcing forced on, and reports whether it was
   actually refused. `wouldRefuseIfEnforcing:true` is the live proof that the
   enforcing path refuses — the one thing the dark rollout otherwise cannot show
   without refusing real managers for the duration.

   It deliberately does NOT touch the readiness counters: a diagnostic that
   pollutes the signal you flip on is worse than no diagnostic. */
function authProbe_() {
  var bogus = 'probe-' + Utilities.getUuid() + '.not-a-real-token';
  var v = gxVerify_(bogus, 'pcprobe', 1);          // own cache namespace, 1s — never reused by a real call

  /* Every assertion below runs the SHIPPED gateDecision_ with enforcing forced
     on, differing only in what it is fed. Fakes are built here, never verified
     by Core — the point is to exercise the decision, not the network. */
  var real     = gateDecision_(v, true, true);                                        // garbage token, write
  var accepted = gateDecision_({ ok: true, user: 'probe', role: 'editor', canEdit: true },  true, true);
  var viewerW  = gateDecision_({ ok: true, user: 'probe', role: 'viewer', canEdit: false }, true, true);
  var viewerR  = gateDecision_({ ok: true, user: 'probe', role: 'viewer', canEdit: false }, true, false);
  var absent   = gateDecision_({ ok: true, user: 'probe', role: 'editor' },            true, true);

  var out = {
    writes: { enforcing: authEnforced_(), gated: countKeys_(WRITE_ACTIONS) },
    reads:  { enforcing: readEnforced_(), gated: countKeys_(READ_ACTIONS) },
    coreReachable:  !!(v && v.code !== 'core_unreachable'),
    refusalCode:    (v && v.code) || '',
    role:           (v && v.role) || '',

    // A garbage token is actually refused …
    refusesGarbage: !(v && v.ok),
    wouldRefuseIfEnforcing: real.ok === false && real.needsAuth === true,
    // … and the probe is reading its input rather than hardcoding the answer:
    // fed a verifier that ACCEPTS, the same decision must allow.
    inverseHolds:   accepted.ok === true,
    // Writes need edit rights, reads only need the grant.
    honorsReadOnly: viewerW.ok === false && viewerW.code === 'read_only' &&
                     viewerW.needsAuth !== true && viewerR.ok === true,
    // An ABSENT canEdit must not lock anyone out — it lands where this code
    // stood before the check existed, which is the no-more-permissive rule.
    absentCanEditAllows: absent.ok === true,
    // The prototype hole cannot come back by someone reverting a map literal.
    protoSafe: WRITE_ACTIONS['toString'] === undefined && WRITE_ACTIONS['constructor'] === undefined &&
               READ_ACTIONS['toString']  === undefined && READ_ACTIONS['__proto__']   === undefined
  };

  /* ok is the AND of every invariant, not a fixed true with details hanging off
     it — inventory's shape. A green ok has to mean something failed nothing. */
  out.ok = out.refusesGarbage && out.wouldRefuseIfEnforcing && out.inverseHolds &&
           out.honorsReadOnly && out.absentCanEditAllows && out.protoSafe && out.coreReachable;
  return out;
}

function countKeys_(o) { var n = 0; for (var k in o) if (has_(o, k)) n++; return n; }

/* Truthy `probe` on the query string or the post body. Deliberately loose about
   the value ('1', 'true', 1) and deliberately without effect on the gate. */
function isProbe_(src) {
  var v = src && src.probe;
  return v === 1 || v === true || v === '1' || v === 'true';
}


/* Readiness for the EDIT half of the write gate, which the counters could not
   see before: how often a caller authenticates fine but would be refused for
   being view-only, and whether canEdit arrives populated at all. Both matter
   before flipping — the first says whether requiring it locks out somebody real,
   the second answers inventory's question about whether canEdit is populated
   fleet-wide or whether everyone is hedging on an absent field. */
function authStatEdit_(action, auth) {
  if (!auth || !auth.ok) return;
  try {
    var props = PropertiesService.getScriptProperties();
    var s = JSON.parse(props.getProperty(AUTH_STATS_PROP) || '{}');
    var seen = (auth.canEdit === true) ? 'true' : (auth.canEdit === false) ? 'false' : 'missing';
    var seenB = statBucket_(s, 'canedit_seen');
    seenB[seen] = (seenB[seen] || 0) + 1;
    if (auth.canEdit === false) {
      var denied = statBucket_(s, 'edit_denied');
      var k = String(action || '?');
      denied[k] = (denied[k] || 0) + 1;
      s.last_edit_denied_at = new Date().toISOString();
    }
    props.setProperty(AUTH_STATS_PROP, JSON.stringify(s));
  } catch (e) { /* telemetry must never break a write */ }
}

function authStats_() {
  var props = PropertiesService.getScriptProperties();
  var s = {};
  try { s = JSON.parse(props.getProperty(AUTH_STATS_PROP) || '{}'); } catch (e) {}
  // Report sanitized counts, so a value corrupted by an older build cannot be
  // read as a number by whoever is deciding whether to flip.
  ['with', 'without', 'read_with', 'read_without', 'canedit_seen', 'edit_denied', 'probes']
    .forEach(function (b) { if (s[b]) statBucket_(s, b); });
  s.enforcing = authEnforced_();            // writes
  s.enforcing_reads = readEnforced_();
  return { ok: true, auth: s };
}

/* The gate. Returns {ok:true, user, role} to proceed, or {ok:false, needsAuth}
   to refuse. While dark it always proceeds, but still validates and counts, so
   the stats reflect what enforcement WOULD have done. */
function requireWrite_(body) {
  var token = (body && body.token) || '';
  var auth  = gxAuthWrite_(token);
  authStatBump_('w', body && body.action, !!auth.ok, isProbe_(body));
  authStatEdit_(body && body.action, auth);
  return gateDecision_(auth, authEnforced_(), true);
}

/* The whole decision, in one place, so ?action=authprobe can put deliberate
   fakes through THIS function with enforcing forced on. A probe that
   re-implemented the rule would be asserting its own copy, which is the kind of
   check that cannot fail — and a check that cannot fail reads as a pass.

   needsEdit separates the two questions Core answers separately: reads need a
   GRANT, writes need EDIT RIGHTS. GX_EDIT_ROLES is {editor, admin, director,
   manager}, and a superadmin resolves to admin, so this refuses viewers and
   nobody else.

   canEdit is honored only when Core says it OUTRIGHT (=== false), never when
   merely absent — inventory's call, and it holds here for a second reason: a
   missing canEdit lands exactly where this code already stood yesterday, so the
   fallback is no more permissive than the thing it replaces. That is crew's
   rule for auth fallbacks and it is the right shape. */
function gateDecision_(auth, enforcing, needsEdit) {
  var signedIn   = !!(auth && auth.ok);
  var editDenied = !!(needsEdit && signedIn && auth.canEdit === false);

  if (signedIn && !editDenied) return { ok: true, user: auth.user || '', role: auth.role || '' };

  if (!enforcing) {
    return { ok: true, user: (auth && auth.user) || '', role: (auth && auth.role) || '',
             unauthenticated: !signedIn, readOnly: editDenied };
  }
  if (editDenied) {
    /* NOT needsAuth. This person is signed in and may read Price Cards perfectly
       well; bouncing them to a sign-in form would be the same dead end as
       no_access. The client shows it inline and leaves the app usable. */
    return { ok: false, readOnly: true, code: 'read_only', user: auth.user || '',
             role: auth.role || '', error: 'Your Price Cards access is view-only' };
  }
  return refusal_(auth);
}

/* Same shape for reads, on its own flag and its own cache. Kept separate from
   requireWrite_ rather than parameterized: the two differ in what they may
   trust (a cached read answer must not stand in for a write check), and a
   single function with a mode flag is how that distinction gets lost later. */
function requireRead_(action, p) {
  var token = (p && p.token) || '';
  var auth  = gxAuthRead_(token);
  authStatBump_('r', action, !!auth.ok, isProbe_(p));
  return gateDecision_(auth, readEnforced_(), false);   // a viewer may read; only writes need edit rights
}

/* Pass Core's stable `code` through to the client. GX Core v164 returns one on
   every auth failure — auth_required, invalid_session, session_expired,
   bad_credentials, missing_credentials, no_access, app_required — and the
   client branches on THAT, never on the prose, which gets reworded. The
   distinction that earns its keep is no_access: that person is signed in
   perfectly well and simply has no pricecards grant, so showing them a sign-in
   form is a dead end that refuses them again. */
function refusal_(auth) {
  return {
    ok: false,
    error: (auth && auth.error) || 'Not signed in',
    code:  (auth && auth.code)  || 'auth_required',
    needsAuth: true
  };
}

/* --------------------------- WRITE ---------------------------- */
function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    /* AUTH GATE — EVERY post, before any of them touch state, whether or not
       the action is one we recognize.

       It used to gate `if (has_(WRITE_ACTIONS, body.action))`, and the comment
       here bragged that a new write was covered the moment its name landed in
       that list. That is the wrong shape, and SPIFF named it after finding the
       same failure in their own gate: a list of what to PROTECT means a
       forgotten line ships a SILENTLY PUBLIC write, while a list of what is
       PUBLIC means a forgotten line ships an unreachable one — and only the
       second kind reports itself, immediately, from whoever added it.

       Nothing this endpoint accepts is public, so there is no exception list to
       consult. An unknown action is authenticated first and refused second,
       which costs a Core round trip on garbage and is the correct order. */
    var gate = requireWrite_(body);
    if (!gate.ok) return json(gate);
    // Attribution from the VERIFIED session, not from a client-supplied field.
    // `by` arrived as "" from every caller anyway, so the queue never recorded
    // who submitted a card; now it does, and it cannot be spoofed.
    if (gate.user) body.by = gate.user;

    if (body.action === 'saveConfig')  return json(saveConfig_(body));
    if (body.action === 'submitCards') return json(submitCards_(body));
    if (body.action === 'queueRemove') return json(queueRemove_(body));
    if (body.action === 'clearQueue')  return json(clearQueue_());
    if (body.action === 'markPrinted') return json(markPrinted_(body));
    if (body.action === 'removePrintedSheet') return json(removePrintedSheet_(body));
    if (body.action === 'clearPrinted')return json(clearPrinted_());
    if (body.action === 'ackProducts') return json(ackProducts_(body));
    // Gated like every other post here, and NOT added to any public-exception list. I first shipped
    // this reasoning "unauthenticated on purpose — the person hitting a bug may be the one whose
    // session broke", and the gate refused it on the first real call. The gate is right: this /exec
    // is ANYONE_ANONYMOUS, so a public write path would let anyone holding the URL post into the
    // shared Inventory bug board. A user who cannot authenticate cannot use this app at all, and
    // still has Inventory's reporter and Sky. The doPost comment above already explains why there is
    // no exception list — a forgotten line should ship UNREACHABLE, which is exactly what happened
    // here, and it reported itself in minutes.
    if (body.action === 'reportBug')   return json(reportBug_(body));
    if (body.action !== 'markDone') return json({ ok: false, error: 'unknown-action' });

    var sheet = pickSheet(body.gid);
    var data  = sheet.getDataRange().getValues();
    if (data.length < 2) return json({ ok: true, marked: 0 });

    var headers = data[0].map(function (h) { return String(h).trim().toLowerCase(); });
    var wanted  = String(body.doneHeader || 'Done').trim().toLowerCase();
    var col     = headers.indexOf(wanted);
    if (col < 0) col = headers.indexOf('done');
    if (col < 0) return json({ ok: false, error: 'no-done-column' });

    var marked = 0;
    for (var r = 1; r < data.length; r++) {
      var row        = data[r];
      var hasContent = row.some(function (c) { return String(c).trim() !== ''; });
      var already    = row[col] === true ||
                       /^(true|yes|x|1|done|✓|✔)$/i.test(String(row[col]).trim());
      if (hasContent && !already) {
        sheet.getRange(r + 1, col + 1).setValue(true);
        marked++;
      }
    }
    return json({ ok: true, marked: marked });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

/* --------------------------- HELPERS -------------------------- */
/* OWN keys only. `READ_ACTIONS[a]` alone is a hole: every plain object inherits
   toString, constructor, valueOf and friends, so ?action=toString passed the
   router as a known action. It then fell past the switch to the old grid
   read — re-creating, through a different door, the exact leak that deleting
   the default branch was meant to close. Caught on the live endpoint after
   deploy; the stubbed harness had not thought to ask for a prototype member. */
function has_(table, key) {
  return Object.prototype.hasOwnProperty.call(table, String(key));
}

function readGrid_(gid) {
  var sheet  = pickSheet(gid);
  var values = sheet.getDataRange().getValues();
  var grid   = values.map(function (row) { return row.map(cellToString); });
  return { ok: true, grid: grid, rows: grid.length };
}
function pickSheet(gid) {
  var ss   = SpreadsheetApp.getActiveSpreadsheet();
  var want = gid || SHEET_GID;
  if (want) {
    var sh = ss.getSheets();
    for (var i = 0; i < sh.length; i++) {
      if (String(sh[i].getSheetId()) === String(want)) return sh[i];
    }
  }
  return ss.getSheets()[0];
}

// Keep the client's CSV-style pipeline happy: booleans -> TRUE/FALSE,
// dates -> ISO, everything else -> trimmed string.
function cellToString(c) {
  if (c === true)  return 'TRUE';
  if (c === false) return 'FALSE';
  if (c instanceof Date) {
    return Utilities.formatDate(c, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(c);
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ----- Shared (global) settings — one config for all staff/devices ----- *
 * Stored in Script Properties so OTD pricing, label sections, smart rules,
 * and the category map are the same everywhere the engine is used.
 * -------------------------------------------------------------------- */
var GC_CONFIG_PROP = 'GC_CONFIG_JSON';
function getConfig_() {
  var raw = PropertiesService.getScriptProperties().getProperty(GC_CONFIG_PROP);
  return { ok: true, config: raw ? JSON.parse(raw) : null };
}
function saveConfig_(body) {
  if (body && body.config != null) {
    PropertiesService.getScriptProperties().setProperty(GC_CONFIG_PROP, JSON.stringify(body.config));
    return { ok: true, saved: true };
  }
  return { ok: false, error: 'no-config' };
}

/* ----- Shared print queue — employees submit cards, the printer pulls + clears ----- *
 * Stored in Script Properties (app-only, no Google Sheet). Each entry:
 *   { id, card:{brand,item,desc,size,price,store,status,category}, by, at }
 * Concurrency-guarded with a short lock so simultaneous submits don't clobber.
 * ------------------------------------------------------------------------------ */
var GC_QUEUE_PROP = 'GC_QUEUE_JSON';
function readQueue_() {
  var raw = PropertiesService.getScriptProperties().getProperty(GC_QUEUE_PROP);
  return raw ? JSON.parse(raw) : [];
}
function writeQueue_(q) {
  PropertiesService.getScriptProperties().setProperty(GC_QUEUE_PROP, JSON.stringify(q));
}
function getQueue_() { return { ok: true, queue: readQueue_() }; }

/* PUBLIC BY DESIGN, and deliberately NOT getQueue.
   Inventory renders a Price Tags badge from the shared queue and polls this
   engine every 30s (greencross-inventory/index.html:8745). It has no pricecards
   token, and once the read gate enforces its badge would silently show nothing —
   found in the dark-mode counters, as tokenless reads that never went quiet no
   matter how many stale clients we fixed. A steady rate that survives every fix
   is not noise, it is a subscriber.

   The two obvious fixes are both bad. Having Inventory send a token couples its
   badge to whether the current Inventory user holds a pricecards grant — and
   Price Cards is a SUB-APP, so plenty of Inventory users have no such row, and
   their badge would blank for a reason unrelated to the badge. Exempting
   getQueue is worse: it returns brand, item, description, size, PRICE and store
   for every pending card, so publishing it to serve a count would republish the
   pending price list — the exact leak we just closed.

   So: a count, and nothing else. No token, no grant, no card data. The number of
   cards waiting says nothing about what they are or what they cost. Anything
   that carries actual queue CONTENT stays behind the gate. */
/* ═══════════════════ BUG FORWARDING — over HTTP, like everything else here ═══
 * Sub-app convention: Price Cards reports bucket to INVENTORY with a `tab`
 * discriminator (app=inventory, tab=pricecards), not to a separate pricecards
 * stream. The notes key and the bug tab are different things — do not conflate.
 *
 * Every other spoke calls GXCore.gxIngestBug() through the pinned library. This
 * app deliberately binds no library (see the WRITE AUTH note above), so it uses
 * Core's secret-gated `ingest_bug` route over HTTP — the same channel it already
 * uses to verify sessions. No pin, nothing to go stale.
 *
 * WHY THIS EXISTS NOW: embedded in Inventory the user has Inventory's reporter on
 * the parent page, so the gap was invisible. Standalone — this app's own Pages
 * URL, which is how it is used with write auth ENFORCING — there was no reporter
 * anywhere on the page and a staff bug had nowhere to land.
 *
 * REQUIRES A SESSION, like every other post here — see the note at the dispatch line.
 *
 * A TITLE IS MANDATORY and Sales learned it the expensive way: GX Core rejects a
 * report with no title, the old Sales code ignored that result and returned
 * ok:true, so reports were silently lost while the user saw success. Derive one
 * from the first line rather than trusting the caller, and NEVER report success
 * on a failed ingest.
 */
function reportBug_(body) {
  var desc = String((body && body.desc) || '').trim();
  if (!desc) return { ok: false, error: 'desc required' };

  var secret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET') || '';
  if (!secret) return { ok: false, error: 'GX_DEPLOY_SECRET unset on this engine — cannot file' };

  var reporter = String((body && body.reporter) || '').trim() || 'anonymous';
  var title    = String((body && body.title) || '').trim() || desc.split('\n')[0].slice(0, 80).trim();

  var params = {
    action: 'ingest_bug', secret: secret,
    app: 'inventory',                 // sub-app: bugs bucket to the parent
    reporter: reporter,
    title: title,
    desc: desc,
    priority: String((body && body.priority) || 'normal'),
    tab: 'pricecards',                // the discriminator that makes it findable
    appVer: String((body && body.appVer) || ''),
    appStore: String((body && body.appStore) || ''),
  };
  var qs = Object.keys(params).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  }).join('&');

  try {
    var res  = UrlFetchApp.fetch(GXCORE_URL + '?' + qs, { method: 'get', muteHttpExceptions: true });
    var code = res.getResponseCode();
    if (code < 200 || code >= 300) return { ok: false, error: 'GX Core returned HTTP ' + code };
    var out;
    try { out = JSON.parse(res.getContentText()); } catch (e) { return { ok: false, error: 'GX Core returned non-JSON' }; }
    // Surface Core's own refusal rather than flattening it to success.
    if (!out || !out.ok) return { ok: false, error: (out && out.error) || 'bug report was not saved' };
    return { ok: true, id: out.id || '' };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

function queueCount_() {
  var q = readQueue_();
  return { ok: true, count: (q && q.length) || 0 };
}
/* ---- submitCards idempotency -------------------------------------------------------------------
 * "Send it to print" POSTs through /exec's second hop and can take seconds. Staff read the silence
 * as a dead button and tap again, and every tap used to append another set of rows -- the queue
 * grew a duplicate of the same card for each impatient tap.
 *
 * The client stamps each batch with a content-derived subId, so a re-tap of the SAME cards replays
 * the first result instead of queueing a second copy. Two properties of the design earn their keep:
 *
 *   WINDOW, NOT A LEDGER -- a genuine reprint of an identical card next week must still queue, so
 *   records expire. The window only has to outlast a human's patience, not the card's life.
 *
 *   INSIDE THE LOCK -- the double-tap is a race. Checking outside the lock would let both taps read
 *   the store before either wrote to it, and both would append: exactly the bug, just narrower.
 *
 * subId is optional: an older client that does not send one still queues normally (undeduped).
 */
var GC_SUBMITS_PROP  = 'GC_SUBMITS_JSON';
var SUBMIT_DEDUP_MS  = 90 * 1000;   // a re-tap window, not a permanent ledger
var SUBMIT_DEDUP_CAP = 50;
function readSubmits_() {
  var raw = PropertiesService.getScriptProperties().getProperty(GC_SUBMITS_PROP);
  try { return raw ? JSON.parse(raw) : []; } catch (e) { return []; }
}
function writeSubmits_(s) {
  if (s.length > SUBMIT_DEDUP_CAP) s = s.slice(s.length - SUBMIT_DEDUP_CAP);
  PropertiesService.getScriptProperties().setProperty(GC_SUBMITS_PROP, JSON.stringify(s));
}
function submitCards_(body) {
  var cards = (body && body.cards) || [];
  if (!cards.length) return { ok: false, error: 'no-cards' };
  var subId = String((body && body.subId) || '');
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var nowMs = Date.now();
    var recent = readSubmits_().filter(function (s) { return (nowMs - s.ms) < SUBMIT_DEDUP_MS; });
    for (var j = 0; subId && j < recent.length; j++) {
      if (recent[j].subId === subId) {          // same batch, still inside the window
        writeSubmits_(recent);                  // persist the prune, append nothing
        return { ok: true, added: recent[j].added, count: readQueue_().length, duplicate: true };
      }
    }
    var q = readQueue_();
    var now = new Date().toISOString(), by = String(body.by || '');
    for (var i = 0; i < cards.length; i++) {
      q.push({ id: Utilities.getUuid(), card: cards[i], by: by, at: now });
    }
    writeQueue_(q);
    if (subId) recent.push({ subId: subId, ms: nowMs, added: cards.length });
    writeSubmits_(recent);
    return { ok: true, added: cards.length, count: q.length };
  } finally { lock.releaseLock(); }
}
function queueRemove_(body) {
  var ids = (body && body.ids) || [];
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var set = {}; ids.forEach(function (id) { set[id] = true; });
    var q = readQueue_().filter(function (e) { return !set[e.id]; });
    writeQueue_(q);
    return { ok: true, removed: ids.length, count: q.length };
  } finally { lock.releaseLock(); }
}
function clearQueue_() { writeQueue_([]); return { ok: true, count: 0 }; }

// ---- Printed archive: each print job is a "sheet" of cards, moved out of the active queue ----
var GC_PRINTED_PROP = 'GC_PRINTED_JSON';
var PRINTED_CAP = 200;                     // retention cap: keep the newest 200 sheets
function readPrinted_() {
  var raw = PropertiesService.getScriptProperties().getProperty(GC_PRINTED_PROP);
  return raw ? JSON.parse(raw) : [];
}
function writePrinted_(sheets) {
  if (sheets.length > PRINTED_CAP) sheets = sheets.slice(sheets.length - PRINTED_CAP);  // keep newest
  PropertiesService.getScriptProperties().setProperty(GC_PRINTED_PROP, JSON.stringify(sheets));
}
function getPrinted_() { return { ok: true, printed: readPrinted_() }; }
// Record a batch of printed cards as ONE printed sheet, and make sure they're
// out of the active queue. Cards are usually claimed (dequeued) at import time,
// so callers pass the card payloads directly in body.cards; body.ids is still
// honored to dequeue anything not yet claimed (and as the card source if no
// explicit cards were given), keeping older clients working.
/* THE ONE WRITE HERE THAT IS NOT NATURALLY IDEMPOTENT: every call appends an archive entry with a
 * fresh UUID. That did not matter while the client sent each POST exactly once and showed an honest
 * error on failure. It matters now: v1.422 gave the client a retry, and the /exec failure it retries
 * is on the SECOND hop -- the request reached this script and this function may already have run, so
 * what the retry replaces is a lost RECEIPT, not a lost write. Without a replay window a retried
 * print would archive the same sheet twice and dequeue nothing the second time, which reads to staff
 * as a phantom duplicate print run.
 *
 * Same window, same store and the same reasoning as submitCards_ above -- deliberately not a second
 * mechanism. The ids are namespaced `mp:` by the client so the two kinds of record cannot collide in
 * the shared property. subId is optional: an older client that sends none still archives normally,
 * undeduped, exactly as it does today.
 */
function markPrinted_(body) {
  var ids = (body && body.ids) || [];
  var cards = (body && body.cards) || [];
  var subId = String((body && body.subId) || '');
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // INSIDE THE LOCK, for the reason submitCards_ spells out: checked outside it, two attempts can
    // both read the store before either writes, and both archive.
    var nowMs = Date.now();
    var recent = readSubmits_().filter(function (s) { return (nowMs - s.ms) < SUBMIT_DEDUP_MS; });
    for (var j = 0; subId && j < recent.length; j++) {
      if (recent[j].subId === subId) {                  // same batch, still inside the window
        writeSubmits_(recent);                          // persist the prune, archive nothing
        return { ok: true, moved: (recent[j].res && recent[j].res.moved) || 0,
                 count: readQueue_().length, sheets: readPrinted_().length, duplicate: true };
      }
    }
    if (ids.length) {                                   // dequeue any still-queued ids (safety net)
      var set = {}; ids.forEach(function (id) { set[id] = true; });
      var q = readQueue_(), keep = [], pulled = [];
      q.forEach(function (e) { if (set[e.id]) pulled.push(e.card || e); else keep.push(e); });
      if (keep.length !== q.length) writeQueue_(keep);
      if (!cards.length) cards = pulled;                // fall back to the queue payloads
    }
    if (!cards.length) return { ok: false, error: 'no-cards' };
    var sheets = readPrinted_();
    sheets.push({ id: Utilities.getUuid(), printedAt: new Date().toISOString(),
                  printedBy: String((body && body.by) || ''), cards: cards });
    writePrinted_(sheets);
    if (subId) recent.push({ subId: subId, ms: nowMs, res: { moved: cards.length } });
    writeSubmits_(recent);
    return { ok: true, moved: cards.length, count: readQueue_().length, sheets: sheets.length };
  } finally { lock.releaseLock(); }
}
// Remove one printed sheet (by its id); Clear history is clearPrinted_.
function removePrintedSheet_(body) {
  var id = body && body.id;
  if (!id) return { ok: false, error: 'no-id' };
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheets = readPrinted_().filter(function (b) { return b.id !== id; });
    writePrinted_(sheets);
    return { ok: true, sheets: sheets.length };
  } finally { lock.releaseLock(); }
}
function clearPrinted_() {
  PropertiesService.getScriptProperties().deleteProperty(GC_PRINTED_PROP);
  return { ok: true, sheets: 0 };
}

/* ----- EOD digest email — "N card requests waiting" ----- *
 * GUARDRAIL: emails ONLY sky@ unless GC_DIGEST_TO_TAWNY === '1' (off by
 * default). Do not enable Tawny until approved. Skips sending if nothing
 * new since the last digest.
 * ------------------------------------------------------------------- */
var DIGEST_OWNER = 'sky@greencrosscanna.com';   // sendDigestTest always targets this (sky) only
var DIGEST_LAST_PROP = 'GC_DIGEST_LAST';

// EOD digest recipients. Sky approved adding Tawny on 2026-08-13.
// TODO (Sky's request): Sky plans to DROP OFF this list later — remove 'sky@…' then,
// leaving Tawny as the sole recipient.
var DIGEST_RECIPIENTS = ['sky@greencrosscanna.com', 'tawny@greencrosscanna.com'];
function digestRecipients_() { return DIGEST_RECIPIENTS.slice(); }
function esc_(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c];
  });
}
function buildDigestBody_(q, fresh) {
  var rows = q.map(function (e) {
    var c = e.card || {};
    var when = e.at ? e.at.slice(0,10) : '';
    return '<tr>'+
      '<td style="padding:5px 10px;border-bottom:1px solid #eee">'+esc_(c.brand)+'</td>'+
      '<td style="padding:5px 10px;border-bottom:1px solid #eee">'+esc_(c.item)+'</td>'+
      '<td style="padding:5px 10px;border-bottom:1px solid #eee">'+esc_(c.size)+'</td>'+
      '<td style="padding:5px 10px;border-bottom:1px solid #eee;text-align:right">$'+esc_(c.price)+'</td>'+
      '<td style="padding:5px 10px;border-bottom:1px solid #eee">'+esc_(c.store)+'</td>'+
      '<td style="padding:5px 10px;border-bottom:1px solid #eee;color:#888">'+esc_(when)+'</td>'+
    '</tr>';
  }).join('');
  return '<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">'+
    '<p><b>'+q.length+'</b> price card request'+(q.length===1?'':'s')+' waiting in the queue'+
    (fresh.length ? ' &middot; <b>'+fresh.length+'</b> new today' : '')+'.</p>'+
    '<table style="border-collapse:collapse;font-size:13px"><thead><tr>'+
      ['Brand','Item','Size','Price','Store','Submitted'].map(function(h){
        return '<th style="padding:5px 10px;text-align:left;border-bottom:2px solid #ccc">'+h+'</th>'; }).join('')+
    '</tr></thead><tbody>'+rows+'</tbody></table>'+
    '<p style="color:#888;font-size:12px;margin-top:14px">Green Cross price-card queue · automated daily summary.</p></div>';
}
// Trigger handler: send the digest only if there are new requests since last run.
function sendQueueDigest() {
  var props = PropertiesService.getScriptProperties();
  var last  = props.getProperty(DIGEST_LAST_PROP) || '';
  var q     = readQueue_();
  var fresh = q.filter(function (e) { return !last || (e.at && e.at > last); });
  props.setProperty(DIGEST_LAST_PROP, new Date().toISOString());
  if (!fresh.length) return { ok: true, sent: false, reason: 'nothing new' };
  var to = digestRecipients_();
  MailApp.sendEmail({
    to: to.join(','),
    subject: '🖨️ Price card queue — ' + q.length + ' waiting (' + fresh.length + ' new)',
    htmlBody: buildDigestBody_(q, fresh)
  });
  return { ok: true, sent: true, to: to, total: q.length, fresh: fresh.length };
}
// Run once in the editor to (re)install the daily end-of-day (~6pm PT) trigger.
function installDigestTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendQueueDigest') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendQueueDigest').timeBased().everyDays(1).atHour(18).create();
  return { ok: true, installed: 'daily ~6pm PT (EOD)' };
}
// Run in the editor to send yourself a sample digest now (forces send to sky@ only).
function sendDigestTest() {
  var q = readQueue_();
  MailApp.sendEmail({
    to: DIGEST_OWNER,
    subject: '🖨️ [TEST] Price card queue — ' + q.length + ' waiting',
    htmlBody: '<p style="font-family:Arial"><b>Test digest</b> (sent only to you).</p>' + buildDigestBody_(q, q)
  });
  return { ok: true, sentTo: DIGEST_OWNER, total: q.length };
}

/* ----- New-in-Dutchie detection — products that need a price-card tag ----- *
 * Daily scan diffs the Dutchie catalog against a baselined known-set; any
 * genuinely-new productIds accumulate in a "needs a tag" list the app shows.
 * Known-set is chunked across properties (can be thousands of ids).
 * ------------------------------------------------------------------------- */
var KNOWN_KEY = 'GC_KNOWN_PRODUCTS', NEWPROD_KEY = 'GC_NEW_PRODUCTS';
function _putBig_(key, str) {
  var props = PropertiesService.getScriptProperties(), all = props.getProperties();
  Object.keys(all).forEach(function (k) { if (k.indexOf(key + '__') === 0) props.deleteProperty(k); });
  var size = 8000, n = Math.ceil(str.length / size) || 1, o = {}; o[key + '__n'] = String(n);
  for (var i = 0; i < n; i++) o[key + '__' + i] = str.substr(i * size, size);
  props.setProperties(o);
}
function _getBig_(key) {
  var props = PropertiesService.getScriptProperties();
  var n = parseInt(props.getProperty(key + '__n') || '0', 10);
  if (!n) return '';
  var s = ''; for (var i = 0; i < n; i++) s += (props.getProperty(key + '__' + i) || '');
  return s;
}
// Map of productId -> {id,name,brand,category} across all stores' catalogs.
function buildProductDict_() {
  var stores = dutchieStores_();
  /* Six sequential proxy calls where there used to be one parallel fetchAll. This runs on the DAILY
     new-product scan against a 6-minute budget, so the few seconds it costs are a background job's,
     not a user's — and the trade buys this app having no Dutchie credential at all.
     A store that fails is SKIPPED, matching the previous behavior of skipping a non-200: the scan
     diffs against a known-set, and a store missing from the dict simply contributes no new ids. */
  var dict = {}, storeErrs = [];
  for (var i = 0; i < stores.length; i++) {
    var items;
    try { items = gxDutchieRows_('dutchie_products', stores[i], ''); }
    catch (e) { storeErrs.push(stores[i] + ': ' + ((e && e.message) || e)); continue; }
    for (var j = 0; j < items.length; j++) {
      var it = items[j], pid = it.productId;
      if (pid == null || dict[pid]) continue;
      var name = String(it.productName || '').trim();
      if (!name) continue;
      dict[pid] = { id: String(pid), name: name, brand: String(it.brandName || '').trim(),
                    category: String(it.masterCategory || it.category || '').trim() };
    }
  }
  /* Every store failing is a FAILURE, not an empty catalog. buildProductDict_ feeds the daily
     new-product diff; returning {} silently means "nothing new today", which is exactly how a
     broken integration looks identical to a quiet one. A partial failure still returns — the diff
     against the known-set is additive, so a missing store contributes no ids and costs nothing. */
  if (storeErrs.length) Logger.log('buildProductDict_: ' + storeErrs.length + ' store(s) failed — ' + storeErrs.join(' | '));
  if (storeErrs.length === stores.length) {
    throw new Error('buildProductDict_: all ' + stores.length + ' stores failed — ' + storeErrs.join(' | '));
  }
  return dict;
}
// Trigger handler: baseline on first run, else accumulate newly-seen products.
function scanNewProducts() {
  var props = PropertiesService.getScriptProperties();
  var dict = buildProductDict_(), ids = Object.keys(dict);
  var known = JSON.parse(_getBig_(KNOWN_KEY) || '[]'), knownSet = {};
  known.forEach(function (id) { knownSet[id] = true; });
  if (!known.length) {                                  // first run → baseline, nothing flagged
    _putBig_(KNOWN_KEY, JSON.stringify(ids));
    _putBig_(NEWPROD_KEY, '[]');
    return { ok: true, baselined: ids.length, 'new': 0 };
  }
  var fresh = ids.filter(function (id) { return !knownSet[id]; }).map(function (id) { return dict[id]; });
  var list = JSON.parse(_getBig_(NEWPROD_KEY) || '[]'), have = {};
  list.forEach(function (p) { have[p.id] = true; });
  fresh.forEach(function (p) { if (!have[p.id]) { list.push(p); have[p.id] = true; } });
  _putBig_(NEWPROD_KEY, JSON.stringify(list));
  _putBig_(KNOWN_KEY, JSON.stringify(ids));
  return { ok: true, 'new': fresh.length, pending: list.length };
}
function newProducts_() { return { ok: true, products: JSON.parse(_getBig_(NEWPROD_KEY) || '[]') }; }
function ackProducts_(body) {                            // staff handled/dismissed these
  var ids = (body && body.ids) || [], set = {}; ids.forEach(function (id) { set[String(id)] = true; });
  var list = JSON.parse(_getBig_(NEWPROD_KEY) || '[]').filter(function (p) { return !set[p.id]; });
  _putBig_(NEWPROD_KEY, JSON.stringify(list));
  return { ok: true, removed: ids.length, pending: list.length };
}
// Run once in the editor: daily 7am scan (before the 8am digest).
function installNewScanTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'scanNewProducts') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('scanNewProducts').timeBased().everyDays(1).atHour(7).create();
  return { ok: true, installed: 'daily ~7am' };
}

/* ===================== DUTCHIE — live active inventory ===================== *
 * Reads in-stock inventory per store from the Dutchie POS API so the card
 * builder can search real products with real per-store prices. Keys live in
 * Script Property DUTCHIE_STORE_KEYS_JSON = {"<store>":"<apiKey>", ...},
 * the same map the inventory app uses. Never hard-code keys here.
 * ------------------------------------------------------------------------- */
/* ─── DUTCHIE, THROUGH GX CORE. THIS APP HOLDS NO CREDENTIAL. ────────────────────────────────────
 *
 * Until 2026-08-31 this read its own DUTCHIE_STORE_KEYS_JSON — one of five copies across the suite,
 * in two different spellings. Rotating the six POS keys meant five paste jobs, and the May leak
 * survived a cleanup pass because a copy nobody remembered was left behind.
 *
 * Unlike Inventory and Leaderboard, this app never needs the key itself: every call here is a
 * per-store read that GX Core proxies directly. The one multi-store batch (buildProductDict_) runs
 * on the DAILY new-product scan, not on an interactive path, so trading one parallel fetchAll for
 * six sequential proxy calls costs a background job a few seconds and costs a user nothing.
 *
 * The deploy secret, NOT the connector secret: these routes return ROWS. Only the two apps that
 * genuinely need key material hold the connector secret, and this is not one of them.
 *
 * Store naming: GX Core resolves store_id, dutchie_name or display_name, so this app's existing
 * Dutchie-name vocabulary passes through unchanged and no rename was needed here.
 * ------------------------------------------------------------------------------------------------ */
function gxDeploySecret_() {
  var s = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET');
  if (!s) throw new Error('GX_DEPLOY_SECRET is not set on this engine — cannot reach GX Core for Dutchie data');
  return s;
}

/* One gated call to a GX Core dutchie_* route. Returns the rows array. `fields` trims the payload:
   an inventory pull is thousands of rows and this adds a hop. */
function gxDutchieRows_(action, store, fields) {
  var url = GXCORE_URL + '?action=' + encodeURIComponent(action)
          + '&store=' + encodeURIComponent(store)
          + '&secret=' + encodeURIComponent(gxDeploySecret_())
          + (fields ? '&fields=' + encodeURIComponent(fields) : '');
  var lastErr = '';
  for (var i = 0; i < 5; i++) {
    var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    var data = null;
    try { data = JSON.parse(resp.getContentText()); } catch (e) { lastErr = 'unparseable body'; }
    if (data && data.ok === true && Array.isArray(data.rows)) return data.rows;
    // A refusal is final — retrying a bad secret or an unknown store buries the message.
    if (data && data.ok === false) throw new Error(action + ': ' + (data.error || 'refused'));
    lastErr = lastErr || 'no rows in response';
    Utilities.sleep(400);   // the /exec second hop 404s on ~6% of rapid calls
  }
  throw new Error('GX Core ' + action + ' unreachable after 5 tries — ' + lastErr);
}

/* The store list now comes from the shared registry rather than from whichever labels happened to
   be in a local key map. That map was also the de-facto store list, which is how a stale label
   silently became a store this app believed in. */
function dutchieStores_() {
  var out = [];
  try {
    (GXCore.getStores() || []).forEach(function (s) {
      var dn = String(s.dutchie_name || '').trim();
      if (dn) out.push(dn);
    });
  } catch (e) {
    throw new Error('GX Core store registry unreachable: ' + ((e && e.message) || e));
  }
  if (!out.length) throw new Error('GX Core returned no stores');
  return out;
}

function priceOf_(it) {
  return Number(it.unitPrice || it.price || it.retailPrice || it.defaultUnitPrice || it.medPrice || it.recPrice || 0);
}

// Raw inventory items for a store from /reporting/inventory (one call, all fields).
function dutchieInventory_(store) {
  return gxDutchieRows_('dutchie_inventory', store, '');
}

// Diagnostic: see real field shapes + a few in-stock samples (for designing the conformance).
function dutchieProbe_(p) {
  var store = p.store || dutchieStores_()[0];
  var items = dutchieInventory_(store);
  var inStock = items.filter(function (it) { return Number(it.quantityAvailable || 0) > 0; });
  return {
    ok: true, store: store, total: items.length, inStock: inStock.length,
    fields: items.length ? Object.keys(items[0]) : [],
    sample: inStock.slice(0, 5)
  };
}

// Live catalog for the card builder — in-stock, deduped to one row per
// product, carrying the structured fields the browser uses to conform to
// house style. One store (?store=) or all stores merged.
function liveCatalog_(p) {
  var stores = p.store ? [p.store] : dutchieStores_();
  var map = {}, errors = {};
  for (var s = 0; s < stores.length; s++) {
    try {
      var inv = dutchieInventory_(stores[s]);
      for (var i = 0; i < inv.length; i++) {
        var it = inv[i];
        if (Number(it.quantityAvailable || 0) <= 0) continue;        // active = in stock
        var name = String(it.productName || '').trim();
        if (!name || /^sample\b/i.test(name)) continue;              // drop samples
        var price = priceOf_(it);
        if (price <= 0) continue;                                    // drop no-price lines
        var key = stores[s] + '|' + name + '|' + price;              // dedupe per product+price
        if (map[key]) { map[key].qty += Number(it.quantityAvailable || 0); continue; }
        map[key] = {
          store:      stores[s],
          brand:      String(it.brandName || '').trim(),
          name:       name,
          category:   String(it.masterCategory || it.category || '').trim(),
          strain:     String(it.strain || '').trim(),
          strainType: String(it.strainType || '').trim(),
          potencyMg:  it.effectivePotencyMg || '',
          unitWeight: it.unitWeight || '',
          unitWeightUnit: it.unitWeightUnit || '',
          size:       String(it.size || '').trim(),
          price:      String(price),
          recUnitPrice: Number(it.recUnitPrice) || 0,   // exact recreational OTD (tax-incl) shelf price
          sku:        it.sku || '',
          qty:        Number(it.quantityAvailable || 0)
        };
      }
    } catch (err) { errors[stores[s]] = String(err); }
  }
  var items = Object.keys(map).map(function (k) { return map[k]; });
  return { ok: true, count: items.length, stores: stores, errors: errors, items: items };
}
