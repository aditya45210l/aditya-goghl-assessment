# AGENTS.md - rules for every AI agent working in this repo
(CLAUDE.md imports this. Follow it strictly.)

## 1. Commit cadence (hard rule)
- Commit AFTER EVERY working increment and never go more than 10 minutes without one (limit is 15).
- Use: `scripts/checkpoint.sh "feat: short message"`  (adds, commits, pushes; push failure is non-fatal, retry next time).
- Before starting any large change, checkpoint first. After finishing any step, checkpoint.
- Never rewrite history, force-push, or leave work uncommitted at the end of a turn.
- Human runs `scripts/autocommit.sh` in a spare terminal as a safety net.
- Every ~30 min and at the end: `scripts/export-ai-logs.sh` and commit ai-logs/.

## 2. Working loop
1. Read the brief; build the CORE flow first, thinly but correctly; list what is cut in DECISIONS.md.
2. After each feature: run the provided checker. Read failures. Fix. Re-run. Only paste failing lines.
3. Backend before UI. UI must work but stay minimal.
4. Small diffs, no unrequested refactors, no unneeded dependencies. Explain each change in one line so the human can defend it.

## 3. Production-readiness checklist (the checker attacks all of these)
### Process death / restart
- ZERO business state in process memory. Everything durable in Mongo (truth) or Redis (locks, cache, rate limits).
- Safe under `kill -9` at any line: operations are resumable or atomic. On boot, recover in-flight work (e.g. re-scan pending/processing records, lease expiry).
- Graceful SIGTERM/SIGINT: stop accepting, drain in-flight, close Mongo/Redis, exit.
- Startup waits/retries for Mongo and Redis instead of crashing; create indexes idempotently on boot.

### Several copies running at once
- No read-then-write. Use atomic ops: `findOneAndUpdate` with a condition, `$inc`, `$setOnInsert`, upserts, unique indexes (catch duplicate-key E11000 and treat as "already done").
- Redis `SET key val NX PX ttl` locks/leases with owner token; release only if owner matches; always have TTL.
- Background jobs/workers must claim work atomically (status transition `pending -> processing` with lease expiry) so two copies never process the same item.
- No in-process cron that double-fires across copies without a lock.

### Bad network / failing dependencies (Pigeon, Paybox, IdP, Mongo, Redis)
- Timeout on EVERY outbound call (e.g. 2-5s). No unbounded awaits.
- Retry only idempotent/safely-keyed calls: exponential backoff + full jitter, capped attempts, respect Retry-After.
- Treat timeout as UNKNOWN outcome: never assume failure of a side effect; reconcile (query provider status) or retry with the SAME idempotency key.
- Idempotency keys on every side-effecting operation (payments, messages): store key + result; replay returns the stored result. Never double-charge, never double-send.
- Handle duplicate, delayed, out-of-order, and replayed webhooks/callbacks (dedupe by event id, verify state transition is legal).
- Circuit-breaker or fast-fail when a dependency is down; degrade gracefully with correct status codes (503 + Retry-After), never hang, never crash.
- Mongo/Redis connection drops: auto-reconnect, bounded command timeouts; app must recover without restart.

### API correctness
- Validate all input (schema); correct HTTP codes (400/401/403/404/409/422/429/503); consistent JSON error shape; never leak stack traces.
- `/healthz` (liveness) and ideally `/readyz` (checks Mongo+Redis).
- Auth via the Mock IdP (OIDC): verify token signature/expiry/audience; never trust client-supplied identity.
- Pagination, limits on body size, rate limiting where the brief implies abuse.
- Money: integer minor units, never floats. State machines with explicit allowed transitions.
- Config via env vars with sane defaults (PORT=4000, MONGO_URL, REDIS_URL, provider URLs); no secrets committed.
- Structured logs with request ids; log decisions on retries/failures.

### Concurrency tests to run yourself
- Fire the same request 20x in parallel: exactly one side effect.
- Start 2-3 instances on different ports against same Mongo/Redis; run the checker.
- Kill the server mid-request, restart, verify no lost or duplicated work.
- Stop mongo/redis/mock container briefly (`docker stop` / `docker start`), verify recovery.

## 4. Code style (keep it simple; a junior engineer must understand every file)
- **Simple over clever.** Plain functions, async/await, early returns. No classes unless needed, no decorators, no DI frameworks, no generic abstractions "for later".
- **One file, one job.** Routes only parse input, call a function, and send the response. Logic lives in `lib/`. Small files (aim < 150 lines), small functions (aim < 40 lines).
- **Reuse, don't repeat.** Shared helpers for: workspace guard, grader token check, duplicate-key check (`isDup`), emitting events, sending JSON errors. The UI and the grader endpoints call the same functions.
- **Clear names.** `enqueueReply`, `claimConversation`, `verifyPigeonSignature`; no abbreviations like `cnv`, `tmp2`.
- **Explain the why, not the what.** A short comment above each non-obvious line (unique index = idempotency, lease = failover, rank = no status regress). No comment noise.
- **Constants in one place** (`lib/constants.ts`): lease time, timeouts, pacing gap, retry backoff, status ranks. No magic numbers in the code.
- **Consistent errors.** JSON `{ error: "message" }` with the right status code. One error-handling middleware. Never leak stack traces.
- **TypeScript lightly.** Simple types/interfaces for documents and frames; avoid complex generics. Code must run with `tsx` even if strict typecheck has warnings.
- **Few dependencies.** Express, mongodb, ioredis, ws. Node built-ins for fetch and crypto. Ask before adding anything else.
- **Readable React.** Function components, a few hooks (`useSession`, `useSocket`, `useConversations`), plain CSS. No state library.
- **Log useful things only**: startup, retries, failures, with workspace and ids. No secrets in logs.

## 5. Honesty and ownership
- README: how to run from a clean clone, current status, what is NOT done and what would happen as a result.
- DECISIONS.md: build-first rationale, cuts, silent-brief decisions, known gaps. Update it as you go, not at the end.
- Never claim behavior that was not verified by running it. Save the latest checker report into the repo (e.g. `checker-report.txt`).
- Every line must be explainable by the human in a follow-up call; keep the code simple and readable.
