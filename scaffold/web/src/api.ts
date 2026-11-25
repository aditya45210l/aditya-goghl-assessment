// Small fetch helpers. The Vite proxy sends /api, /auth and /ws to the server, so cookies just work.

export type Membership = { id: string; role: string };
export type Me = { sub: string; name?: string; workspaces: Membership[] };
export type Conversation = { contact: string; assignee: string | null; state: 'open' | 'closed'; lastActivityAt: string };
export type Message = { id: string; direction: 'in' | 'out'; text: string; at: string; status?: string };

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'request failed'), { status: res.status });
  return data as T;
}

const q = (workspace: string) => '?workspace=' + encodeURIComponent(workspace);
const conv = (contact: string) => '/api/conversations/' + encodeURIComponent(contact);

export const api = {
  me: () => request<Me>('GET', '/api/me'),
  logout: () => request('POST', '/auth/logout'),
  conversations: (ws: string, before?: string) =>
    request<{ items: Conversation[]; next: string | null }>('GET', '/api/conversations' + q(ws) + (before ? '&before=' + encodeURIComponent(before) : '')),
  conversation: (ws: string, contact: string) => request<Conversation>('GET', conv(contact) + q(ws)),
  messages: (ws: string, contact: string) => request<{ items: Message[] }>('GET', conv(contact) + '/messages' + q(ws)),
  // client_ref is made here, so a retried click is still one reply on the server
  reply: (ws: string, contact: string, text: string) =>
    request('POST', conv(contact) + '/reply' + q(ws), { text, client_ref: crypto.randomUUID() }),
  claim: (ws: string, contact: string, takeover = false) => request('POST', conv(contact) + '/claim' + q(ws), { takeover }),
  release: (ws: string, contact: string) => request('POST', conv(contact) + '/release' + q(ws)),
  close: (ws: string, contact: string) => request('POST', conv(contact) + '/close' + q(ws)),
  reopen: (ws: string, contact: string) => request('POST', conv(contact) + '/reopen' + q(ws)),
};
