// Small fetch helpers. The Vite proxy sends /api, /auth and /ws to the server, so cookies just work.

export type Membership = { id: string; role: string };
export type Me = { sub: string; name?: string; workspaces: Membership[] };
export type Conversation = { contact: string; assignee: string | null; state: 'open' | 'closed'; lastActivityAt: string };
export type Message = { id: string; direction: 'in' | 'out'; text: string; at: string; status?: string };

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'include',
    // every POST carries a JSON body: the server refuses state changes that are not JSON (CSRF guard)
    headers: method === 'GET' ? undefined : { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || data.reason || 'request failed'), { status: res.status, data });
  return data as T;
}

export type Billing = {
  status: 'none' | 'incomplete' | 'active' | 'past_due' | 'canceled' | 'ok';
  can_send: boolean;
  seats?: number;
  payment_status?: string | null;
  action_url?: string | null;
  reason?: string | null;
  period_end?: string | null;
  cancel_at_period_end?: boolean;
  price_per_seat_cents?: number;
  paybox?: { url: string; publishableKey: string };
};
export type BillingResult = { ok: boolean; reason?: string; billing: Billing };

const q = (workspace: string) => '?workspace=' + encodeURIComponent(workspace);
const conv = (contact: string) => '/api/conversations/' + encodeURIComponent(contact);

export const api = {
  me: () => request<Me>('GET', '/api/me'),
  logout: () => request('POST', '/auth/logout'),
  conversations: (ws: string, before?: string) =>
    request<{ items: Conversation[]; next: string | null }>('GET', '/api/conversations' + q(ws) + (before ? '&before=' + encodeURIComponent(before) : '')),
  conversation: (ws: string, contact: string) => request<Conversation>('GET', conv(contact) + q(ws)),
  // newest page first; `before` = cursor of the oldest message already shown, to load older ones
  messages: (ws: string, contact: string, before?: string) =>
    request<{ items: Message[]; older: string | null }>('GET', conv(contact) + '/messages' + q(ws) + (before ? '&before=' + encodeURIComponent(before) : '')),
  // client_ref is made here, per message; the server turns a repeated client_ref into one reply
  reply: (ws: string, contact: string, text: string) =>
    request('POST', conv(contact) + '/reply' + q(ws), { text, client_ref: crypto.randomUUID() }),
  claim: (ws: string, contact: string, takeover = false) => request('POST', conv(contact) + '/claim' + q(ws), { takeover }),
  billing: (ws: string) => request<Billing>('GET', '/api/billing' + q(ws)),
  subscribe: (ws: string, seats: number, token: string) => request<BillingResult>('POST', '/api/billing/subscribe' + q(ws), { seats, token }),
  changeSeats: (ws: string, seats: number) => request<BillingResult>('POST', '/api/billing/seats' + q(ws), { seats }),
  cancelBilling: (ws: string) => request<BillingResult>('POST', '/api/billing/cancel' + q(ws), {}),
  release: (ws: string, contact: string) => request('POST', conv(contact) + '/release' + q(ws)),
  close: (ws: string, contact: string) => request('POST', conv(contact) + '/close' + q(ws)),
  reopen: (ws: string, contact: string) => request('POST', conv(contact) + '/reopen' + q(ws)),
};
