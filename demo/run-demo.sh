#!/bin/sh
# Cold-start demo of the gtm-router one-line setup, as an agent would run it.
#   PKG   what npx installs: "outmate" (from npm) or a path to a packed .tgz
#   HOST  the public gtm-router URL
#   GTM_HOME is a fresh folder, so this starts with nothing saved. The token is never printed.
set -eu
cd "$(dirname "$0")/.."
PKG="${PKG:-outmate}"
HOST="${HOST:-https://goldsmith-panther-exporter.ngrok-free.dev}"
export GTM_HOME="$(mktemp -d)/gtm"
export npm_config_yes=true
step() { printf '\n\033[1m$ %s\033[0m\n' "$*"; }
gtm() { npx -y --package "$PKG" gtm "$@"; }

TOKEN=$(npm run -s token -- create "demo-$(date +%H%M%S)" | grep '^gtm_')

step "curl -s $HOST/llms.txt | head -5"
curl -s "$HOST/llms.txt" | head -5

step "npx -y outmate --version"
gtm --version

step "gtm login --url $HOST --token <token>"
gtm login --url "$HOST" --token "$TOKEN"

step "gtm"
gtm

step "gtm connect"
gtm connect

step 'gtm search "Find engineering leaders at vercel.com"'
gtm search "Find engineering leaders at vercel.com" || true
