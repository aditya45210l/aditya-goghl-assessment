# Switchboard

A **shared team inbox** for customer support, built for the GoHighLevel SDE build round.
Customers write to a business through **Pigeon** (a simulated messaging provider). Support agents sign in,
see conversations arrive live, **claim** one, **reply**, and close it. Several businesses (**workspaces**)
share one deployment and never see each other's data.

**Status**
- **Provided check:** `npm run check:full` scores **75 / 75**: level 1 is 24/24, level 2 is 14/14, level 3 is 22/22 and level 5 is 15/15 (see `CHECK_REPORT.json`).
- **Bonus track:** per-seat billing on **Paybox** is built. Our billing self-test passes **18 / 18**.
- **Our own tests:** 6 unit tests and 37 end-to-end workflow checks, all passing.

| | |
|---|---|
| Stack | Node 22 + TypeScript (Express, run with `tsx`), React 19 + Vite, Tailwind v4 + shadcn/ui, MongoDB 7, Redis 7 |
| Design notes | [`PRD.md`](PRD.md) (HLD/LLD, build plan), [`BONUS_PRD.md`](BONUS_PRD.md), [`DECISIONS.md`](DECISIONS.md) (what was built, cut, assumed, and what is still wrong) |
| AI transcripts | [`ai-logs/`](ai-logs/) (unedited, with an index) |

---

## 1. Run it from a clean clone

Needs **Node 22+** and **Docker**.

```bash
npm run scaffold:install   # install server + web dependencies (same as switchboard.json "install")
npm run up                 # MongoDB, Redis, Pigeon, mock IdP, Paybox in Docker + readiness check
npm run scaffold:server    # API + WebSocket on http://localhost:4000 (reads PORT and all URLs from the env)
npm run scaffold:web       # React app on http://localhost:5173
```

Open **http://localhost:5173** and click a test user to sign in. Configuration comes from the environment, and the
defaults match `.env.example`, so no `.env` file is needed. Run `npm run inbound` to make a customer write in now,
and `npm run drizzle` for a message every few seconds.

### Test users (mock identity provider)

| User | Workspaces and role | What they can do |
|---|---|---|
| **Asha Rao** | `ws_acme` admin | everything, **including Billing** and taking over other agents' conversations |
| Ben Ortiz | `ws_acme` agent | read, claim, reply, release their own, close/reopen |
| **Chloe Martin** | `ws_globex` admin | as Asha, for `ws_globex` |
| Dev Patel | `ws_globex` agent | as Ben, for `ws_globex` |
| Eli Novak | `ws_acme` and `ws_globex` agent | switch workspaces from the top bar |

---

## 2. Using the app

- **Sign in.** The sign-in page lists the five test users. Clicking one runs the real OpenID Connect login
  (authorization code + PKCE) through the mock IdP. It passes the mock's `login` hint, so the IdP's plain HTML
  list is skipped. *"Use the identity provider's own page instead"* opens that list.
- **Inbox (left panel).** Conversations, newest activity first. Filter by **Open / Mine / Unassigned / Closed**
  (with counts), search by number, and use **Load more** for older conversations.
- **Conversation (right panel).**
  - **Claim** a conversation to reply. Two agents can never hold the same one.
  - An admin can **Take over**. The holder or an admin can **Release**, **Close** and **Reopen**.
  - The reply box only appears when you hold an open conversation.
  - Each reply shows its delivery status: clock (queued), ✓ (sent), blue ✓✓ (delivered) or ✗ (failed).
  - Messages load **50 at a time**. Scroll up to load older ones, and your scroll position is kept.
- **Live updates.** New messages, statuses and assignments appear without a refresh. The **Live** badge in the top
  bar shows the connection. After a disconnect it reconnects and replays what it missed.
- **Theme.** Use the moon/sun button in the left rail for light or dark mode. It follows your OS until you choose.

---

## 3. The bonus: billing (how to access it)

Per-seat monthly subscriptions on **Paybox** (simulated payment provider, port 4030), as asked in
`docs/provided/BONUS_BILLING.md`.

1. Start the app (section 1) and sign in as an **admin**: **Asha Rao** or **Chloe Martin**.
   Agents do not see billing; the brief says "Agents cannot see or change billing".
2. Click the **card icon** in the dark left rail, under the inbox icon. The page header changes to **Billing**.
3. The page shows the state in plain words and what to do next: Free trial, Active, Waiting for your bank,
   Payment declined, Payment failed (past due) or Canceled.
4. **Subscribe** with seats and a card. Use Paybox test cards only (any future expiry, any 3-digit CVC):

   | Card | What happens |
   |---|---|
   | `4242 4242 4242 4242` | succeeds: **Active** |
   | `4000 0000 0000 0002` | declined: "Payment declined, try another card" |
   | `4000 0025 0000 3155` | needs bank approval: **Open bank page**, then Approve, and the page turns Active on its own |
   | `4000 0000 0000 0341` | the first payment works and every renewal fails |

5. Once active you can **change seats** and **cancel at period end**. Adding seats is charged now, pro rata.
   Removing seats becomes credit on the next invoice.
6. **Renewals and cancellation.** Nothing renews on its own, so move Paybox's clock (use the `0341` card first):
   ```bash
   curl -X POST localhost:4030/v1/test_clock/advance -H 'content-type: application/json' -d '{"hours":721}'  # renewal fails -> past due
   curl -X POST localhost:4030/v1/test_clock/advance -H 'content-type: application/json' -d '{"hours":72}'   # retry 2 fails
   curl -X POST localhost:4030/v1/test_clock/advance -H 'content-type: application/json' -d '{"hours":48}'   # retry 3 fails -> canceled
   ```
   A **canceled** workspace cannot send. Everyone sees a red "sending is paused" banner, the reply box locks,
   and `POST /__grader/reply` answers **402**. The inbox can still be read.

To run the whole bonus scenario without clicking: `node scripts/billing-selftest.mjs` (section 7).

**How billing works**
- **The card never reaches our server.** The browser turns the card into a single-use token directly at Paybox
  with the publishable key, and our API rejects any `card` field.
- **No duplicates.**
  - A Redis lock per workspace makes subscribe and seat changes take turns across all instances.
  - Every Paybox POST carries a stable Idempotency-Key (`cus-<ws>`, `sub-<ws>-<token>`, `seats-<sub>-<attempt>`).
  - So three simultaneous subscribes produce **one** customer and **one** subscription.
- **Webhooks are only a hint.** After the signature check we **re-read the subscription from Paybox** and store
  that. Two guards in the database update mean an older read never overwrites a newer one, and a webhook about
  an old, replaced subscription never overwrites the current one. Duplicate, out-of-order, stale and forged
  events are harmless.
- **Who can send.** Never subscribed (free trial), waiting for the first payment, and past due (Paybox is still
  retrying) can all send. **Canceled cannot.**
- Grader contract: `POST /__grader/billing/subscribe`, `POST /__grader/billing/seats`, and a `billing` field per workspace
  in `GET /__grader/snapshot`.

---

## 4. How it is built (approach)

We built in the order the checker scores, and ran the check after every step: webhook intake and grader endpoints,
then replies and claims (level 1), then login, tenants and real time (level 5), then crash and multi-copy safety
(levels 2 and 3), then the UI, the bonus and extra hardening.

**Five principles carry the whole design:**

1. **Store, then acknowledge.** A webhook gets `2xx` and a reply gets `202` only after MongoDB has stored it.
   If we crash before that, the sender retries, so nothing is lost.
2. **Duplicates are harmless by construction.** Unique indexes (`workspace + direction + message id/client_ref`,
   `workspace + contact`) make a second insert fail. That failure (E11000) means "already done", and we never
   read-then-write.
3. **Stateless instances.** All state lives in MongoDB (the truth) and Redis (sessions, locks, rate limits,
   pub/sub). Any instance can be killed at any line, and any instance can serve any request.
4. **An outgoing reply is its own job.** One document holds both the message and its send job. Workers **lease** a
   job for 10 s. If an instance dies, its leases expire and another instance finishes the job. Every send carries
   `Idempotency-Key = client_ref`, so a retry can never deliver twice.
5. **Status only moves forward.** queued < sent < delivered/failed. A late `sent` never overwrites `delivered`.

```
customers -> Pigeon :4010 --signed webhooks--> [ instance A | instance B | ... ] --WebSocket--> React app :5173
                                                    |  outbox workers (leases)  |
                                                    v                           v
                                         MongoDB (truth)              Redis (sessions, locks, pacing,
                                                                             rate limits, pub/sub)
reply -> our API -> MongoDB outbox -> worker -> Pigeon POST /v1/messages -> status webhooks back to us
```

---

## 5. Situations handled (and how)

### Network and provider failures (Pigeon)
| Situation | How it is handled |
|---|---|
| Same webhook delivered several times | Unique index; repeats answer 200 and change nothing |
| Webhooks out of order | Messages ordered by Pigeon's `occurred_at` (then id); statuses only move forward |
| Forged webhook (wrong signature) | HMAC-SHA256 checked over the **raw** bytes, constant-time compare: **401** |
| Replayed webhook (old timestamp) | More than 5 minutes from now, in either direction: **401** |
| Unknown event type / unknown workspace / status for a reply we never sent | **200** and ignored, so Pigeon stops retrying |
| Body that is not JSON, or too large | **400** / **413**. Bad input is never a 5xx |
| Burst of webhooks | Acknowledged in about 30-70 ms (the check needs p95 < 1 s) |
| Pigeon rate limit (429 + Retry-After) | A **Redis pacer shared by all instances** keeps sends under 4/s per workspace; a 429 sets a shared cool-off, so no instance sends inside the Retry-After window |
| Pigeon slow (answers after 12 s) | 4 s timeout, treated as "unknown outcome", retried with the **same** Idempotency-Key, so nothing is sent twice |
| Pigeon 503 / down for a while | Retries with exponential backoff and jitter, paced, so an outage costs a few requests per second; replies go out when it recovers |
| Pigeon rejects a reply (400/401) | Marked **failed** and shown to the agent; not retried |

### Crashes and several copies
| Situation | How it is handled |
|---|---|
| `kill -9` in the middle of a webhook flood | Nothing acknowledged before it is stored; Pigeon retries; unique index prevents duplicates |
| `kill -9` right after replies were accepted | The replies are already in MongoDB; leases expire and the restarted (or another) instance sends them once |
| An instance dies for good | Other instances take over its leased jobs within about 10 s (the check allows 60 s) |
| Several instances behind a load balancer | Sessions, login state, locks, rate limits and the event log are shared in Redis/MongoDB |
| Six agents claim one conversation at the same instant | One conditional database update decides: exactly one **200**, others **409** |
| Claim races the customer's first message / double click | Retry once on a duplicate-key error, so no false 409 |
| Same `client_ref` requested twice at the same instant | One reply; both requests get **202** |
| A late worker after its lease expired | It can no longer overwrite the new owner's result (owner check) |
| MongoDB/Redis not up yet at start | The server waits and retries; `/healthz` answers 503 until ready |
| SIGTERM | Stops taking traffic and new send jobs, then exits; a kill -9 is safe anyway |
| MongoDB data wiped while running | Unique indexes are recreated on every reset |
| Stray errors | Logged instead of crashing; a server that cannot bind its port exits |

### Real time
| Situation | How it is handled |
|---|---|
| Event produced on another instance | Fanned out through Redis pub/sub to every instance's sockets |
| Frames arriving out of order across instances | Each socket sends in strictly increasing `seq` and fills gaps from MongoDB |
| Client disconnects and reconnects | `GET /ws?workspace=…&after=N` replays everything after N, then continues live |
| Data was reset while a client was connected | The server sends a `reset` frame and the client reloads its view |
| User signs out | Their open sockets are closed on every instance |

### Security and permissions
| Situation | How it is handled |
|---|---|
| Login | OIDC authorization code + **PKCE (S256)**; state, nonce and verifier in Redis (any instance can finish the login); ID token **RS256 signature verified via JWKS** (refetched when the IdP rotates its key), plus issuer, audience, expiry and nonce |
| Login CSRF | A short `login_state` cookie ties the login to the browser that started it |
| Sessions | Opaque random id in an HttpOnly, SameSite=Lax cookie; stored in Redis for 8 h; logout deletes it |
| Tenant isolation | Every API route and WebSocket checks membership from the session: **401** without a session, **403** for another workspace; every query is filtered by workspace |
| Cross-site requests (CSRF) | State-changing API calls must be JSON and, if the browser sends `Origin`, come from our web app; WebSocket upgrades check `Origin` too |
| Abuse | Per-user rate limit on API writes (30 per 10 s, counted in Redis across instances): **429** |
| Bad input | Contacts must be phone numbers (E.164); lengths and types are checked; generic error bodies, no stack traces |
| Roles | Reply only to a conversation you hold and that is open; close/reopen by the holder or an admin; take over and billing for admins only |
| Grader endpoints | Need `x-grader-token` (constant-time compare), checked before the body is parsed: **401** without it |
| Headers | `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` |

---

## 6. API overview

| Endpoint | Purpose |
|---|---|
| `POST /webhooks/pigeon` | Pigeon webhooks (inbound messages, delivery statuses) |
| `POST /webhooks/paybox` | Paybox webhooks (bonus) |
| `GET /healthz` | 200 when MongoDB and Redis are ready |
| `GET /auth/login`, `GET /auth/callback`, `POST /auth/logout` | Sign in / out |
| `GET /api/me` | `{ sub, workspaces: [{ id, role }] }` |
| `GET /api/conversations?workspace=&before=` | Inbox page (cursor pagination) |
| `GET /api/conversations/:contact?workspace=` | One conversation's summary |
| `GET /api/conversations/:contact/messages?workspace=&before=` | 50 messages per page, newest page first |
| `POST /api/conversations/:contact/{reply,claim,release,close,reopen}?workspace=` | Agent actions |
| `GET /api/billing`, `POST /api/billing/{subscribe,seats,cancel}` | Billing (admins) |
| `GET /ws?workspace=&after=` | Live frames: `message.inbound`, `message.status`, `conversation.assigned`, `conversation.state`, `billing.updated` |
| `/__grader/{reset,snapshot,reply,claim}`, `/__grader/billing/{subscribe,seats}` | Grader contract (token required) |

---

## 7. Tests

Stop the dev servers before running the provided check, because it starts its own:

```bash
scripts/stop-dev.sh        # stops only processes LISTENING on 4000-4003/5173 (a plain "lsof | kill" also kills Docker Desktop)
npm run check              # provided check, level 1 (about 90 s)
npm run check:full         # provided check, levels 1, 2, 3, 5 (about 4 min) -> CHECK_REPORT.json
```

Our own tests. The end-to-end scripts need the server on :4000, and **they wipe development data**:

```bash
npm run test:unit                  # 6 unit tests: signature, cookies, claim races, close/reopen permissions
node scripts/e2e-selftest.mjs      # 37 workflow checks against the real server
node scripts/billing-selftest.mjs  # 18 billing checks against the Paybox simulator (bonus)
npm run test:e2e                   # both scripts
```

`e2e-selftest.mjs` covers:
- webhooks: genuine, duplicate, out of order, forged, replayed, unknown, bad JSON
- replies: a double request becomes one reply
- the claim race and the grader token
- real login through the IdP and tenant isolation
- agent rules: claim before reply, admin takeover, closed conversations, junk contacts, cross-site form
- pagination: 120 messages come back as 50 + 50 + 20, in order
- WebSocket: live frames, no leaks between workspaces, replay after reconnect, strangers refused
- the API rate limit

`billing-selftest.mjs` follows what the grader does:
- 3 simultaneous subscribes give 1 customer and 1 subscription
- seats change, and a declined card gets 402
- active -> past due -> canceled
- a canceled workspace's reply gets 402 while a paying one gets 202
- a forged webhook gets 401
- Paybox's report shows 0 cards through our server and 0 POSTs without an Idempotency-Key

---

## 8. Project layout

```
switchboard.json          how the checker installs and starts the server
docker-compose.yml        MongoDB, Redis, simulators          (provided)
harness/                  the checker, doctor, mocks          (provided)
pigeon/ idp/ paybox/      the simulators                      (provided)
docs/provided/            brief, Pigeon/Paybox contracts, reference, submission steps (provided)

scaffold/server/src
  index.ts                boot: wait for MongoDB/Redis, indexes, live fan-out, outbox worker, /healthz, SIGTERM
  app.ts                  routes; webhook routes read the raw body (signatures cover exact bytes)
  routes/                 webhook, paybox-webhook, grader, auth, api, billing (thin: validate -> lib -> answer)
  lib/
    signature.ts          HMAC check + 5-minute window (Pigeon and Paybox)
    inbound.ts            store inbound messages (idempotent), apply delivery statuses (forward only)
    outbox.ts             reply queue + workers with leases
    pigeon.ts             send client: timeout, Idempotency-Key, 429/5xx/4xx handling
    pacer.ts              per-workspace pacing + Retry-After cool-off in Redis (Lua)
    conversations.ts      claim, take over, release, close/reopen, inbox + message pages
    events.ts             seq-numbered change log + Redis pub/sub
    ws.ts                 /ws: auth, Origin check, replay, strict seq order, reset/logout handling
    auth.ts               OIDC + PKCE, JWKS verification, sessions
    billing.ts            bonus: subscribe, seats, cancel, webhook re-read, canSend
    paybox.ts, lock.ts    Paybox client, per-workspace Redis lock
    store.ts, http.ts     collections, indexes, helpers, error handling
    constants.ts          every tuning number with its reason
scaffold/server/test/     unit tests
scaffold/web/src
  App.tsx                 layout, rail, sign-in page with test users
  Inbox.tsx, Thread.tsx   inbox (filters, search, memoized rows) and conversation (pagination, memoized bubbles)
  Billing.tsx             admin billing page (bonus)
  useLiveEvents.ts        WebSocket with reconnect + ?after replay
  components/ui/          shadcn/ui components; components/illustrations.tsx (SVGs)
  lib/                    theme (light/dark), test users, cn()
scripts/                  e2e-selftest.mjs, billing-selftest.mjs, stop-dev.sh (safe stop), checkpoint.sh (commit + push)
PRD.md, BONUS_PRD.md      plans and designs
DECISIONS.md              decisions, cuts, known gaps
AGENTS.md, CLAUDE.md      rules the AI assistant followed while building
ai-logs/                  AI transcripts (unedited) + index
CHECK_REPORT.json         last full check (75/75)
```

---

## 9. Code map (every module and its functions)

For people and AI agents finding their way around. Server code is in `scaffold/server/src`, web code in `scaffold/web/src`.

### Server
| File | Functions (what they do) |
|---|---|
| `index.ts` | `connectWithRetry` (wait for MongoDB + Redis, create indexes), `main` (listen on `PORT`, start live fan-out and outbox worker, mark ready, graceful SIGTERM) |
| `app.ts` | `createApp` (middleware order: security headers, `/healthz`, raw-body webhooks, grader token, JSON, routers, error handler), `state.ready` |
| `config.ts` / `db.ts` / `redis.ts` | settings from the environment / `getDb` / `getRedis` (provided) |
| `lib/constants.ts` | timeouts, lease, pacing gap, backoff, status ranks, session TTLs |
| `lib/store.ts` | `collections`, `ensureIndexes` (unique indexes), `isDup` (E11000), `isKnownWorkspace`, `touchConversation` (idempotent upsert), `deleteAllData` (grader reset) |
| `lib/http.ts` | `handle` (async route wrapper), `sendError`, `safeEqual` (constant-time), `errorHandler` (4xx kept, 503 when storage is down) |
| `lib/signature.ts` | `verifyPigeonSignature` (HMAC over raw body + 5-minute window; also used for Paybox) |
| `lib/inbound.ts` | `storeInboundMessage` (store once, repair conversation, emit), `applyStatus` (forward-only status update) |
| `lib/outbox.ts` | `enqueueReply` (one insert = message + job), worker internals `leaseNextJob` / `processJob` / `retryLater` / `finish` (owner-checked), `startOutboxWorker`, `stopOutboxWorker` |
| `lib/pigeon.ts` | `sendToPigeon` (timeout, Idempotency-Key, result: accepted / rate_limited / retry / rejected) |
| `lib/pacer.ts` | `reserveSendSlot` (Redis Lua: shared per-workspace pacing + cool-off), `startCoolOff` (Retry-After for every instance) |
| `lib/conversations.ts` | `claimConversation` (atomic, retry once on duplicate), `takeOverConversation`, `releaseConversation`, `setConversationState`, `listConversations` (cursor), `getConversation`, `listMessages` (pages of 50) |
| `lib/events.ts` | `emit` (seq via `$inc`, store frame, publish), `emitSafely`, `channelFor` |
| `lib/ws.ts` | `attachWebSocket` (upgrade auth + Origin, replay), `startLiveFanout` (Redis subscriber, logout channel); internals `startClient`, `deliverLive` (gap fill), `sendStored`, `queue`, `refuse` |
| `lib/auth.ts` | `startLogin` / `finishLogin` (OIDC + PKCE, JWKS-verified ID token), `getSession`, `deleteSession`, `roleIn`, `sessionCookie`, `loginStateCookie`, `readCookie`, `readSessionId` |
| `lib/billing.ts` | `subscribeWorkspace`, `changeSeats`, `cancelAtPeriodEnd`, `handlePayboxEvent` (re-read on webhook), `refreshSubscription`, `billingState`, `canSend`, `canSendWith` |
| `lib/paybox.ts` / `lib/lock.ts` | `paybox` (client; refuses a POST without Idempotency-Key), `payboxReason` / `withLock` (Redis lock with owner token + TTL) |
| `routes/webhook.ts` | `POST /webhooks/pigeon` (the PIGEON.md answer table) |
| `routes/paybox-webhook.ts` | `POST /webhooks/paybox` |
| `routes/grader.ts` | `requireGraderToken`, `/__grader/reset`, `snapshot`, `reply`, `claim`, `billing/subscribe`, `billing/seats` |
| `routes/auth.ts` | `/auth/login`, `/auth/callback`, `/auth/logout`, `/api/me` |
| `routes/api.ts` | CSRF guard, per-user rate limit, `requireMember` (401/403), contact validation, inbox/conversation/messages, reply/claim/release/close/reopen |
| `routes/billing.ts` | `/api/billing` (admins see details, agents only `can_send`), `subscribe`, `seats`, `cancel` |

### Web
| File | What it does |
|---|---|
| `App.tsx` | `App` (session, workspace switch, rail, header, paused banner, page switch), `RailButton`, `SignIn` (test-user picker) |
| `Inbox.tsx` | `Inbox` (filters + counts, search, merge-on-refresh, load more), memoized `ConversationRow`, `timeAgo` |
| `Thread.tsx` | `Thread` (claim/take over/release/close/reopen, reply, scroll pagination), memoized `Bubble`, `mergeMessages`, `StatusIcon` |
| `Billing.tsx` | `Billing` (admin page; card -> Paybox token in the browser), `explain` (state in plain words) |
| `useLiveEvents.ts` | `useLiveEvents` (WebSocket, reconnect with backoff, `?after=` replay, reset frame) |
| `api.ts` | `api.*` (typed fetch helpers; every POST sends JSON) |
| `lib/theme.ts`, `lib/people.ts`, `lib/utils.ts` | `useTheme` (light/dark/system), `TEST_USERS` + `nameOf`, `cn` |
| `components/ui/*`, `components/illustrations.tsx` | shadcn/ui button, card, badge, input, avatar (SVG), separator; SVG illustrations |

---

## 10. Not built, and known limits

- **Not built:** end-to-end encrypted private notes (`PROTOCOL.md`) and Elasticsearch search. Plans for both are in
  `BONUS_PRD.md`. Billing does not support updating the card on an existing subscription.
- **Known limits:** listed honestly in [`DECISIONS.md`](DECISIONS.md#what-i-know-is-still-wrong-or-weak). For example,
  a kill between storing a message and writing its live event loses that one live frame (the message itself is
  safe), and a Redis restart signs users out.
