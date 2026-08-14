#!/bin/sh
# SessionStart hook: surface pending brain-notes addressed to THIS app, read from GX Core's central inbox
# (brain_notes). Cross-app handoffs live in GX Core, so a note addressed to this app reaches it no matter
# which chat wrote it. Fails silent (no secret / offline).
#
# GX Core's /exec is a two-hop redirect that intermittently serves a Drive HTML error page instead of JSON
# (~6%). A single fetch would silently drop the inbox on that miss (this is how the rec-price note was lost),
# so we RETRY until we get real JSON. Typical cost is one fast call; retries only fire on the flake.
APP="pricecards"
GXCORE="https://script.google.com/macros/s/AKfycbx9mjeCBbDpxNYaqBv2hyZaO1hpbGG6PZM9AebFdwl0UwkdtRCGSWrH-8ohEtdF1K_6/exec"
[ -f ".gx_deploy_secret" ] || exit 0
SECRET=$(cat .gx_deploy_secret)

resp=""
i=1
while [ "$i" -le 4 ]; do
  resp=$(curl -sL --max-time 6 -G "$GXCORE" \
    --data-urlencode "action=notes" \
    --data-urlencode "secret=$SECRET" \
    --data-urlencode "app=$APP" \
    --data-urlencode "status=pending" 2>/dev/null)
  # Accept only a JSON object; the flake returns an HTML doc ("<!DOCTYPE ...").
  case "$resp" in
    \{*) break ;;
  esac
  resp=""
  i=$((i + 1))
  [ "$i" -le 4 ] && sleep 2
done
[ -n "$resp" ] || exit 0

printf '%s' "$resp" | python3 -c '
import sys, json
try: d = json.load(sys.stdin)
except Exception: sys.exit(0)
notes = d.get("notes") or []
if not notes: sys.exit(0)
print("\U0001F4CB Brain notes from GX Core — pending for %s (%d):" % (d.get("app", "this app"), len(notes)))
for n in notes:
    print("  • [%s] %s  (from %s)" % (n.get("id", ""), n.get("title", ""), n.get("from_app") or "?"))
    body = (n.get("body") or "").strip()
    if body: print("      " + body.replace("\n", "\n      "))
print("  → run /gxbrain to act on these; resolve_note when done.")
' 2>/dev/null
exit 0
