#!/usr/bin/env bash
# Safety net: checkpoint every 10 min. Run in its own terminal tab: scripts/autocommit.sh
# Stop with Ctrl+C. Manual commits with meaningful messages are still preferred.
while true; do sleep 600; "$(dirname "$0")/checkpoint.sh" "auto checkpoint"; done
