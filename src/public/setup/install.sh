#!/bin/sh
# gtm-router installer. Installs the gtm CLI into ~/.gtm/bin.
# It writes only inside that folder. No sudo. No other config is touched until you run `gtm connect`.
#
#   curl -fsSL {{HOST}}/install.sh | sh
#   curl -fsSL {{HOST}}/install.sh | sh -s -- --token <token>   # also signs in and connects
set -eu

HOST="{{HOST}}"
DIR="${GTM_HOME:-$HOME/.gtm}"
TOKEN=""

while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="${2:-}"; [ -n "$TOKEN" ] || { echo "--token needs a value" >&2; exit 2; }; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

command -v curl >/dev/null 2>&1 || { echo "curl is required." >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "gtm needs Node.js 18 or newer: https://nodejs.org" >&2; exit 1; }
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 18 ] || { echo "gtm needs Node.js 18 or newer (found $major)." >&2; exit 1; }

echo "Installing gtm from $HOST"
mkdir -p "$DIR/bin"
chmod 700 "$DIR"
curl -fsSL "$HOST/gtm.mjs" -o "$DIR/bin/gtm.mjs.tmp"
mv "$DIR/bin/gtm.mjs.tmp" "$DIR/bin/gtm.mjs"
printf '#!/bin/sh\nexec node "%s/bin/gtm.mjs" "$@"\n' "$DIR" > "$DIR/bin/gtm"
chmod +x "$DIR/bin/gtm"

echo "Wrote: $DIR/bin/gtm and $DIR/bin/gtm.mjs"

if [ -n "$TOKEN" ]; then
  "$DIR/bin/gtm" login --token "$TOKEN"
  "$DIR/bin/gtm" connect
else
  echo "Next:"
  echo "  $DIR/bin/gtm login --token <token>"
  echo "  $DIR/bin/gtm connect"
fi
