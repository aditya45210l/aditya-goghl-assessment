import { collections, isDup, isKnownWorkspace } from './store.js';
import { emitSafely } from './events.js';
import { paybox, payboxReason } from './paybox.js';
import { withLock } from './lock.js';

// Bonus: per-seat billing on Paybox.
// Rules of thumb used everywhere here:
//  - Paybox is the source of truth. We store a copy, always taken from a fresh GET, never from a webhook body.
//  - Every write to Paybox carries an Idempotency-Key derived from what we are doing, so retries and
//    concurrent duplicates collapse into one operation at Paybox.
//  - Changes for one workspace run one at a time across all instances (Redis lock).

export const PRICE = 'price_seat_monthly';
export type BillingStatus = 'none' | 'incomplete' | 'active' | 'past_due' | 'canceled';

// Paybox status -> the five statuses the contract allows.
// An attempt that expired unpaid (incomplete_expired) never became a subscription: back to "none" (trial).
function toStatus(paybox?: string): BillingStatus {
  if (paybox === 'incomplete' || paybox === 'active' || paybox === 'past_due' || paybox === 'canceled') return paybox;
  return 'none';
}

// Who may send replies (decisions in DECISIONS.md):
// none = free trial, incomplete = waiting for the first payment, past_due = grace while Paybox retries.
// Only a canceled subscription stops sending; reading the inbox always works.
export function canSendWith(status: BillingStatus) {
  return status !== 'canceled';
}

export async function billingState(workspace: string) {
  const { billing } = await collections();
  const doc = await billing.findOne({ workspace });
  const status = toStatus(doc?.status);
  return {
    status,
    seats: status === 'none' ? 0 : (doc?.seats ?? 0),
    can_send: canSendWith(status),
    payment_status: doc?.paymentStatus ?? null,
    action_url: status === 'incomplete' ? (doc?.actionUrl ?? null) : null,
    reason: doc?.reason ?? null,
    period_end: doc?.periodEnd ?? null,
    cancel_at_period_end: !!doc?.cancelAtPeriodEnd,
  };
}

export async function canSend(workspace: string) {
  return (await billingState(workspace)).can_send;
}

// Save a subscription as Paybox returned it at `fetchedAt`. Two guards, both inside the update filter:
//  - an older read never overwrites a newer one (two webhooks can race; the slower one carries an older picture)
//  - only the workspace's CURRENT subscription is stored. A webhook about an old one (e.g. the unpaid attempt
//    we canceled when the admin retried with another card) must not replace the new one.
//    `makeCurrent` is set only by our own subscribe call, which is what switches to a new subscription.
async function storeSubscription(workspace: string, sub: any, fetchedAt: Date, makeCurrent = false) {
  const { billing } = await collections();
  const payment = sub.latest_invoice?.payment;
  const fields = {
    customerId: sub.customer,
    subscriptionId: sub.id,
    status: sub.status,
    seats: sub.quantity,
    paymentStatus: payment?.status ?? null,
    actionUrl: payment?.status === 'requires_action' ? (payment.next_action?.url ?? null) : null,
    reason: payment?.status === 'failed' ? payboxReason(sub) : null,
    periodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
    fetchedAt,
  };
  const isCurrent = makeCurrent ? {} : { $or: [{ subscriptionId: sub.id }, { subscriptionId: { $exists: false } }] };
  try {
    await billing.updateOne(
      { workspace, $and: [{ $or: [{ fetchedAt: { $lt: fetchedAt } }, { fetchedAt: { $exists: false } }] }, isCurrent] },
      { $set: fields },
      { upsert: true },
    );
  } catch (err) {
    if (!isDup(err)) throw err; // duplicate = a newer copy, or another current subscription, is stored: keep it
  }
  await emitSafely(workspace, { type: 'billing.updated', contact: '' });
}

// Read the subscription from Paybox now and store it. Returns null if Paybox does not know it.
export async function refreshSubscription(workspace: string, subscriptionId: string) {
  const fetchedAt = new Date();
  const res = await paybox('GET', '/v1/subscriptions/' + encodeURIComponent(subscriptionId));
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error('paybox read failed: ' + res.status);
  await storeSubscription(workspace, res.data, fetchedAt);
  return res.data;
}

type Outcome = { ok: boolean; reason?: string };

// Admin subscribes the workspace. `token` was made by the browser from the card (the card never reaches us).
// Safe to call several times at once: the lock makes them take turns, and the second caller finds the
// subscription the first one created. The Idempotency-Keys would collapse them at Paybox anyway.
export async function subscribeWorkspace(workspace: string, seats: number, token: string): Promise<Outcome> {
  return withLock('billing:' + workspace, async () => {
    const { billing } = await collections();
    const doc = await billing.findOne({ workspace });

    if (doc?.subscriptionId) {
      const current = await refreshSubscription(workspace, doc.subscriptionId);
      if (current?.status === 'active') return { ok: true };
      if (current?.status === 'past_due') return { ok: false, reason: 'past_due' };
      // same request again (same single-use token): same answer, do not try again
      if (current?.status === 'incomplete' && doc.lastToken === token) return { ok: false, reason: payboxReason(current) };
      // an old unpaid attempt with another card: cancel it so it cannot be paid later by surprise
      if (current?.status === 'incomplete') await paybox('DELETE', '/v1/subscriptions/' + current.id);
    }

    // 1. customer, one per workspace, tagged with the workspace id
    let customerId = doc?.customerId as string | undefined;
    if (!customerId) {
      const res = await paybox('POST', '/v1/customers', { name: workspace, metadata: { workspace } }, 'cus-' + workspace);
      if (res.status !== 200) return { ok: false, reason: payboxReason(res.data) };
      customerId = res.data.id as string;
      await billing.updateOne({ workspace }, { $set: { customerId } }, { upsert: true });
    }

    // 2. the card (as a token) becomes the customer's payment method
    const pm = await paybox('POST', `/v1/customers/${customerId}/payment_method`, { token }, `pm-${workspace}-${token}`);
    if (pm.status !== 200) return { ok: false, reason: payboxReason(pm.data) };

    // 3. the subscription; the first invoice is charged now
    const fetchedAt = new Date();
    const res = await paybox('POST', '/v1/subscriptions', { customer: customerId, price: PRICE, quantity: seats, metadata: { workspace } }, `sub-${workspace}-${token}`);
    if (res.status !== 200) return { ok: false, reason: payboxReason(res.data) };
    await billing.updateOne({ workspace }, { $set: { lastToken: token } }, { upsert: true });
    await storeSubscription(workspace, res.data, fetchedAt, true); // this is now the workspace's subscription
    return res.data.status === 'active' ? { ok: true } : { ok: false, reason: payboxReason(res.data) };
  });
}

// Admin changes the seat count. Increases are charged now (pro rata) and are all-or-nothing;
// decreases apply now and become credit on the next invoice.
export async function changeSeats(workspace: string, seats: number): Promise<Outcome> {
  return withLock('billing:' + workspace, async () => {
    const { billing } = await collections();
    const doc = await billing.findOne({ workspace });
    if (!doc?.subscriptionId) return { ok: false, reason: 'no_subscription' };
    const current = await refreshSubscription(workspace, doc.subscriptionId);
    if (!current) return { ok: false, reason: 'no_subscription' };
    if (current.quantity === seats) return { ok: true };

    // a new key per attempt: a retry after a declined card must really try again, not replay the 402
    const attempt = ((await billing.findOneAndUpdate({ workspace }, { $inc: { seatsAttempts: 1 } }, { returnDocument: 'after' }))?.seatsAttempts as number) ?? 1;
    const res = await paybox('POST', '/v1/subscriptions/' + current.id, { quantity: seats }, `seats-${current.id}-${attempt}`);
    if (res.status !== 200) return { ok: false, reason: payboxReason(res.data) };
    await refreshSubscription(workspace, current.id);
    return { ok: true };
  });
}

// Admin cancels at the end of the paid period.
export async function cancelAtPeriodEnd(workspace: string): Promise<Outcome> {
  return withLock('billing:' + workspace, async () => {
    const { billing } = await collections();
    const doc = await billing.findOne({ workspace });
    if (!doc?.subscriptionId) return { ok: false, reason: 'no_subscription' };
    const res = await paybox('POST', '/v1/subscriptions/' + doc.subscriptionId, { cancel_at_period_end: true }, 'cancel-' + doc.subscriptionId);
    if (res.status !== 200) return { ok: false, reason: payboxReason(res.data) };
    await refreshSubscription(workspace, doc.subscriptionId);
    return { ok: true };
  });
}

// A verified Paybox webhook: work out which subscription it is about, then re-read it from Paybox.
// The event body is only a hint (it may be old, duplicated or out of order).
export async function handlePayboxEvent(event: any) {
  const obj = event?.data?.object ?? {};
  const subscriptionId: string | undefined = obj.object === 'subscription' ? obj.id : obj.subscription;
  if (typeof subscriptionId !== 'string') return; // not about a subscription: nothing to do

  const { billing } = await collections();
  let workspace = (await billing.findOne({ subscriptionId }))?.workspace as string | undefined;
  if (!workspace) {
    // the webhook can arrive before our own subscribe call has stored the id: ask Paybox whose it is
    const customerId = obj.customer ?? (await paybox('GET', '/v1/subscriptions/' + subscriptionId)).data?.customer;
    if (customerId) workspace = (await paybox('GET', '/v1/customers/' + customerId)).data?.metadata?.workspace;
  }
  if (!isKnownWorkspace(workspace)) return; // not one of ours: ignore
  await refreshSubscription(workspace, subscriptionId);
}
