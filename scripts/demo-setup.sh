#!/bin/sh
# Builds a throwaway "time-demo" space for screenshots in an isolated Herdr
# window, so the preview never shows anyone's real spaces or agents.
#
#   open -g -n -a Herdr --env HERDR_APP_HOME=$HOME/.cache/hh
#   HERDR_APP_HOME=$HOME/.cache/hh scripts/demo-setup.sh
#   ... start timers, shoot ...
#   HERDR_APP_HOME=$HOME/.cache/hh scripts/demo-setup.sh --teardown
#
# Spaces live in herdr-core and are shared by every Herdr window, so the demo
# space shows in other windows too until torn down.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
: "${HERDR_APP_HOME:?set HERDR_APP_HOME to an isolated Herdr home}"
DEMO=${DEMO:-/tmp/time-demo}
fake="$here/scripts/fake-agent.sh"
id_file="$DEMO/.space"

if [ "${1:-}" = "--teardown" ]; then
  # Wait before closing the window: a window quit mid-close left tabs behind.
  [ -f "$id_file" ] && herdr-app do space.close --id "$(cat "$id_file")" --confirmed true >/dev/null || true
  sleep 2
  rm -rf "$DEMO"
  exit 0
fi

mkdir -p "$DEMO/app"
[ -d "$DEMO/app/.git" ] || git -C "$DEMO/app" init -q -b main

json() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "$@"; }
field() { python3 -c 'import json,sys; print(json.load(sys.stdin)[sys.argv[1]])' "$1"; }

out=$(herdr-app do space.new --name time-demo --folder "$DEMO/app" \
  --argv "$(json "$fake" working "Ship the release notes" \
    "● Reading CHANGELOG.md" "● Writing docs/release-2.4.md" "  + 58 lines" "● Running the link checker")")
space=$(printf %s "$out" | field space)
printf %s "$space" > "$id_file"
herdr-app do tab.new --space "$space" --folder "$DEMO/app" \
  --argv "$(json "$fake" done "Fix the flaky upload test" "● Done: 3 runs green")" >/dev/null
echo "space $space"
