#!/usr/bin/env bash
# Commit (and push if a remote exists) everything. Usage: scripts/checkpoint.sh "message"
set -u
cd "$(git rev-parse --show-toplevel)" || exit 1
msg="${1:-checkpoint}"
git add -A
if git diff --cached --quiet; then echo "nothing to commit"; else git commit -q -m "$msg ($(date +%H:%M))" && echo "committed: $msg"; fi
if git remote get-url origin >/dev/null 2>&1; then
  git push -q origin HEAD 2>&1 && echo "pushed" || echo "PUSH FAILED (will retry next checkpoint; keep working)"
else echo "no remote yet (add origin)"; fi
git log --oneline -1
