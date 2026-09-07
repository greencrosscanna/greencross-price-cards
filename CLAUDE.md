# Price Cards (app key `pricecards`) — GX app · Inventory sub-app

Part of the Green Cross app suite, and a **sub-app of Inventory** (the shelf price-card / menu generator).
The **GX Command Center** (GX Core) is the shared "brain": shared sign-on, stores registry, Dutchie
connector, and the centralized bug-report + release-note + coordination logs all live there. Frontend:
`index.html` + `generator.js` (GitHub Pages); backend: `apps-script/Code.gs` (clasp). Its app key in GX
Core is **`pricecards`**.

## Stack & local loop

**No build step — the file on disk IS the app.**

| | |
|---|---|
| frontend | `index.html` + `generator.js` + `generator.css` on GitHub Pages; also `fonts.css`, `style/`, `doodle-bg.svg`, `align-template.png` |
| backend | `apps-script/Code.gs` + `apps-script/appsscript.json`, deployed with clasp |
| version | the **`?v=` cache-buster** in `index.html` — single source of truth for `deploy.sh` |
| run | `python3 serve.py` → <http://localhost:8753> |
| ship | commit → push (Pages) → `./deploy.sh` |
| tests | no automated suite — verify against the live app |

**`serve.py` here exits with a clear error if the app key is missing from its `PORTS` table** rather than
falling back to a default. Don't reintroduce a fallback: the old default was **8181 — Leaderboard's real
port, not a free one** — so a missing key silently collided with a running server instead of failing. This
app hit exactly that (keyed `pricecards`, table said `pricetags`; the preview opened 8753 while the server
listened on 8181).

The dev server talks to the **live** backend; `gx-dev.js` blocks writes until armed. `gx-preflight.sh` runs
as a **pre-push hook** and refuses dev leftovers.

**Shared files** (`deploy.sh`, `serve.py`, `gx-preflight.sh`, `.claude/gx-brain-notes.sh`) come from
**gx-theme** via `./gx-sync.sh`, filled from `.gx_app`. Edit them **there**, then re-sync. This CLAUDE.md is
intentionally **not** synced.

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

**What to build next — `/gxwhatsnext`:** run `/gxwhatsnext` in this chat to pull this app's next prioritized work — the Command Center's dependency-ordered build sequence, filtered to this app — so you can build here without switching to the CC. It reads the app key above automatically.

**Close the loop when you're done:** When a dispatched or `/gxwhatsnext`-started task's goals look met — the moment you'd naturally say "that should do it" — proactively tell Sky and **offer to ship/close it out; don't wait to be asked.** Shipping (spoke apps: open/return the PR → `dev_update … status=in_review`; on merge → `dev_ship`; `core-admin` deploys directly → `dev_ship`) auto-completes the Asana to-do and clears it from the Command Center. Find the job via `dev_queue` (filtered to this app) when you need its id for the `curl` — but **refer to it by its `title`, never its id**. `job_mtg9vyxs_ewd9` means nothing to Sky; every job carries the to-do text in the same response the id came from, so say that instead, summarized if it's long ("the employee email column"). Same for `bug_…` and note ids. **Then re-list what's open, numbered `[1] [2] [3]…`, instead of proposing a next task** — re-fetch `action=whats_next` (the board moved while you worked) and let Sky pick by number rather than from memory.


## The HUB is core-admin's — send a note, don't edit (rule from Sky, 2026-09-02 · applied here 2026-09-06)

**Never edit `greencross-command-center` or `greencross-gx-theme` from this chat.** Both belong to
core-admin. It is here because it was broken, not because it was theorized.

On 2026-09-02 a spoke session made a small, correct, tested fix to GX Core and put it on a branch for
Sky to merge, because Core library cuts are PR-gated. **Another Claude session had the same repo open
at the same time.** These repos are Dropbox-synced, so the two sessions shared one working tree and
one HEAD: the branch was switched out from under the first session, its commit landed on `main`
instead, and the other session pushed `main` and shipped it. The change went out as library v284 with
no PR and no review. The code was fine — that is the point. Nothing failed, nothing warned, and the
gate on the highest-stakes repo in the suite simply was not there that time.

Two sessions cannot share a git checkout. Neither can see the other, `git checkout -b` is not atomic
against a second process, and the loser finds out afterwards by reading the log.

**So from Price Cards: `add_note` to `core-admin` with what you need and why, and stop.** Requests are welcome
and quick, and the hub session holds the repo alone while it works.

**Where the line is, because over-applying this is its own failure:**

- **Reading the hub is fine and often necessary** — `gx_core.gs` is the source of truth for every
  route Price Cards calls, and guessing a payload shape instead of reading it is how this suite invented a
  `spiff_payouts` tab that never existed. Read freely; run `./gxpins.sh`; diff against it.
- **Calling GX Core's HTTP routes is not editing it.** `deploy.sh`, `gxengine.sh`, `set_config`,
  `bug_update`, `resolve_note`, `add_note` and the rest are the documented interface, secret-gated and
  designed for exactly this. Changing a *setting* through `set_config` is a config change Price Cards owns;
  changing *code* is not.
- **Do not restyle a shared component from inside Price Cards either.** A local rule that beats `.gx-btn-green`
  wins here and silently diverges from the other five — that is how the suite ended up with six
  different login screens. The test is *"should all six get this?"*
- **Price Cards's own engine and repo are still yours.** `clasp push` / `./deploy.sh` here touch only this app.
