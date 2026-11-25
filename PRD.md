# Switchboard: PRD, HLD, LLD and build plan

Source of truth: `docs/provided/BRIEF.md`, `docs/provided/PIGEON.md`, and `harness/check.js` (what is actually measured).

---

## 1. Product in one line
A multi-tenant shared support inbox. Customer messages arrive from Pigeon by webhook; human agents log in, see conversations live, claim, reply, close. **Never lose, never duplicate, never leak across workspaces, never let two agents hold one conversation**, while the network is bad, the process is killed, and several copies run.

## 2. What we were given vs what we build

| Given (do not edit) | We build |
|---|---|
| Pigeon :4010 (unreliable provider), Mock IdP :4020, Paybox :4030 | Server in `scaffold/server` (Express + TS, run with `tsx`) |
| MongoDB :27017, Redis :6379 (docker compose) | React app in `scaffold/web` (Vite) |
| `harness/check.js` (grader), load balancer on :4000, instances on :4001.. | `README.md`, `DECISIONS.md`, `CHECK_REPORT.json`, `ai-logs/` |
| `scaffold/server/src/{config,db,redis}.ts` (env config, lazy connects) | Optional: `PROTOCOL.md` (encrypted notes), tests |
| `switchboard.json` (`install`, `start`, `health`) | |

## 3. Facts the checker enforces (read from check.js)
- Starts our server with `PORT=4001..`, `NODE_ENV=production`, env defaults matching `.env.example`. Waits for `/healthz` = 200 (90 s max).
- Load balancer round-robins **every request** across instances. So login state, PKCE verifier, sessions, rate limit, WS events must be shared (Redis/Mongo), never in memory.
- Kill is `SIGKILL` on the process group. No shutdown hook runs. Only durable state survives.
- **Level 1 (24):** inbound complete (4), no duplicates (3), order by `occurred_at` (3), isolation incl. ids starting `forged_`/`stale_` (2), rejects forged (2), rejects stale (1), **ack p95 < 1000 ms** (1), outbound exactly once **with Idempotency-Key** (2), **no request inside a Retry-After window** (1), final status matches carrier (1), claim race 6 agents x 5 contacts (2), outage recovery and **<= 6 requests/s during outage** (2).
- **Level 2 (14):** kill mid-webhook-flood (complete 3, no dupes 2, order 2); kill right after 12 replies got 202 (delivered 4, once 2, status 1).
- **Level 3 (22):** 2+ instances: inbound (6), claim race (3), 24 replies once (3), **Retry-After honoured across instances** (3), one instance dies forever: others deliver its accepted replies within 60 s (5) with right status (2).
- **Level 5 (15):** full OIDC login through LB (3), `/api/me` 401 without session (1), `/api/conversations` 200/403/401 (3), WS refuses no-session and non-member (2), live inbound frames within 5 s with rising `seq`, no leaks (3), reconnect with `after=N` replays missed frames and nothing `<= N` (3).
- `/__grader/reply` may be retried by the checker with the same `client_ref` after 1 s or a 30 s timeout: must stay one reply.

## 4. HLD (high level design)

```
                +------------------- Pigeon :4010 -------------------+
 webhooks (at-least-once, dup, out of order, forged, stale, bursts)  |  POST /v1/messages (429, 503, 12 s hangs, outages)
                |                                                     ^
                v                                                     |
   LB :4000 (round robin) ---> [ instance A ] [ instance B ] ...      |
                                   |  HTTP API + /ws                   |
                                   |  outbox worker  -----------------+
                                   v
                 MongoDB (truth): messages, conversations, outbox, events, counters, sessions?
                 Redis (shared): sessions, OIDC state, rate-limit bucket + cooldown, pub/sub for WS fan-out
                                   |
                                   v
                     React app (Vite :5173, proxies /api /auth /ws)
```

Principles (senior-level, industry standard):
1. **Store-then-ack.** Never answer 2xx/202 before Mongo acknowledged the write (`w: majority` default on single node is fine).
2. **Idempotency by unique index, not by checking first.** Duplicate-key error (E11000) means "already done" and returns success.
3. **Stateless instances.** All coordination via Mongo atomic ops and Redis. Any instance can die at any line.
4. **Transactional outbox** for every outbound side effect; a worker with **leases** delivers it; a dead worker's lease expires and another takes over.
5. **Monotonic state machines** for message status; late or duplicate events never move state backwards.
6. **Tenant scoping on every query** (`workspace` in every filter, derived from the verified session, never from client trust).
7. **Fail closed on security** (401 on bad signature, refuse WS upgrades), **fail open on unknowns from Pigeon** (2xx and ignore).

## 5. LLD (low level design)

### 5.1 Server modules (`scaffold/server/src`)
```
index.ts          boot: await Mongo+Redis ready -> ensureIndexes -> http.listen(PORT) -> start outbox worker; /healthz 200 only after ready
app.ts            express app; webhook route uses express.raw(), everything else express.json()
lib/
  mongo.ts        collections + ensureIndexes()
  signature.ts    verifyPigeon(rawBody, header): parse t,v1; HMAC-SHA256("t.raw"); timingSafeEqual; |now - t| <= 300 s
  events.ts       emit(workspace, frame): seq = $inc counters -> insert events{workspace,seq,frame} -> redis.publish
  outbox.ts       enqueue(...) and worker loop (claim with lease, send, schedule retry)
  pigeon.ts       send(workspace, {to,text,client_ref}) with AbortSignal.timeout(4000), Idempotency-Key = client_ref
  ratelimit.ts    Redis Lua token bucket per workspace (8 burst, 4/s) + workspace cooldown key from Retry-After
  auth.ts         OIDC discovery, PKCE, state in Redis, code exchange, id_token claims, session in Redis
  ws.ts           upgrade handler: session + membership check, replay seq>after from Mongo, live via Redis subscribe
routes/
  webhook.ts  grader.ts  auth.ts  api.ts
```

### 5.2 Mongo collections and indexes (every doc has `workspace`)
| Collection | Key fields | Unique index | Notes |
|---|---|---|---|
| `messages` | workspace, contact, direction(in/out), message_id or client_ref, text, occurred_at, status, statusRank | `{workspace:1, message_id:1}` partial(in); `{workspace:1, client_ref:1}` partial(out) | inbound order: sort `occurred_at, message_id` |
| `conversations` | workspace, contact, assignee, state(open/closed), lastActivityAt | `{workspace:1, contact:1}` | inbox index `{workspace:1, lastActivityAt:-1}` |
| `outbox` | workspace, client_ref, to, text, state(pending/inflight/done/failed), attempts, nextAttemptAt, leaseUntil, owner | `{workspace:1, client_ref:1}` | worker index `{state:1, nextAttemptAt:1}` |
| `events` | workspace, seq, frame | `{workspace:1, seq:1}` | WS replay |
| `counters` | _id = workspace, seq | _id | `$inc` for seq |
| `status_early` | workspace, client_ref, status | | optional: status webhook that arrived before we stored the reply (we always store first, so rarely needed) |

### 5.3 Key flows

**Inbound webhook** (`POST /webhooks/pigeon`, raw body)
1. Verify signature and timestamp -> `401` on any failure (never 5xx).
2. `JSON.parse` -> `400` on failure.
3. Unknown workspace / unknown type -> `200` ignore.
4. `message.inbound`: `insertOne(messages)`; E11000 -> already stored. Upsert conversation `{$max:{lastActivityAt}}`, `$setOnInsert:{assignee:null,state:'open'}`. Only if newly inserted: `emit message.inbound`.
5. `message.status`: conditional update `{workspace, client_ref, statusRank: {$lt: newRank}} -> {status, statusRank}`; if nothing matched (unknown ref or not newer) -> `200`. If updated -> `emit message.status`. Rank: queued 0 < sent 1 < delivered 2 = failed 2 (terminal; first terminal wins).
6. Answer `200` within ms (target p95 < 1 s). If Mongo is unreachable -> `503` so Pigeon retries (store-then-ack). This is the one case a 5xx is right.

**Reply** (`/__grader/reply` and UI `POST /api/conversations/:contact/reply`, same function)
1. Validate workspace is known (`4xx` otherwise), text, client_ref (UI generates a uuid).
2. Upsert conversation. `insertOne(messages{status:'queued'})` + `insertOne(outbox{state:'pending', nextAttemptAt: now})`. E11000 on either -> same reply, return `202`.
   - Order: insert outbox first (it is the durable intent), then message; both idempotent, so a crash between them is repaired by re-request or by the worker upserting the message.
3. `emit message.status queued`; return `202`.

**Outbox worker** (every instance, loop every ~200 ms)
1. Claim: `findOneAndUpdate({state:{$in:['pending','inflight']}, nextAttemptAt:{$lte:now}, $or:[{leaseUntil:null},{leaseUntil:{$lt:now}}]}, {$set:{state:'inflight', leaseUntil: now+15s, owner}, $inc:{attempts:1}})`.
2. Rate gate (Redis, per workspace): if cooldown key exists or bucket empty -> set `nextAttemptAt` = when allowed, release lease, continue.
3. `POST /v1/messages` with `Idempotency-Key: client_ref`, timeout 4 s.
   - `200` -> outbox `done`; message status at least `sent`? No: carrier status comes by webhook. Keep `queued` until webhook says `sent`. (Optionally store pigeon id.)
   - `429` -> set Redis cooldown `SET ws:cool PX retryAfter*1000` (shared by all instances), reschedule after it.
   - `503` / timeout / network error -> **unknown outcome**: reschedule with backoff+jitter (0.5 s, 1, 2, 4, cap 5 s), same key, so Pigeon dedupes. During an outage this keeps us under 6 req/s.
   - Other `4xx` -> `failed`, emit status.
4. Dead instance: its leases expire after 15 s, another instance reclaims (well under 60 s).

**Claim** (`/__grader/claim` and UI): upsert conversation, then `updateOne({workspace, contact, $or:[{assignee:null},{assignee:agent}]}, {$set:{assignee:agent}})`. matched -> `200` (+emit assigned if changed), else `409`. Upsert race: catch E11000 and retry once.

**Events and WS**
- `emit`: `seq = (await counters.findOneAndUpdate({_id:ws},{$inc:{seq:1}},{upsert:true, returnDocument:'after'})).seq`; `events.insertOne`; `redis.publish('ws:'+workspace, frame)`.
- Upgrade `/ws?workspace=&after=`: read session cookie -> Redis session; refuse (401, destroy) if none or not a member. Subscribe first, buffer live frames, replay `events.find({workspace, seq:{$gt:after}}).sort(seq)`, then flush buffer skipping `seq <= lastSent`. Each instance has one Redis subscriber for all channels.

**Auth (OIDC code + PKCE S256)**
- `/auth/login`: discovery (cache ok, it is static), `state`, `nonce`, `verifier` random; store in Redis `oidc:<state>` TTL 10 min (shared across instances); 302 to authorize URL with `code_challenge`.
- `/auth/callback`: load+delete state, exchange code (client secret + verifier), decode id_token (verify signature with JWKS if time allows, else check iss/aud/exp/nonce and note it in DECISIONS), read `sub` and `workspaces`. Create session in Redis `sess:<random>` TTL 8 h; cookie `sid` HttpOnly, SameSite=Lax, Path=/. Redirect to `WEB_ORIGIN`.
- `/api/me`: session -> `{sub, workspaces:[{id, role}]}`; `401` without.
- Guard: `requireMember(workspace)` -> `401` no session, `403` not a member.

**Grader**: token check first (`401`). `reset` deletes all app collections + Redis app keys (keep `sess:`). `snapshot` builds the shape from Mongo, inbound sorted like the UI.

## 6. Security checklist
- HMAC on the **raw** body, `timingSafeEqual`, 5-minute window, reject future timestamps beyond skew too.
- Grader token compared in constant time; never log secrets; `.env` ignored.
- Session ids: 32 random bytes, HttpOnly cookie, server-side store, logout deletes it.
- Tenant isolation: workspace comes from the verified session; every query filters by it; WS channel per workspace.
- Input validation (types, lengths), JSON body size limit, no stack traces in responses.
- CORS: only `WEB_ORIGIN` with credentials (Vite proxy means same origin anyway).

## 7. Concurrency checklist (why each piece is safe)
| Race | Defence |
|---|---|
| Same webhook twice, two instances at once | unique index, E11000 = ok |
| Same `client_ref` twice at the same instant | unique index on outbox and message |
| Six agents claim at once | single conditional `updateOne` |
| Two workers send the same outbox row | atomic claim with lease; Idempotency-Key as second line |
| Late `sent` after `delivered` | rank-guarded conditional update |
| Rate limit across instances | Redis Lua bucket + shared cooldown key |
| WS frames from another copy | Redis pub/sub; seq from Mongo counter |
| Kill after 202, before send | outbox row already durable; lease expiry -> resend with same key |

## 8. Build plan (boxes). Commit at the end of every box.

**Phase A: the check can start + inbound (target 0:15-0:40)**
- A1 `app.ts`/`index.ts` boot with readiness, `/healthz`, PORT from env. Run `npm run scaffold:install`.
- A2 `mongo.ts` collections + indexes.
- A3 grader auth + `reset` + `snapshot`.
- A4 webhook: raw body, signature, stale, 400/401/2xx rules, inbound insert, status update.
- A5 run `npm run check` -> inbound checks green. COMMIT.

**Phase B: outbound + claim (0:40-1:00)**
- B1 `pigeon.ts` client with timeout + Idempotency-Key.
- B2 `ratelimit.ts` (Lua bucket + cooldown).
- B3 `outbox.ts` enqueue + worker with lease/backoff.
- B4 `/__grader/reply`, `/__grader/claim`.
- B5 `npm run check` -> level 1 full. COMMIT.

**Phase C: login, tenant, real time (1:00-1:20)**
- C1 `events.ts` (seq + events + publish), wire emits into webhook/reply/claim.
- C2 `auth.ts` + `/auth/login`, `/auth/callback`, `/api/me`, guard, `/api/conversations`.
- C3 `ws.ts` upgrade with auth, replay, live.
- C4 `npm run check -- --levels 5`. COMMIT.

**Phase D: survive (1:20-1:30)**
- D1 `npm run check:full`; fix level 2/3 findings (lease length, boot recovery, cooldown). COMMIT.

**Phase E: UI and docs (1:30-1:50)**
- E1 React: login button, workspace picker, inbox list (paginated), conversation view, reply box with status, claim/close/reopen, WS hook with `after=lastSeq` reconnect.
- E2 API for UI: `GET /api/conversations/:contact/messages`, `POST .../reply`, `.../claim`, `.../close`, `.../reopen`.
- E3 DECISIONS.md, README, 2-3 unit tests (signature, status rank), export ai-logs. COMMIT.

**Phase F (1:50-2:00):** `docs/provided/SUBMISSION.md`.

**Skip unless everything above is green:** encrypted notes, Elasticsearch search, billing.

## 9. Where it breaks / where we can get stuck (and the fix)
| Risk | Symptom | Fix |
|---|---|---|
| Signature on parsed body | every webhook 401 | `express.raw({type:'*/*'})` on the webhook route only, before `express.json` |
| `/healthz` before Mongo ready, or crash when Mongo slow | check says instance not healthy in 90 s | boot retries connections; healthz waits for ready |
| Port hard-coded | check scores 0 | `config.port` from `PORT` only |
| Session/PKCE kept in memory | level 5 login fails behind LB | Redis for state and sessions |
| Status moves backwards | `status_lifecycle` fails | rank-guarded update |
| Worker hammers Pigeon in outage | outage penalty | backoff + jitter, cap rate |
| 429 ignored by another instance | `multi_retry_after` 0 | shared Redis cooldown key |
| Lease too long | failover > 60 s | lease 15 s, renew if a send takes long |
| WS replay misses frames between replay and live | `socket_replay` partial | subscribe before replay, buffer, dedupe by seq |
| Dev server still on :4000 | check: port in use | stop dev server before `npm run check` |
| `tsx` / TS 7 type errors | none at runtime (tsx strips types) | don't block on `typecheck`; fix later |
| AI usage limit hit | stall | switch tool, export logs from both |

## 10. Definition of done (per level)
- L1: `npm run check` all PASS.
- L5: `npm run check -- --levels 5` all PASS.
- L2/L3: `npm run check:full` with no FAIL lines; any PART explained in DECISIONS.md.
- Repo: README, DECISIONS, CHECK_REPORT.json, ai-logs/, switchboard.json correct, no `.env`, no `node_modules`.
