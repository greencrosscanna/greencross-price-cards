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

// Conformed live catalog for the card builder. One store (?store=) or all merged.
function liveCatalog_(p) {
  var stores = p.store ? [p.store] : dutchieStores_();
  var items = [], errors = {};
  for (var s = 0; s < stores.length; s++) {
    try {
      var inv = dutchieInventory_(stores[s]);
      for (var i = 0; i < inv.length; i++) {
        var it = inv[i];
        if (Number(it.quantityAvailable || 0) <= 0) continue;   // active = in stock
        items.push({
          store:    stores[s],
          brand:    String(it.brandName || '').trim(),
          name:     String(it.productName || '').trim(),
          category: String(it.masterCategory || it.category || '').trim(),
          size:     String(it.size || it.unitWeight || it.netWeight || it.weight || '').trim(),
          sku:      it.sku || '',
          price:    priceOf_(it) ? String(priceOf_(it)) : '',
          qty:      Number(it.quantityAvailable || 0)
        });
      }
    } catch (err) { errors[stores[s]] = String(err); }
  }
  return { ok: true, count: items.length, stores: stores, errors: errors, items: items };
}
