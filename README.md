# Switchboard

A shared team inbox: customers write in through Pigeon (a messaging provider), support agents
sign in, see conversations live, claim them, reply, close and reopen. Several workspaces share
one deployment and never see each other's data.

## Run from a clean clone

Needs Node 22+ and Docker.

```bash
npm run scaffold:install   # install server and web dependencies (same as switchboard.json "install")
npm run up                 # MongoDB, Redis and the simulators in Docker, then a readiness check
npm run scaffold:server    # API on http://localhost:4000 (reads PORT and every URL from the environment)
npm run scaffold:web       # React app on http://localhost:5173 -> "Sign in", pick a test user
```

Configuration comes from the environment; defaults match `.env.example`, so no `.env` is required.

## Check it

```bash
npm run check              # level 1 (stop the dev server first: the check starts its own)
npm run check:full         # levels 1, 2, 3, 5; writes CHECK_REPORT.json
npm --prefix scaffold/server test   # unit tests (signature, cookie parsing, claim race)
```

Last full check: see `CHECK_REPORT.json` (75 / 75 on levels 1, 2, 3 and 5 during development).

## Layout

```
scaffold/server/src
  index.ts            boot: wait for MongoDB/Redis, indexes, /healthz ready flag, outbox worker, WebSocket
  app.ts              routes; the webhook route reads the raw body (signature is over exact bytes)
  routes/             webhook.ts, grader.ts, auth.ts, api.ts  (thin: validate, call lib, answer)
  lib/
    signature.ts      Pigeon HMAC check, 5-minute window
    inbound.ts        store inbound messages (idempotent), apply delivery statuses (only forward)
    outbox.ts         reply queue + worker with leases (survives kill -9 and lost instances)
    pigeon.ts         send API client: timeout, Idempotency-Key, classify 429/5xx/4xx
    pacer.ts          per-workspace send pacing and Retry-After cool-off, shared through Redis
    conversations.ts  claim (atomic), release, close/reopen, inbox and thread queries
    events.ts         seq-numbered change log + Redis pub/sub
    ws.ts             /ws: auth, ?after replay, live frames in strict seq order
    auth.ts           OIDC code + PKCE, ID token verification (JWKS), sessions in Redis
    store.ts          collections, unique indexes, helpers
    constants.ts      every tuning number with its reason
scaffold/web/src      App, Inbox, Thread, useLiveEvents (reconnects with ?after), api.ts
docs/provided/        the brief and reference material we were given
```

See `DECISIONS.md` for what was built, cut and assumed, and what is still wrong.
AI transcripts are in `ai-logs/`.
