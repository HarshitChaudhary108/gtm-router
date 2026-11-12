#!/bin/sh
# Cold-start demo of the outmate one-line setup, as an agent would run it.
#   PKG   what npx installs: "outmate" (from npm) or a path to a packed .tgz
#   HOST  the public outmate URL
#   OUTMATE_HOME is a fresh folder, so this starts with nothing saved. The token is never printed.
set -eu
cd "$(dirname "$0")/.."
PKG="${PKG:-outmate}"
HOST="${HOST:-https://goldsmith-panther-exporter.ngrok-free.dev}"
export OUTMATE_HOME="$(mktemp -d)/outmate"
export npm_config_yes=true
step() { printf '\n\033[1m$ %s\033[0m\n' "$*"; }
outmate() { npx -y --package "$PKG" outmate "$@"; }

TOKEN=$(npm run -s token -- create "demo-$(date +%H%M%S)" | grep '^outmate_')

step "curl -s $HOST/llms.txt | head -5"
curl -s "$HOST/llms.txt" | head -5

step "npx -y outmate --version"
outmate --version

step "outmate login --url $HOST --token <token>"
outmate login --url "$HOST" --token "$TOKEN"

step "outmate"
outmate

step "outmate connect"
outmate connect

step 'outmate search "Find engineering leaders at vercel.com"'
outmate search "Find engineering leaders at vercel.com" || true
