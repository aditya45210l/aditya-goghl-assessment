# Bonus PRD: billing, encrypted notes, search, tests

Sources: `docs/provided/BONUS_BILLING.md`, `docs/provided/PAYBOX.md`, `docs/provided/BRIEF.md` ("Also valued"),
`docs/provided/REFERENCE.html` (Paybox section), and `paybox/server.js` (actual behaviour).

## 0. What counts for what

| Item | Where it is scored | Points | Effort | Recommendation |
|---|---|---|---|---|
| **B. Billing (Paybox)** | Its own automatic check, separate | **10 bonus** | High (~60-75 min) | Do first if we do any bonus; it is the only one with automatic points |
| **N. Encrypted private notes** + `PROTOCOL.md` | Human review, "Security beyond the check" | part of 4 | Medium (~40 min) | Second; strong interview topic |
| **S. Search (Elasticsearch)** | Human review | small | Medium (~30 min) | Third, only if time is left |
| **T. More tests** | "Data model, structure, code quality and tests" | part of 5 | Low (~15 min each) | Add alongside each feature |

Rules that do not change: the bonus "never makes up for a Must tier that fails". Before and after every bonus step,
`npm run check:full` must stay 75/75. Every bonus feature goes behind its own routes/files so the core is untouched.

---

## B. Billing: per-seat subscriptions on Paybox

### B.1 What the brief requires
1. A workspace **admin** subscribes: picks seats, enters a card, pays. **Agents cannot see or change billing.**
2. **Card details never touch our server**: the browser turns the card into a token with the publishable key.
3. Admin can **change seats** later.
4. The app **always knows the subscription state**, including changes nobody clicked: renewal fails, bank approval, Paybox cancels after retries.
5. **Canceled** workspace cannot send (can still read). **Never subscribed** = free trial, can send.
6. Admin sees the state **in plain words and what to do**.

### B.2 Contract additions (exact)
- Create the Paybox customer with `metadata.workspace = <workspace id>`.
- `POST /webhooks/paybox`, signed like Pigeon: header `x-paybox-signature: t=..,v1=..` with `whsec_paybox_dev`.
- `POST /__grader/billing/subscribe { workspace, seats, token }` -> `200` if the subscription is **active**, `402` if not.
- `POST /__grader/billing/seats { workspace, seats }` -> `200` if changed, `402` if not.
- Snapshot: every workspace gets `"billing": { "status": "none|incomplete|active|past_due|canceled", "seats": n, "can_send": bool }`.
- When `can_send` is false, `POST /__grader/reply` answers **`402` and does not send**.

### B.3 What the grader does (and what each step tests)
| Grader step | What must hold |
|---|---|
| Subscribes one workspace **3 times in the same instant** | Exactly one customer and one subscription in Paybox; all three answers consistent |
| Changes seats | Paybox quantity changes once; snapshot seats match |
| Pays a 2nd workspace with card `0341` (first charge ok, later declined), moves the clock past renewal and retries | We follow `active -> past_due -> canceled` from webhooks; `can_send` becomes false |
| Posts a **forged** webhook (claims "active") | 401; state unchanged (forgedAccepted = 0) |
| Checks canceled cannot send, paying one can | `/__grader/reply` 402 vs 202 |
| Reads Paybox report | `rawCardViaSecretKey = 0` (no card numbers through our server), `postsWithoutIdempotencyKey = 0` |

### B.4 Verified Paybox facts that shape the design (from `paybox/server.js`)
- Idempotency is per `METHOD + path + key`, and an **in-flight request with the same key shares the same result** (even errors like 402 are replayed). So a stable key per logical operation collapses the 3 concurrent subscribes into one.
- Every `POST /v1/customers*` and `/v1/subscriptions*` with the secret key **without** an Idempotency-Key is counted against us.
- Tokens are single-use; a second use is `token_already_used`.
- `200` does not mean paid: read `status` and `latest_invoice.payment.status`.
- Seat increase charges pro rata immediately; failure is `402` and quantity is unchanged. Seat decrease is immediate, creates credit, no refund. Seats can only change while `active` or `past_due`.
- Renewal every 30 days; failure -> `past_due`, retries after 3 days and 2 more days, third failure -> `canceled`. Unpaid `incomplete` expires after 23 h -> `incomplete_expired` (event `customer.subscription.deleted`).
- Webhooks: at least once (~15% duplicates), any order, up to 0.8 s delay, 3 attempts. Event object is a **past snapshot**; `GET /v1/subscriptions/:id` is the present. `created` follows the test clock.

### B.5 Design (simple, same principles as the core)

**Data**: collection `billing`, one document per workspace, unique index on `workspace`:
```
{ workspace, customerId, subscriptionId, status, seats, paymentStatus, actionUrl,
  cardBrand, cardLast4, periodEnd, lastEventAt, seatsVersion, updatedAt }
```
No document = `status: none` (free trial).

**`can_send` rule** (one function, used by the API reply route and `/__grader/reply`):
| status | can_send | reason |
|---|---|---|
| `none` | true | free trial (brief) |
| `incomplete` | true *(decision)* | first payment pending; same as trial until it resolves or expires |
| `active` | true | paid |
| `past_due` | true *(decision)* | grace period while Paybox retries (max ~5 days); admin sees a warning |
| `canceled` / `incomplete_expired` | **false** | brief: canceled cannot send; reads still work |

The outbox worker also checks `can_send` before sending? **No**: replies already accepted (202) were accepted while allowed; we keep "an accepted reply is never lost". The gate is at accept time. (Decision, written in DECISIONS.md.)

**Source of truth = Paybox, read fresh.** Webhooks are only a *trigger*:
- On any verified Paybox webhook: take the subscription id from the event (or the invoice's `subscription`), then `GET /v1/subscriptions/:id` and store **that** state. This makes duplicates, wrong order and stale snapshots harmless: we always store the present.
- Dedupe by event id is not even needed for correctness (re-reading is idempotent), but we keep a unique `paybox_events` index to skip repeat work.
- A forged webhook fails the signature check -> 401, nothing read, nothing stored.

**Subscribe flow** (UI and grader share `subscribeWorkspace(workspace, seats, token)`):
1. Redis lock `billing:lock:<ws>` (SET NX PX 15 s) so concurrent subscribes for one workspace run one at a time. Losers wait briefly and re-read, then return the same result.
2. If the workspace already has an `active`/`past_due` subscription: return its state (200), do not create another.
3. Customer: `POST /v1/customers` with `Idempotency-Key: cus-<ws>`, `metadata.workspace`. Store `customerId`.
4. Card: `POST /v1/customers/:id/payment_method {token}` with key `pm-<ws>-<token>`.
5. Subscription: `POST /v1/subscriptions {customer, price: price_seat_monthly, quantity}` with key `sub-<ws>-<n>` where `n` = attempt number stored in `billing` (so a later re-subscribe after cancel gets a new key, but the 3 concurrent calls share one).
6. Store the returned subscription (status, seats, latest payment status, `next_action.url` if `requires_action`).
7. Answer: `200` if `status == active`, else `402` with `{status, reason, action_url?}`.

**Seats flow** (`changeSeats(workspace, seats)`): lock, require a subscription; `POST /v1/subscriptions/:id {quantity}` with key `seats-<sub>-<seatsVersion+1>-<seats>`; on 200 store new quantity and bump `seatsVersion`; on 402 keep old seats and answer 402 (`card declined` / `needs approval`). Paybox 400 (`subscription_not_active`) -> 402 with a clear message.

**Bank approval (3155 card)**: subscribe returns `incomplete` + `actionUrl`; UI shows "Waiting for your bank" with a button that opens the URL; the result comes by webhook (`invoice.paid` / `payment_failed`) and the WebSocket frame `billing.updated` refreshes the UI.

**Admin-only**: all `/api/billing/*` routes require `role === 'admin'` in that workspace (agents get 403; the UI hides the tab).

**Card never touches our server**: the React form posts the card straight to `http://localhost:4030/v1/tokens` with the **publishable** key (Paybox allows any origin), then sends only `{seats, token}` to our API. Our server never accepts a `card` field (reject 400 if present).

**Reset**: `/__grader/reset` also deletes `billing` and `paybox_events` (the grader resets Paybox itself).

**Snapshot**: add `billing: {status, seats, can_send}` to **every** workspace we know (`ws_acme`, `ws_globex`), `none/0/true` if no document.

### B.6 API (for our UI)
| Route | Who | Does |
|---|---|---|
| `GET /api/billing?workspace=` | admin | state in plain words: status, seats, card brand/last4, period end, `can_send`, `actionUrl`, message + next step |
| `POST /api/billing/subscribe` `{workspace, seats, token}` | admin | same as grader subscribe |
| `POST /api/billing/seats` `{workspace, seats}` | admin | same as grader seats |
| `POST /api/billing/cancel` `{workspace}` | admin | `cancel_at_period_end: true` (optional) |
| WS frame `billing.updated` | members | refresh banner / billing page |

### B.7 UI (shadcn)
- **Billing page** (admin only, tab in the top bar): status card with a coloured badge and one plain sentence + action:
  - none: "Free trial. Subscribe to keep sending after the trial." [Subscribe]
  - incomplete + action: "Waiting for your bank to approve the payment." [Open bank page]
  - incomplete (declined): "Payment declined: <reason>. Try another card." [Update card]
  - active: "Active: N seats, renews on <date>." [Change seats]
  - past_due: "Renewal failed. Paybox will retry on <date>. Update the card to avoid cancellation." [Update card]
  - canceled: "Canceled. Sending is paused; your inbox is still readable." [Subscribe again]
- **Subscribe form**: seats (number), card number, expiry, CVC; price preview `seats x $12 / 30 days`. Card goes to Paybox only.
- **Seats change**: number input, shows "extra seats are charged now, pro rata" / "removed seats become credit on the next invoice" (answers the brief's "should the admin be told about the credit": yes).
- **Everyone**: if `can_send` is false the reply box says "Sending is paused: this workspace's subscription is canceled. Ask an admin." 

### B.8 Decisions to write in DECISIONS.md (the brief asks for these)
- `past_due`: can send during Paybox's retry window (up to ~5 days); admins see a warning banner.
- Seats below the number of people: we do not lock anyone out (seats are a billing count; the IdP owns membership); admins see "N people, M seats" and a warning.
- Seat reduction mid-month: the admin is told the unused amount becomes credit on the next invoice, no refund.
- While waiting for the bank: "Waiting for your bank" state with the approval link; sending allowed (same as trial).

### B.9 Build steps (boxes)
1. `lib/paybox.ts` client (secret key, timeout, Idempotency-Key required on every POST) + `billing` collection/index + reset/snapshot fields. **Commit.**
2. `routes/paybox-webhook.ts`: raw body, signature (reuse `verifyPigeonSignature` with the Paybox secret/header), re-read subscription, store, emit `billing.updated`. **Commit.**
3. `lib/billing.ts`: `subscribeWorkspace`, `changeSeats`, `canSend`, Redis lock. Grader endpoints. Gate `/__grader/reply` and API reply with 402. **Commit.**
4. Self-test script (no official billing check is provided): subscribe x3 concurrently, seats change, `0341` card + `test_clock/advance` 31 then 3 then 2 days, `__admin/forge`, then read `__admin/report` (flags must be 0) and our snapshot. **Commit.**
5. UI: Billing page + banner + gated reply box. **Commit.**
6. Re-run `check:full` in the background: must still be 75/75. Update DECISIONS/README. **Commit.**

### B.10 Risks
| Risk | Mitigation |
|---|---|
| Duplicate customers/subscriptions from concurrent subscribes | Redis lock + deterministic Idempotency-Keys |
| Same key reused for a different later seat change | key includes `seatsVersion` |
| Trusting webhook body (forged or stale) | signature check + always re-read from Paybox |
| Card number reaching our server | browser tokenises with publishable key; server rejects any `card` field |
| Breaking the 75/75 core | billing gate is one `canSend()` check at reply accept time; full check re-run |

---

## N. End-to-end encrypted private notes (+ PROTOCOL.md)

**Requirement (BRIEF)**: agents leave a note on a conversation for other agents in the workspace; **the server stores it but must not be able to read it**. Write `PROTOCOL.md`: who holds which key, what the server stores, and **three attacks the scheme does not stop**.

**Simple scheme (browser Web Crypto, no new packages)**:
- Each workspace has a symmetric **workspace notes key** (AES-GCM 256) that the server never sees in plaintext.
- Each user generates an **ECDH P-256 key pair** in the browser; private key stays in IndexedDB (non-extractable); public key is uploaded to the server (`/api/keys`).
- The first member to need notes creates the workspace key and stores it **wrapped** for each member's public key (ECDH + HKDF -> AES-KW/GCM). An existing member wraps it for new members when they appear (shown as "N members waiting for access").
- A note = `{conversation, ciphertext, iv, author, createdAt}`; encrypted with the workspace key and AES-GCM with the workspace id + contact as additional data (prevents moving a note to another conversation).
- Server stores only public keys, wrapped keys, and ciphertext; it checks membership as usual.

**PROTOCOL.md attacks we do NOT stop** (honest): (1) a malicious server can swap a member's public key (no key verification/fingerprints), (2) a removed member who kept the workspace key can still decrypt old and new notes (no rotation), (3) a compromised browser / XSS reads keys and plaintext; plus metadata (who wrote when, on which conversation) is visible to the server.

**Steps**: keys API + notes API (ciphertext only) -> browser crypto module -> notes panel in Thread -> PROTOCOL.md -> unit test that the server never receives plaintext (encrypt/decrypt round trip in Node webcrypto).

## S. Search over messages (Elasticsearch, workspace-scoped)

**Requirement**: search over messages, limited to the user's workspace. ES is optional: `npm run up:search`.
- Index `messages` with `{workspace (keyword), contact (keyword), text (text), direction, at}`; doc id = `workspace:dir:key` (idempotent re-index).
- Write path: after a message is stored in Mongo, index it (best effort; Mongo stays the truth). A small backfill script/endpoint reindexes from Mongo.
- Query: `GET /api/search?workspace=&q=` -> member guard -> ES `bool` query with **filter `term workspace`** (isolation enforced in the query, never in the client) + `match text`; highlight; limit 20.
- If ES is down/not started: search returns 503 "search unavailable", nothing else is affected. Server must still start without ES (the check does not run it).
- UI: search box above the inbox; results open the conversation.

## T. Tests to add (cheap, high value)
- Paybox signature verify (forged/stale) and `canSend()` table.
- Billing subscribe concurrency: 3 parallel `subscribeWorkspace` -> one customer/sub (against the real Paybox simulator).
- Notes: crypto round trip; server-side note document contains no plaintext.
- Search: query always carries the workspace filter (unit test on the query builder).

---

## Order and time boxes
1. **B (billing)**: B.9 steps 1-4 first (the 10 automatic points live there), UI step 5 after.
2. **N (notes)** if 40+ minutes remain after B.
3. **S (search)** only with spare time.
4. Before submit: `check:full` 75/75 in the background, DECISIONS updated, ai-logs exported.
