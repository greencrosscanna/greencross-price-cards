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
  try {
    var stores = dutchieStores_();
    for (var i = 0; i < stores.length; i++) {
      try {
        var hdrs = { Authorization: dutchieAuth_(stores[i]), Accept: 'application/json' };
        var r = UrlFetchApp.fetch(DUTCHIE_BASE + '/whoami', { headers: hdrs, muteHttpExceptions: true });
        report.dutchie[stores[i]] = 'HTTP ' + r.getResponseCode();
      } catch (e2) { report.dutchie[stores[i]] = 'ERR ' + e2.message; }
    }
  } catch (e1) { report.dutchie = 'keys not set: ' + e1.message; }
  Logger.log('Authorized. ' + JSON.stringify(report));
  return report;
}

/* ---------------------------- READ ---------------------------- */
function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    switch (p.action) {
      case 'stores':       return json({ ok: true, stores: dutchieStores_() });
      case 'dutchieProbe': return json(dutchieProbe_(p));
      case 'liveCatalog':  return json(liveCatalog_(p));
      case 'getConfig':    return json(getConfig_());
      case 'getQueue':     return json(getQueue_());
      case 'newProducts':  return json(newProducts_());
      case 'scanNow':      return json(scanNewProducts());
    }
    // default: read the bound Sheet
    var sheet  = pickSheet(p.gid);
    var values = sheet.getDataRange().getValues();
    var grid   = values.map(function (row) {
      return row.map(cellToString);
    });
    return json({ ok: true, grid: grid, rows: grid.length });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

/* --------------------------- WRITE ---------------------------- */
function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.action === 'saveConfig')  return json(saveConfig_(body));
    if (body.action === 'submitCards') return json(submitCards_(body));
    if (body.action === 'queueRemove') return json(queueRemove_(body));
    if (body.action === 'clearQueue')  return json(clearQueue_());
    if (body.action === 'ackProducts') return json(ackProducts_(body));
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
function submitCards_(body) {
  var cards = (body && body.cards) || [];
  if (!cards.length) return { ok: false, error: 'no-cards' };
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var q = readQueue_();
    var now = new Date().toISOString(), by = String(body.by || '');
    for (var i = 0; i < cards.length; i++) {
      q.push({ id: Utilities.getUuid(), card: cards[i], by: by, at: now });
    }
    writeQueue_(q);
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

/* ----- EOD digest email — "N card requests waiting" ----- *
 * GUARDRAIL: emails ONLY sky@ unless GC_DIGEST_TO_TAWNY === '1' (off by
 * default). Do not enable Tawny until approved. Skips sending if nothing
 * new since the last digest.
 * ------------------------------------------------------------------- */
var DIGEST_OWNER = 'sky@greencrosscanna.com';
var DIGEST_LAST_PROP = 'GC_DIGEST_LAST';
var DIGEST_TAWNY_PROP = 'GC_DIGEST_TO_TAWNY';

function digestRecipients_() {
  var to = [DIGEST_OWNER];
  if (PropertiesService.getScriptProperties().getProperty(DIGEST_TAWNY_PROP) === '1') {
    to.push('tawny@greencrosscanna.com');
  }
  return to;
}
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
// Run once in the editor to (re)install the daily 8am trigger.
function installDigestTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendQueueDigest') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendQueueDigest').timeBased().everyDays(1).atHour(8).create();
  return { ok: true, installed: 'daily ~8am' };
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
  var reqs = stores.map(function (s) {
    return { url: DUTCHIE_BASE + '/products', headers: { Authorization: dutchieAuth_(s), Accept: 'application/json' }, muteHttpExceptions: true };
  });
  var resps = UrlFetchApp.fetchAll(reqs), dict = {};
  for (var i = 0; i < resps.length; i++) {
    if (resps[i].getResponseCode() !== 200) continue;
    var raw = JSON.parse(resps[i].getContentText());
    var items = Array.isArray(raw) ? raw : (raw.data || raw.items || []);
    for (var j = 0; j < items.length; j++) {
      var it = items[j], pid = it.productId;
      if (pid == null || dict[pid]) continue;
      var name = String(it.productName || '').trim();
      if (!name) continue;
      dict[pid] = { id: String(pid), name: name, brand: String(it.brandName || '').trim(),
                    category: String(it.masterCategory || it.category || '').trim() };
    }
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
var DUTCHIE_BASE = 'https://api.pos.dutchie.com';
var DUTCHIE_STORE_KEYS_PROP = 'DUTCHIE_STORE_KEYS_JSON';

function getDutchieStoreKeys_() {
  var raw = PropertiesService.getScriptProperties().getProperty(DUTCHIE_STORE_KEYS_PROP);
  if (!raw) throw new Error('DUTCHIE_STORE_KEYS_JSON is not set in Script Properties.');
  return JSON.parse(raw);
}
function dutchieStores_() { return Object.keys(getDutchieStoreKeys_()); }
function dutchieAuth_(store) {
  var key = getDutchieStoreKeys_()[store];
  if (!key) throw new Error('No Dutchie key for store: ' + store);
  return 'Basic ' + Utilities.base64Encode(key + ':');   // POS API: key as username, blank password
}

function priceOf_(it) {
  return Number(it.unitPrice || it.price || it.retailPrice || it.defaultUnitPrice || it.medPrice || it.recPrice || 0);
}

// Raw inventory items for a store from /reporting/inventory (one call, all fields).
function dutchieInventory_(store) {
  var hdrs = { Authorization: dutchieAuth_(store), Accept: 'application/json' };
  var resp = UrlFetchApp.fetch(DUTCHIE_BASE + '/reporting/inventory', { headers: hdrs, muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) throw new Error('Dutchie HTTP ' + resp.getResponseCode() + ' (' + store + ')');
  var raw = JSON.parse(resp.getContentText());
  return Array.isArray(raw) ? raw : (raw.data || raw.items || []);
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
          sku:        it.sku || '',
          qty:        Number(it.quantityAvailable || 0)
        };
      }
    } catch (err) { errors[stores[s]] = String(err); }
  }
  var items = Object.keys(map).map(function (k) { return map[k]; });
  return { ok: true, count: items.length, stores: stores, errors: errors, items: items };
}
