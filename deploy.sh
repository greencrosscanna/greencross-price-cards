#!/usr/bin/env bash
# Record a Price Cards release in the GX Core shared version log.
# Run AFTER you ship (git push to Pages / clasp deploy the engine).
#   Usage:  GX_NOTES="what changed this release" ./deploy.sh
# Version is single-sourced from the ?v=NN cache-buster in index.html.
set -euo pipefail
cd "$(dirname "$0")"

GXCORE="https://script.google.com/macros/s/AKfycbx9mjeCBbDpxNYaqBv2hyZaO1hpbGG6PZM9AebFdwl0UwkdtRCGSWrH-8ohEtdF1K_6/exec"
SECRET="$(cat .gx_deploy_secret)"
APP_VERSION="v$(grep -oE 'generator\.js\?v=[0-9]+' index.html | grep -oE '[0-9]+' | head -1)"
SHA="$(git rev-parse --short HEAD)"
GX_NOTES="${GX_NOTES:-}"

echo "Recording pricecards ${APP_VERSION} (${SHA}) to GX Core…"
curl -sL -G "$GXCORE" --data-urlencode action=deploy_version --data-urlencode "secret=$SECRET" \
  --data-urlencode app=pricecards --data-urlencode "version=$APP_VERSION" \
  --data-urlencode "sha=$SHA" --data-urlencode "notes=$GX_NOTES"
echo
