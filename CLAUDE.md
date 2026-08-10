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

Integration status (2026-08-09): notes channel just scaffolded. Not yet bound to `GXCore` for
login/changelog/auto-record — those are optional follow-ups (see the inbox for queued tasks).
