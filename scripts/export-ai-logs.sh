#!/usr/bin/env bash
# Copies raw Claude Code transcripts for this project into ai-logs/. Also run /export inside Claude Code.
set -u
cd "$(git rev-parse --show-toplevel)" || exit 1
key="$(pwd | sed 's#[/.]#-#g')"
src="$HOME/.claude/projects/$key"
mkdir -p ai-logs
if [ -d "$src" ]; then cp -n "$src"/*.jsonl ai-logs/ 2>/dev/null; cp -f "$src"/*.jsonl ai-logs/ 2>/dev/null; echo "copied from $src"; else echo "no transcripts at $src; use /export manually"; fi
ls -la ai-logs
