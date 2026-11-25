# Project rules (read first)

Stack: Node 22 (TypeScript or JS), React, MongoDB, Redis. Services (Pigeon :4010, Mock IdP :4020, Paybox :4030) run locally via the packet's compose/mocks.
App listens on :4000. 2-hour timebox; the brief is intentionally bigger than the time. Build the core flow first, correctly.

## Workflow
- Run the provided checker after EVERY feature; read its failures before coding more. Only paste failing lines, not full logs.
- Commit small and often (at least every 15 min). Never leave work uncommitted.
- Keep edits minimal; no unrequested refactors, no new dependencies unless needed.
- Backend first, UI minimal and working.

## Reliability rules (the checker kills/restarts the process, runs several copies, breaks the network)
- No state in process memory. Persist in Mongo/Redis. Server must be safe to kill -9 at any time and restart.
- Multiple instances at once: use atomic ops (findOneAndUpdate, $inc, unique indexes, Redis SET NX/locks). Never read-then-write.
- Idempotency keys on every side-effecting op (payments, messages). Retries must never double-charge or double-send.
- Timeouts on every outbound call; retry with exponential backoff + jitter; handle 5xx/timeouts from Pigeon/Paybox.
- Validate input; return correct HTTP status codes; /healthz endpoint; graceful SIGTERM shutdown.
- Where the brief is silent: decide, record it in DECISIONS.md, move on.

## Honesty
- README and DECISIONS.md must state what is NOT done and what would happen. Do not claim unverified behavior.

@AGENTS.md
@PRD.md
