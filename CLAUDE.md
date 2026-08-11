# Price Cards (app key `pricecards`) — GX app · Inventory sub-app

Part of the Green Cross app suite, and a **sub-app of Inventory** (the shelf price-card / menu generator).
The **GX Command Center** (GX Core) is the shared "brain": shared sign-on, stores registry, Dutchie
connector, and the centralized bug-report + release-note + coordination logs all live there. Frontend:
`index.html` + `generator.js` (GitHub Pages); backend: `apps-script/Code.gs` (clasp). Its app key in GX
Core is **`pricecards`**.

## Sync with the brain — run `/gxbrain` (or say "brain sync")

This app is on the shared brain. **`/gxbrain`** loads the shared rules and reconciles this chat with GX Core
— the sync protocol lives in that one command. **"brain sync" / "sync brain"** = the reconcile-and-report
step alone (skips orientation).

Coordination is the **central brain-notes inbox** in GX Core: `/gxbrain` and the SessionStart hook read
notes addressed to **`to_app=pricecards`**, resolve done ones (`resolve_note`), and write note-backs to any
app (`add_note`). As an Inventory sub-app, its **bug reports** bucket to **Inventory** (`app=inventory`,
`tab=pricecards`), not to a separate `pricecards` bug stream — don't conflate the notes key with the bug tab.

Integration status (2026-08-11): notes channel live. **Auto-record on deploy** wired — `deploy.sh`
POSTs `deploy_version` (app=pricecards) to GX Core; `APP_VERSION` (vNN) is single-sourced from the
`?v=` cache-buster in `index.html`. Run `deploy.sh` after each ship (releases show in `version_history`).
**gx-theme** linked (`gx-theme.css` — `--gx-*` tokens available; kept light, no restyle of the bespoke
generator/doodle canvas). **Bug forwarding: deferred** — app not in standalone use yet + embedded in
Inventory (its reporter covers it); when warranted, forward via `GXCore.gxIngestBug('inventory', reporter,
{tab:'pricecards', …})`. **GXCore library script id (from CC):**
`1sfa3quXRgk6JiDzsHgzG7DgMaxN9XJv2LnNapAT2gCss0ghblufvOTjP` — add to `appsscript.json`
`dependencies.libraries` (userSymbol `GXCore`, latest version) + engine redeploy when wiring. Still not bound to
`GXCore` for shared login (separate future follow-up). **Stores** are pulled live from GX Core
`?action=stores` (`loadStores()` builds `STORE_MAP` from `dutchie_name→display_name` by `sort_order`;
local hardcode is offline fallback only) — don't re-hardcode store names; CC edits flow on next load.
