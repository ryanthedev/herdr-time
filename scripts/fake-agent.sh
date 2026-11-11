#!/bin/sh
# A stand-in agent for demo screenshots: sets a title, reports an agent status
# to herdr-core (OSC 7501), prints a few lines, then waits.
#   fake-agent.sh <working|blocked|done|idle> <title> [line...]
state=$1 title=$2
shift 2
printf '\033]2;%s\007' "$title"
printf '\033]7501;state=%s:app=claude-code\007' "$state"
printf '\033[1m%s\033[0m\n\n' "$title"
for line in "$@"; do printf '%s\n' "$line"; done
exec sleep 86400
