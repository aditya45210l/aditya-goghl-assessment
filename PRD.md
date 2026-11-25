# Switchboard: PRD, HLD, LLD and build plan (v2, verified against simulator source)

Sources of truth: `docs/provided/BRIEF.md`, `docs/provided/PIGEON.md`, `harness/check.js` (scoring), `pigeon/server.js` and `idp/server.js` (actual behaviour).

---

## 1. Product in one line
A multi-tenant shared support inbox. Customer messages arrive from Pigeon by webhook; human agents log in, see conversations live, claim, reply, close. **Never lose, never duplicate, never leak across workspaces, never let two agents hold one conversation**, under a bad network, `kill -9`, and several copies.

## 2. Given vs to build
| Given (do not edit) | We build |
|---|---|
| Pigeon :4010, Mock IdP :4020, Paybox :4030, Mongo, Redis (docker compose) | Server in `scaffold/server` (Express + TS via `tsx`) |
| `harness/check.js` + its load balancer on :4000 -> instances :4001.. | React app in `scaffold/web` (Vite, proxies `/api /auth /ws /healthz`) |
| `scaffold/server/src/{config,db,redis}.ts` | README, DECISIONS, CHECK_REPORT.json, ai-logs/ |
| `switchboard.json` | Optional: PROTOCOL.md, tests |

## 3. Verified facts that shape the design

### From check.js
- Instances get `PORT=4001..`, `NODE_ENV=production`; `/healthz` must be 200 within 90 s.
- LB round-robins **every HTTP request and every WS upgrade** across instances. Anything per-user (PKCE state, session) must be in Redis.
- Kill = `SIGKILL` of the process group. Only Mongo/Redis state survives.
- Inbound order is judged **by `occurred_at`**. Ids starting `forged_`/`stale_` in the snapshot count as leaks.
- `ack_speed`: webhook p95 < **1000 ms** and at most 2 first attempts not acknowledged.
- Replies: the check retries `/__grader/reply` with the **same `client_ref`** after a non-2xx or a 30 s timeout.
- Outbound is judged by Pigeon's report: delivered once, **every request has `Idempotency-Key`**, `sentDuringCoolOff == 0`, final status in our snapshot equals Pigeon's.
- Outage penalty if requests during outage > **6 x outage seconds** (48 for 8 s).
- Failover: replies accepted (202) by a copy that dies forever must reach Pigeon within **60 s**.
- Level 5 WS: frames must have **strictly increasing `seq`** as received, no frames from other workspaces, `after=N` must replay missed frames and **send nothing with seq <= N**.

### From pigeon/server.js
- Webhook retries: 6 attempts, waits 1.5, 3, 4.5, 6 s (about 22 s total), plus 10-15% extra duplicates.
- Chaos: 8 msgs per contact (+50% follow-ups 150-600 ms later), delivery jitter 0-2.5 s, a burst of 30 msgs in 450 ms to one globex contact, 6 forged (wrong HMAC), 3 stale (t = now-3600).
- Send API order of checks: **idempotency replay first** (key already accepted returns 200 even during outage/cool-off) -> outage 503 -> cool-off 429 (counted as violation) -> token bucket (8, +4/s) -> random 503 (7%) -> accept.
- **Any 429 starts a 2 s cool-off for the whole workspace**; every request inside it is a violation.
- 6% of accepted sends answer after **12 s** (already accepted; a retry with the same key gets the replay).
- Status webhooks: `sent` (0.4-2.2 s) and final `delivered`/`failed` (1.2-3.5 s), may arrive in either order, 10% duplicated.

### From idp/server.js
- Authorize needs registered `redirect_uri`, `code_challenge_method=S256`; `?login=<sub>` skips the picker (the check uses it).
- Token endpoint checks client secret, redirect_uri, PKCE verifier; returns RS256 `id_token` with `iss, aud, exp, nonce, sub, workspaces`. JWKS at `/jwks`.

## 4. HLD

```
 Pigeon :4010 --webhooks--> LB :4000 --> [instance A] [instance B] ... --POST /v1/messages--> Pigeon
                                   |            |  HTTP API, /ws, outbox worker
                                   |            v
                                   |    MongoDB (truth)   : messages(+outbox), conversations, events, counters
                                   |    Redis   (shared)  : sessions, oidc state, send pacing + cool-off, pub/sub
                                   v
                           React app (Vite :5173)
```

Principles:
1. **Store-then-ack.** 2xx/202 only after Mongo acknowledged.
2. **Idempotency by unique index.** Duplicate key (E11000) = "already done" = success. Never read-then-write.
3. **Stateless instances.** Any instance may die at any line.
4. **Outbound message row is the outbox.** One insert creates both the visible message and the send job (no two-write gap).
5. **Leases, not ownership.** Work is claimed with an expiring lease; a dead instance's work is reclaimed.
6. **Pace, don't fight the limiter.** A shared Redis pacer keeps all instances under 4 sends/s per workspace, so we rarely see a 429; if we do, a shared cool-off stops every instance.
7. **Monotonic status.** Ranked, conditional updates; late/duplicate events never go backwards.
8. **Tenant scope everywhere.** Workspace comes from the verified session/event; every query filters by it.
9. **Fail closed on security, fail open on unknown provider events.**

## 5. LLD

### 5.1 Modules (`scaffold/server/src`)
```
index.ts        boot: connect Mongo+Redis with retry -> ensureIndexes -> listen(PORT) -> start worker + subscriber
                ready flag drives /healthz (503 until ready)
app.ts          express; webhook route uses express.raw({type:'*/*', limit:'256kb'}) BEFORE express.json
lib/store.ts    collection handles, ensureIndexes(), isDup(err)
lib/signature.ts verifyPigeon(raw, header) -> 'ok' | 'bad' | 'stale'
lib/events.ts   emit(ws, frame): seq via counters $inc -> events.insert -> redis.publish
lib/pacer.ts    Redis Lua: per-workspace next-slot pacing (250-280 ms spacing) + cool-off key check
lib/pigeon.ts   send(ws, msg): fetch with AbortSignal.timeout(4000), Authorization, Idempotency-Key=client_ref
lib/outbox.ts   enqueueReply(), worker loop (claim lease -> pace -> send -> schedule)
lib/auth.ts     discovery cache, PKCE, state in Redis, token exchange, RS256 verify via JWKS, sessions in Redis
lib/ws.ts       upgrade auth, replay + live with gap filling, Redis subscriber fan-out
routes/webhook.ts grader.ts auth.ts api.ts
```
New dependency: `ws` (WebSocket server). Nothing else needed (Node 22 has fetch, crypto).

### 5.2 Mongo collections (every doc has `workspace`)
| Collection | Fields | Indexes |
|---|---|---|
| `messages` | workspace, contact, dir `in`/`out`, message_id (in), client_ref (out), text, occurred_at, status, rank, **send: {state, attempts, nextAt, leaseUntil, owner, pigeonId}** (out only) | unique `{workspace, dir, key}` where key = message_id or client_ref; `{workspace, contact, occurred_at, key}` for reading; `{'send.state', 'send.nextAt'}` for the worker |
| `conversations` | workspace, contact, assignee, state open/closed, lastActivityAt | unique `{workspace, contact}`; `{workspace, lastActivityAt:-1}` |
| `events` | workspace, seq, frame | unique `{workspace, seq}` |
| `counters` | _id = workspace, seq | _id |

Status rank: queued 0, sent 1, delivered 2, failed 2 (terminal; first terminal wins).

### 5.3 Flows

**A. Inbound webhook** `POST /webhooks/pigeon`
1. Signature: parse `t=..,v1=..`; HMAC-SHA256 of `t + "." + rawBody`; `timingSafeEqual`; bad/missing -> `401`; `|now - t| > 300 s` -> `401`. Never 5xx here.
2. `JSON.parse` fails or required fields missing -> `400`.
3. Unknown workspace (not in configured keys) or unknown `type` -> `200`, ignore.
4. `message.inbound`: insert message (`occurred_at` from event). E11000 -> already stored, `200`. Upsert conversation `{$max: {lastActivityAt}}`, `$setOnInsert: {assignee: null, state: 'open'}`; a closed conversation stays closed on new inbound (decision, see DECISIONS.md). Emit `message.inbound` only when newly inserted. `200`.
5. `message.status`: `updateOne({workspace, dir:'out', key: client_ref, rank: {$lt: r}}, {$set: {status, rank}})`. Matched -> emit `message.status`. Not matched (unknown ref or not newer) -> `200`.
6. Mongo down -> `503` so Pigeon retries (the only intended 5xx). Target latency: < 50 ms.

**B. Reply** (`/__grader/reply` and UI reply share `enqueueReply`)
1. Validate: workspace known (else `404`), contact and text strings, client_ref present (UI generates a UUID).
2. Insert one outbound message doc with `status: 'queued', rank: 0, send: {state: 'pending', nextAt: now, attempts: 0}`. E11000 -> same reply -> `202`.
3. Upsert conversation (lastActivityAt). Emit `message.status queued`. Kick the local worker. `202`.

**C. Outbox worker** (every instance; loop every 200 ms or when kicked)
1. Claim: `findOneAndUpdate({'send.state': {$in: ['pending', 'inflight']}, 'send.nextAt': {$lte: now}, $or: [{'send.leaseUntil': null}, {'send.leaseUntil': {$lt: now}}]}, {$set: {'send.state': 'inflight', 'send.leaseUntil': now + 10s, 'send.owner': id}, $inc: {'send.attempts': 1}})`.
2. Pacer (Redis Lua, per workspace): if cool-off key exists -> wait until it expires; else reserve `slot = max(now, next)`, `next = slot + 275 ms`. If slot is in the future, set `nextAt = slot`, release lease, continue.
3. Send with `Idempotency-Key = client_ref`, 4 s timeout.
   - `200` -> `send.state = 'done'`, store pigeonId. Status stays as webhooks say.
   - `429` -> `SET cool:<ws> PX (Retry-After * 1000 + 100)` shared by all instances; reschedule after it.
   - `503`, timeout, network error -> unknown outcome; reschedule with backoff + jitter (300 ms, 600, 1200, 2400, cap 3 s). Same key, so Pigeon dedupes. Pacing keeps outage traffic < 4/s < 6/s.
   - `400`/`401` -> `send.state = 'failed'`, status `failed`, emit.
4. Lease expiry (10 s) lets a surviving instance resend a dead instance's work well inside 60 s; Idempotency-Key makes a double send impossible.
5. On boot nothing special is needed: leases simply expire.

**D. Claim** (one atomic op, no race window)
`updateOne({workspace, contact, assignee: {$in: [null, agent]}}, {$set: {assignee: agent}, $setOnInsert: {state: 'open', lastActivityAt: now}}, {upsert: true})`
- matched or upserted -> `200`; emit `conversation.assigned` if it changed.
- E11000 (someone else holds it, or lost the insert race) -> `409`.
Release/close/reopen are similar conditional updates.

**E. Events and WebSocket**
- `emit`: `seq = counters.findOneAndUpdate({_id: ws}, {$inc: {seq: 1}}, {upsert: true, returnDocument: 'after'})`; `events.insertOne`; `redis.publish('ev:' + ws, frame)`.
- One Redis subscriber per instance (`psubscribe ev:*`), dispatching to local sockets of that workspace.
- Upgrade `/ws?workspace=&after=`: session from cookie (Redis); no session or not a member -> write `HTTP/1.1 401`/`403` and destroy, no upgrade.
- Per socket keep `lastSent`. Subscribe first and buffer; replay `events.find({workspace, seq: {$gt: after}}).sort(seq)`; then drain buffer.
- **Gap filling (needed for strictly increasing seq with several instances):** for a live frame with `seq <= lastSent` drop it; with `seq > lastSent + 1` first read `events` with `seq > lastSent` from Mongo and send them in order; if a seq is still missing (counter bumped, insert not yet visible), wait up to 300 ms and re-read, then move on.
- No `after` given: start from the current counter value (live only).

**F. Auth (OIDC code + PKCE S256)**
- `/auth/login`: discovery (cached), random `state`, `nonce`, `verifier`; `SET oidc:<state> {verifier, nonce} EX 600`; 302 to authorize with `code_challenge` (S256), `redirect_uri = OIDC_REDIRECT_URI`, `scope=openid profile email`.
- `/auth/callback`: `GETDEL oidc:<state>` (missing -> 400); POST token (form: grant_type, code, redirect_uri, client_id, client_secret, code_verifier); verify id_token RS256 with JWKS (`crypto.createPublicKey({key: jwk, format: 'jwk'})`), check iss, aud, exp, nonce. Session `sess:<32 random bytes hex>` = `{sub, name, workspaces}` EX 8 h. Cookie `sid` HttpOnly, SameSite=Lax, Path=/ (Secure when https). 302 to `WEB_ORIGIN`.
- `/api/me` -> `{sub, workspaces: [{id, role}]}` exactly; `401` without. `POST /auth/logout` deletes the session.
- `member(ws)` guard: `401` no session, `403` not a member.
- From `REFERENCE.html` (login provider section), also handled:
  - The IdP signing key and `kid` **change on every IdP restart**: cache JWKS by `kid`, and on an unknown `kid` refetch `/jwks` once before rejecting. Never hard-code the key.
  - The code works **once** and expires after **60 s**: exchange immediately in the callback, never retry with the same code.
  - `redirect_uri` must match exactly between `/authorize` and `/token` (use `OIDC_REDIRECT_URI` for both).
  - Client secret is optional; if sent it must be right. We send it (form body).
  - No refresh tokens and no IdP logout: our own session TTL (8 h) decides; `POST /auth/logout` deletes our session.
  - Roles are only data; we enforce them. Decision: `agent` and `admin` can both read, reply, claim, close and reopen; only `admin` can take over (reassign) a conversation another agent holds. Record in DECISIONS.md.
  - `workspaces` comes from the verified ID token (not `/userinfo`), so one round trip less.

**G. Grader** (constant-time token check, `401` otherwise)
- `reset`: delete docs in messages, conversations, events, counters; delete Redis keys `cool:*`, `pace:*` (keep `sess:*`, `oidc:*`). `200`.
- `snapshot`: from Mongo; inbound sorted `occurred_at, message_id` (same as UI); assignee or null; outbound `client_ref -> status`.
- `reply`, `claim`: call the same functions as the UI.

## 6. Security
- Raw-body HMAC, constant-time compare, 5-minute window (both directions).
- Grader token constant-time compare; secrets only from env; `.env` gitignored.
- Sessions server-side in Redis, opaque random id, HttpOnly + SameSite cookie, logout.
- ID token signature, issuer, audience, expiry, nonce verified; PKCE S256; state single-use.
- Tenant: workspace membership from the session; every query filtered; WS channel per workspace.
- Validation and body size limits; generic error bodies; no stack traces.

## 7. Concurrency map
| Race | Defence |
|---|---|
| Same webhook twice / on two instances | unique index, E11000 = ok |
| Same `client_ref` at the same instant | unique index on outbound message |
| 6 agents claim at once (existing or new conversation) | single conditional upsert, E11000 -> 409 |
| Two workers pick one send | lease claim via `findOneAndUpdate`; Idempotency-Key as backstop |
| Kill after 202, before/while sending | doc already durable; lease expires; resend with same key |
| Late `sent` after `delivered`, duplicate statuses | rank-guarded update |
| Rate limit across instances | Redis pacer + shared cool-off key |
| WS frames produced on other instances | Redis pub/sub + gap filling from `events` |

## 8. Build plan (boxes; commit after each box)

**Phase A: check can start, inbound correct (~25 min)**
- A1 Install deps (`npm run scaffold:install`, add `ws`). `index.ts`/`app.ts`: readiness, `/healthz`, PORT.
- A2 `store.ts` + indexes.
- A3 Grader token, `reset`, `snapshot`.
- A4 Webhook (signature, 400/401/200 table, inbound insert, status update).
- A5 `npm run check`: inbound_complete, no_duplicates, order, isolation, forged, stale, ack_speed PASS. **Commit.**

**Phase B: outbound and claim (~20 min)**
- B1 `pigeon.ts`, B2 `pacer.ts` (Lua), B3 `outbox.ts` worker, B4 `/__grader/reply` + `/__grader/claim`.
- B5 `npm run check`: all level 1 PASS. **Commit.**

**Phase C: login, tenant, real time (~20 min)**
- C1 `events.ts` and emits from webhook/reply/claim.
- C2 `auth.ts` + routes + `/api/me` + `/api/conversations` (paginated, newest first).
- C3 `ws.ts` (auth, replay, live, gap fill).
- C4 `npm run check -- --levels 5`: all PASS. **Commit.**

**Phase D: survive (~10 min)**
- D1 `npm run check:full`; tune lease/backoff; fix anything in levels 2/3. **Commit.**

**Phase E: UI and docs (~20 min)**
- E1 UI API: `GET /api/conversations/:contact/messages`, `POST .../reply`, `.../claim`, `.../release`, `.../close`, `.../reopen`.
- E2 React: login, workspace picker, inbox (paginated), thread view, reply with live status, claim/close/reopen, WS hook reconnecting with `after=lastSeq`.
- E3 Tests (signature verify, status rank, claim race), DECISIONS.md, README, ai-logs export. **Commit.**

**Phase F (1:50):** follow `docs/provided/SUBMISSION.md`.

Cut unless all green: encrypted notes, Elasticsearch search, billing.

## 9. Traps and fixes
| Trap | Symptom | Fix |
|---|---|---|
| HMAC over parsed JSON | all webhooks 401 | raw body on that route only |
| healthz 200 before DB ready / crash on slow Mongo | instance not healthy in 90 s | retry connects; ready flag |
| hard-coded port | score 0 | `PORT` only |
| PKCE state or session in memory | L5 login fails behind LB | Redis |
| outbox in a separate collection | status webhook for unknown ref after crash | outbound message doc is the outbox |
| bursting 8 then fighting 429 | `sentDuringCoolOff` > 0 | pacing at < 4/s + shared cool-off |
| tight retries in outage | outage penalty | backoff + pacing |
| status regress | lifecycle mismatch | rank guard |
| WS frames out of order across instances | `seq NOT increasing` | lastSent + gap fill |
| subscribe after replay | missed frames | subscribe, buffer, replay, drain |
| lease too long | failover > 60 s | 10 s lease |
| dev server on :4000 during check | "port in use" | stop it first |
| emitting event before insert succeeded | duplicate frames | emit only on new insert / matched update |

## 10. Done means
- L1: `npm run check` all PASS. L5: `--levels 5` all PASS. L2/L3: `check:full` no FAIL; any PART explained in DECISIONS.md.
- Repo has README, DECISIONS, switchboard.json, CHECK_REPORT.json, ai-logs/; no `.env`, no `node_modules`.

## 11. Known accepted gaps (write in DECISIONS.md if unchanged)
- A kill between storing an inbound message and emitting its event loses that WS frame (data itself is safe). Fix would be an `emitted` flag swept on boot.
- Redis is treated as durable enough for sessions, pacing and pub/sub; a Redis restart logs users out.
