# GX Price Cards — Shelf Label Generator

Print-ready cannabis shelf labels (Avery 95271, 9-up on US Letter), generated from a
Google Sheet. Staff open a web page, **Import** from the Sheet, tick the labels they want,
and **Generate** a print sheet.

This bundle is **production code**, not a mockup — it's the working app plus the Apps Script
data engine, laid out to match a *GitHub Pages front-end + Google Apps Script back-end* stack.

---

## Architecture

```
Staff browser ──▶ GitHub Pages (this folder: index.html + CSS/JS)   ← the UI AND the label design
                        │  fetch (read rows / write "Done")
                        ▼
              Apps Script Web App  /exec   ← apps-script/Code.gs
                        │  runs as you (owner)
                        ▼
                 Google Sheet (can stay PRIVATE)   ← the data
```

- **The label design lives only in the front-end** (`generator.css` positions/sizes, `generator.js`
  renders each label). The Apps Script is a *thin data engine* — it never draws labels, so there is
  no second copy of the design to keep in sync.
- The front-end can also run in **read-only mode** with no engine, by reading a *public* CSV link
  (the Sheet must then be shared "Anyone with the link"). The engine is what lets the Sheet stay
  private and enables write-back.

---

## Repo layout

```
index.html            Entry point (GitHub Pages serves this automatically)
generator.css         All label geometry + UI styling  (the design source of truth)
generator.js          UI logic, Sheet import, column mapping, print
fonts.css             Brand fonts, embedded as data URIs (self-contained, ~270 KB)
align-template.png    Optional alignment overlay (toggle in the UI)
apps-script/
  Code.gs             The data engine: doGet (read rows) + doPost (mark Done)
  appsscript.json     Manifest (web-app config + minimal scope)
.nojekyll             Tells GitHub Pages to serve files as-is
```

---

## Deploy — Part A: front-end on GitHub Pages

1. Put the contents of this folder in a repo (root, or a `/docs` folder).
2. Repo **Settings ▸ Pages ▸ Build and deployment**: Source = *Deploy from a branch*,
   pick the branch and folder (root or `/docs`).
3. Pages serves `index.html`. Note the published URL (e.g. `https://<you>.github.io/<repo>/`).

No build step — it's static files.

## Deploy — Part B: the Apps Script engine

1. Open the **Google Sheet** ▸ **Extensions ▸ Apps Script**.
2. Replace the default file's contents with **`apps-script/Code.gs`**. (Optionally set the
   manifest to match `appsscript.json` via Project Settings ▸ "Show appsscript.json".)
3. **Deploy ▸ New deployment ▸ Web app**
   - **Execute as:** Me
   - **Who has access:** Anyone  *(required — the hosted page calls it without a Google login)*
4. Authorize when prompted. Copy the **Web app URL** (ends in `/exec`).
   > Re-deploying after code edits: use **Manage deployments ▸ Edit ▸ New version** so the
   > same `/exec` URL keeps working.

## Connect them — Part C

1. Open the published app.
2. **⚙ Sheet settings** ▸ paste the `/exec` URL into **Data engine URL**.
3. Leave **"After importing, mark those rows Done"** checked.
4. Click **Import from Google Sheet**. Done.

(The "Google Sheet link" field at the top is only used to pass the tab's `gid` to the engine,
and as the fallback CSV source if no engine URL is set.)

---

## What the app does on import

- **Reads** every row from the Sheet (through the engine, or via public CSV).
- **Skips** any row whose **Done** column is checked/`TRUE` — already-printed items don't come back.
- **Auto-maps** Sheet columns to label fields (editable in the "Match columns" panel; choices persist
  in `localStorage` under `gcLabels.colMap.v1`).
- **Defaults Print = ON** for every imported row, so they're queued immediately.
- After a successful import, **POSTs back** to mark those rows **Done** in the Sheet
  (engine mode only; toggle in Sheet settings).

## Sheet requirements

- Row 1 = headers. Recommended columns (names are flexible — the mapper handles synonyms):
  `Brand`, `Item Name`, `Description 1`, `Description 2`, `Size`, `Price`, `Store`, `Done`.
- The current saved mapping is: **Name←Brand, Product←Item Name, Description←Description 1,
  Description 2←Description 2, Size, Price, Store, Done**. Change it any time in the panel.
- Make **Done** a checkbox column (Insert ▸ Checkbox) for the cleanest look — plain `TRUE`/`x` works too.
- Required per label: **Name** and **Price**. (Product is optional.)

## Notes for a developer

- **CORS:** GET to a GAS `/exec` 302-redirects to `script.googleusercontent.com`, which serves
  CORS-open JSON — readable from the browser. The write POST uses `Content-Type: text/plain` to
  avoid a preflight (GAS doesn't answer `OPTIONS`); the redirected response is still readable.
- **State:** the print queue, column mapping, sheet URL, and engine URL all live in `localStorage`
  (per machine). The Sheet is the shared source of truth; per-machine state is just convenience.
- **Printing:** "Generate label sheets" builds 9-up pages into `#printRoot` and calls
  `window.print()`. Print at **100% / Actual size** on Avery 95271 stock.
- **Scopes:** the manifest requests only `spreadsheets.currentonly` (container-bound script).
  If you make the script standalone instead, switch to `spreadsheets` and open the Sheet by ID.

## Troubleshooting

- *"Can't read the sheet"* — engine not reachable or, in CSV mode, the Sheet isn't public.
- *Write-back issue: no-done-column* — add/rename a **Done** column, or remap it in the panel.
- *Nothing imports* — all rows may already be marked **Done** (expected); uncheck some in the Sheet.
