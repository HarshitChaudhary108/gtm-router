#!/bin/sh
# outmate installer. Installs the outmate CLI into ~/.outmate/bin.
# It writes only inside that folder. No sudo. No other config is touched until you run `outmate connect`.
#
#   curl -fsSL {{HOST}}/install.sh | sh
#   curl -fsSL {{HOST}}/install.sh | sh -s -- --token <token>   # also signs in and connects
set -eu

HOST="{{HOST}}"
DIR="${OUTMATE_HOME:-$HOME/.outmate}"
TOKEN=""

while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="${2:-}"; [ -n "$TOKEN" ] || { echo "--token needs a value" >&2; exit 2; }; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

command -v curl >/dev/null 2>&1 || { echo "curl is required." >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "outmate needs Node.js 18 or newer: https://nodejs.org" >&2; exit 1; }
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 18 ] || { echo "outmate needs Node.js 18 or newer (found $major)." >&2; exit 1; }

echo "Installing outmate from $HOST"
mkdir -p "$DIR/bin"
chmod 700 "$DIR"
curl -fsSL "$HOST/outmate.mjs" -o "$DIR/bin/outmate.mjs.tmp"
mv "$DIR/bin/outmate.mjs.tmp" "$DIR/bin/outmate.mjs"
printf '#!/bin/sh\nexec node "%s/bin/outmate.mjs" "$@"\n' "$DIR" > "$DIR/bin/outmate"
chmod +x "$DIR/bin/outmate"

echo "Wrote: $DIR/bin/outmate and $DIR/bin/outmate.mjs"

if [ -n "$TOKEN" ]; then
  "$DIR/bin/outmate" login --token "$TOKEN"
  "$DIR/bin/outmate" connect
else
  echo "Next:"
  echo "  $DIR/bin/outmate login --token <token>"
  echo "  $DIR/bin/outmate connect"
fi
