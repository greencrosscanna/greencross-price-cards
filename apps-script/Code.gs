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

/* ---------------------------- READ ---------------------------- */
function doGet(e) {
  try {
    var sheet  = pickSheet(e && e.parameter && e.parameter.gid);
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
