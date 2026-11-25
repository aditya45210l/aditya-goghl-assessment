# Decisions

## What I built first and why
Order followed the score and the brief: webhook intake and the grader contract first (so the check could run
from the first half hour), then replies and claim (level 1), then login, tenant isolation and WebSocket
(level 5), then verified crash and multi-copy behaviour (levels 2, 3), then the UI.

Core design (all state in MongoDB/Redis, any instance can die at any line):
- **Duplicates are harmless by construction**: unique indexes on (workspace, direction, message_id or client_ref)
  and (workspace, contact). A duplicate insert fails and is treated as "already done". No read-then-write.
- **Store, then acknowledge**: a webhook gets 2xx and a reply gets 202 only after MongoDB has it.
- **An outbound message is its own send job** (one document, one insert), so a reply can never exist without
  its job. Workers lease jobs for 10 s; a dead instance's jobs are taken over after the lease. Every send
  carries `Idempotency-Key = client_ref`, so a resend after a timeout or a crash never delivers twice.
- **Rate limit shared by all instances**: a Redis Lua script paces sends to under 4/s per workspace, and a 429
  sets a shared cool-off key, so no instance sends inside a Retry-After window.
- **Status only moves forward** (queued < sent < delivered/failed): a late `sent` never overwrites `delivered`.
- **Claim is one conditional upsert**; losers hit the unique index and get 409.
- **WebSocket**: every change gets a per-workspace `seq` (MongoDB `$inc`), is stored, and is fanned out via
  Redis pub/sub. Each socket sends frames strictly in order and fills gaps from MongoDB, so frames produced
  by other instances never arrive out of order. `?after=N` replays from the stored log.

## Cut, and what that means
- **End-to-end encrypted notes**: not built (no PROTOCOL.md). Agents cannot leave private notes yet.
- **Elasticsearch search**: not built. There is no message search.
- **UI**: shadcn/ui components (Tailwind v4) with inbox filters, live status badges and claim-to-reply. On any live change it refetches the visible lists instead of patching
  state; simple and correct, but more requests than necessary. A thread shows the latest 500 messages.
- **Process safety net**: unexpected errors are logged instead of killing the process (work is lease-based, so a
  crash would lose nothing, but staying up is better); a server that cannot bind its port exits.

## Bonus: billing (Paybox)
Built: admin subscribes (seats + card), changes seats, cancels at period end; state follows Paybox through
webhooks; canceled workspaces cannot send (`/__grader/reply` and UI reply answer 402); agents cannot see or
change billing (403). `node scripts/billing-selftest.mjs` runs the grader's scenario against the simulator: 18/18.
- **Card never reaches our server**: the browser turns it into a token with the publishable key; the API refuses
  any `card` field. Paybox's report shows 0 card numbers via the secret key and 0 POSTs without Idempotency-Key.
- **Concurrency**: a per-workspace Redis lock makes subscribes/seat changes take turns across instances, and every
  Paybox POST has a key derived from the operation (`cus-<ws>`, `sub-<ws>-<token>`, `seats-<sub>-<attempt>`), so
  three simultaneous subscribes give one customer and one subscription.
- **Webhooks are hints**: after the signature check we re-read the subscription from Paybox and store that. Two
  guards in the update filter: an older read never overwrites a newer one, and only the workspace's current
  subscription is stored (the self-test caught a webhook about a canceled earlier attempt overwriting the new one).
- **past_due**: can still send during Paybox's retry window (about 5 days); the admin sees what happens next.
- **incomplete** (declined or waiting for the bank): still the free trial, can send. An unpaid attempt that expires
  counts as never subscribed. The UI shows "Waiting for your bank" with the approval link and updates by webhook.
- **Seats below the number of people**: nobody is locked out; seats are a billing count and membership comes
  from the IdP. (A later version would warn the admin.)
- **Removing seats mid-month**: the admin is told it applies now and becomes credit on the next invoice, no refund.
- Replies accepted (202) before a cancellation still go out: the gate is at accept time, and "an accepted reply is
  never lost" wins.
- Not built: updating the card on an existing subscription (a past_due admin can only wait or subscribe again).

## Decisions where the brief was silent
- Inbound order is by `occurred_at`, then message id (what Pigeon's report calls the true order).
- A reply to a workspace we do not know is `404`; missing fields are `400`.
- Roles: `agent` and `admin` can both read, reply, claim, release their own, close and reopen.
  Only `admin` can take over or release a conversation someone else holds.
- Close/reopen: the holder, anyone if nobody holds it, or an admin. Closing keeps the assignee. Replies to a
  closed conversation are refused (409, "reopen first"); claiming a closed one is allowed.
- Contacts in the agent API must be E.164 phone numbers (`+` and 6-15 digits), so no junk conversations.
- An agent can reply only to a conversation they hold (409 otherwise; the UI shows "Claim to reply").
  `/__grader/reply` is the system path and does not require a claim, as the contract says.
- A new customer message does not reopen a closed conversation automatically; it moves it to the top of the inbox.
- Sessions live 8 h in Redis (the IdP has no refresh tokens or logout); `POST /auth/logout` ends ours.
  Workspaces and roles are taken from the verified ID token at login and kept for the session.
- A send rejected by Pigeon with 400/401 is marked `failed`; 429/5xx/timeouts are retried indefinitely with
  backoff (a reply must not be lost), paced so an outage costs only a few requests per second.

## What I know is still wrong or weak
- If an instance is killed between storing an inbound message and writing its event, that one WebSocket frame
  is never produced (the message itself is stored and visible on refresh). Fix: an `emitted` flag swept on boot.
- The pacer uses fixed spacing and no burst, so a burst of N replies takes about N/4 seconds to go out.
- Sessions are not refreshed when a user's workspace membership changes at the IdP until they sign in again.
- Unique indexes are created at boot and again on every reset. If MongoDB is wiped while a server keeps
  running (seen once in development when the container was recreated), duplicates can slip in until the next
  reset or restart; a restart then refuses to become ready until they are removed, rather than run unprotected.
- Redis is treated as durable enough for sessions and pacing; a Redis restart signs everyone out.
- CSRF: no token. State-changing `/api` calls must be JSON (a plain HTML form cannot send it) and, when the
  browser sends `Origin`, it must equal `WEB_ORIGIN`; WebSocket upgrades check `Origin` the same way. Cookies are
  `SameSite=Lax`. Login state is bound to the browser with a short `login_state` cookie (stops login CSRF).
- Failed send attempts are logged (workspace, client_ref, reason; never message text or keys) and the last
  error is stored on the message, but there are no metrics or dashboards.
- Unit tests are few: signature checking, cookie parsing and the claim race. The rest is covered by the
  provided check, not by our own tests.
