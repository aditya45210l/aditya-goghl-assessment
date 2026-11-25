# PLAN (build order = score order: levels 1, 5, 2, 3; level 4 comes free from the webhook table)

## Target server layout (scaffold/server/src)
```
index.ts            boot: connect Mongo/Redis (retry), ensure indexes, start http+ws, start workers, SIGTERM drain
config.ts db.ts redis.ts   (given)
app.ts              express app, routes mounted
routes/
  webhook.ts        POST /webhooks/pigeon
  grader.ts         /__grader/{reset,snapshot,reply,claim}  (x-grader-token)
  auth.ts           /auth/login, /auth/callback, /api/me
  api.ts            /api/conversations, messages, reply, claim, close/reopen
lib/
  signature.ts      HMAC verify, 5-min window, timing-safe compare
  pigeonClient.ts   send with timeout, Idempotency-Key, 429/503 handling
  outbox.ts         durable reply queue + worker (lease claim, backoff)
  events.ts         per-workspace seq (Mongo $inc) + event log + Redis pub/sub fan-out
  ws.ts             /ws upgrade auth, ?after= replay, live push via pub/sub
  session.ts        session cookie (Redis/Mongo store), workspace membership guard
  ratelimit.ts      per-WORKSPACE token bucket in Redis (Lua), not per copy
```
Web: scaffold/web/src: login redirect, inbox list, conversation view, reply box + status, claim/close, WS hook with reconnect (`after=lastSeq`).

## Data model (Mongo, all docs carry `workspace`)
- `inbound_events`: unique `{workspace, event_id}` (dedupe webhooks).
- `messages`: inbound unique `{workspace, message_id}`; outbound unique `{workspace, client_ref}`; fields: contact, direction, text, status, occurred_at, createdAt.
- `conversations`: unique `{workspace, contact}`; assignee, state(open/closed), lastActivityAt (index for inbox sort).
- `outbox`: unique client_ref; state pending/sending/sent/failed, attempts, nextAttemptAt, leaseUntil, leaseOwner, pigeon id.
- `events` (WS log): unique `{workspace, seq}`; `counters` doc per workspace for seq.

## Core rules (each one maps to a check level)
1. Webhook: verify signature on RAW body (express.raw) -> 401 bad/old sig; 400 unparseable; unknown type/workspace/unknown status -> 2xx ignore; dedupe via unique index (E11000 = success); store THEN 2xx. Never 5xx on bad input.
2. Out-of-order: status ranking sent < delivered/failed; only move forward (`$max`-style conditional update), delivered before sent is fine. Inbound shown ordered by occurred_at then message_id.
3. Reply: `/__grader/reply` and UI both: upsert conversation, insert outbox row keyed by client_ref (dup = same reply, 202), emit event, return 202 once stored. Worker sends later.
4. Outbox worker: atomically claim (`findOneAndUpdate` pending & nextAttemptAt<=now -> sending, lease 15s), send with timeout ~4s, `Idempotency-Key = client_ref`. Timeout/5xx = UNKNOWN: retry same key (Pigeon dedupes). 429: wait Retry-After (never retry earlier). Outage: keep retrying with backoff+jitter, no cap on time. Expired lease = another copy reclaims (level 3: within 60s).
5. Rate limit 8 burst / 4 per sec per workspace, shared via Redis, so copies don't blow the limit.
6. Claim: single atomic `updateOne({workspace,contact,assignee:null or same})`; 200 holder/re-claim, 409 otherwise; creates conversation if missing (upsert).
7. seq: `findOneAndUpdate $inc` per workspace, event stored with seq, published on Redis channel; WS replays `seq>after` from Mongo then streams live (buffer live during replay, dedupe by seq).
8. Auth: OIDC code+PKCE(S256), state+nonce, verify id_token/userinfo, session cookie httpOnly; every API/WS checks membership: 401 no session, 403 non-member. Tenant filter on EVERY query.
9. Snapshot: contacts.inbound ids oldest first, assignee, outbound client_ref->status. Reset wipes Mongo+Redis app keys.
10. Stateless: nothing important in memory; boot recovers; SIGTERM drains; PORT from env; /healthz 200 only when Mongo+Redis ready.

## Phases and time budget (stop features at 1:30)
| Phase | Work | Done when |
|---|---|---|
| A 0:10-0:30 | app skeleton, indexes, webhook, signature, grader reset/snapshot, switchboard.json check | `npm run check` starts, L1 webhook parts pass. COMMIT |
| B 0:30-0:55 | outbox + pigeonClient + /__grader/reply + claim + rate limit | L1 fully passes. COMMIT |
| C 0:55-1:15 | auth, /api/me, /api/conversations, tenant guard, events+seq+/ws | `check --levels 5` passes. COMMIT |
| D 1:15-1:30 | run L2 and L3, fix lease/recovery/multi-copy | `check:full` mostly green. COMMIT |
| E 1:30-1:50 | minimal React UI, DECISIONS.md, tests for 2-3 pieces, ai-logs | UI usable. COMMIT |
| F 1:50-2:00 | SUBMISSION.md steps | form sent |
If behind: UI last, skip encrypted notes/search/billing. Say so in DECISIONS.md.

## Gotchas
- check deletes data and starts the server itself: stop dev server before `npm run check`.
- Server must honor PORT; never hard-code 4000/URLs.
- Don't `2xx` before DB write is acknowledged. Don't 5xx on bad input.
- Never read-then-write; unique indexes + conditional updates.
- Keep `harness/check.js` reading allowed: skim levels 1-3 for exact expectations.
