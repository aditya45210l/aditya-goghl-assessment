// Our own end-to-end workflow test (on top of the provided check). Drives the REAL server like a client:
// signs in through the mock IdP, sends signed webhooks, uses the agent API and the WebSocket.
// Needs: services up and the server on :4000.  WARNING: wipes application data (dev only).
// Run: node scripts/e2e-selftest.mjs
import { createHmac, randomUUID } from 'node:crypto';

const APP = process.env.APP_URL || 'http://localhost:4000';
const PIGEON = process.env.PIGEON_URL || 'http://localhost:4010';
const SECRET = 'whsec_pigeon_dev';
const G = { 'content-type': 'application/json', 'x-grader-token': 'grader-dev-token' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  (' + detail + ')' : '')); if (!ok) failed++; };
const json = (r) => r.json().catch(() => ({}));

// ---- helpers
function webhook(event, { t = Math.floor(Date.now() / 1000), secret = SECRET, raw } = {}) {
  const body = raw ?? JSON.stringify(event);
  const sig = 't=' + t + ',v1=' + createHmac('sha256', secret).update(t + '.' + body).digest('hex');
  return fetch(APP + '/webhooks/pigeon', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pigeon-signature': sig }, body });
}
const inbound = (ws, from, id, at, text = 'hi') =>
  ({ id: 'evt_' + id, type: 'message.inbound', workspace: ws, occurred_at: new Date(at).toISOString(), data: { message_id: id, from, text } });
const snapshot = async () => json(await fetch(APP + '/__grader/snapshot', { headers: G }));
const grader = (path, body) => fetch(APP + path, { method: 'POST', headers: G, body: JSON.stringify(body) });

// sign in through the IdP exactly as a browser would (same as the check does)
async function signIn(sub) {
  const jar = {};
  const keep = (res) => { for (const c of res.headers.getSetCookie()) { const [p] = c.split(';'); const i = p.indexOf('='); jar[p.slice(0, i)] = p.slice(i + 1); } };
  const cookie = () => Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');
  const start = await fetch(APP + '/auth/login?login=' + sub, { redirect: 'manual' });
  keep(start);
  const idp = await fetch(start.headers.get('location'), { redirect: 'manual' });
  const back = new URL(idp.headers.get('location'));
  const cb = await fetch(APP + back.pathname + back.search, { redirect: 'manual', headers: { cookie: cookie() } });
  keep(cb);
  return cookie();
}
const api = (cookie, method, path, body) =>
  fetch(APP + path, { method, headers: { cookie, ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });

// ---- 0. clean slate
await grader('/__grader/reset', {});
await fetch(PIGEON + '/__admin/drizzle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"on":false}' });

console.log('\n# Webhooks (Pigeon contract)');
const now = Date.now();
check('genuine webhook -> 200', (await webhook(inbound('ws_acme', '+14155550101', 'pmsg_e2e_2', now))).status === 200);
check('same webhook again -> 200 (idempotent)', (await webhook(inbound('ws_acme', '+14155550101', 'pmsg_e2e_2', now))).status === 200);
check('older message arriving later -> 200', (await webhook(inbound('ws_acme', '+14155550101', 'pmsg_e2e_1', now - 5000))).status === 200);
check('forged signature -> 401', (await webhook(inbound('ws_acme', '+14155550101', 'forged_1', now), { secret: 'nope' })).status === 401);
check('replayed (1h old) -> 401', (await webhook(inbound('ws_acme', '+14155550101', 'stale_1', now), { t: Math.floor(now / 1000) - 3600 })).status === 401);
check('unknown workspace -> 200 ignored', (await webhook(inbound('ws_nope', '+1', 'pmsg_x', now))).status === 200);
check('unknown event type -> 200 ignored', (await webhook({ id: 'e', type: 'message.reaction', workspace: 'ws_acme', data: {} })).status === 200);
check('status for a reply we never sent -> 200', (await webhook({ id: 'e2', type: 'message.status', workspace: 'ws_acme', data: { client_ref: 'never', status: 'sent' } })).status === 200);
check('unparseable body -> 400', (await webhook(null, { raw: '{not json' })).status === 400);
let snap = await snapshot();
const inb = snap.workspaces.ws_acme.contacts['+14155550101'].inbound;
check('stored once each, ordered by occurred_at', JSON.stringify(inb) === JSON.stringify(['pmsg_e2e_1', 'pmsg_e2e_2']), JSON.stringify(inb));

console.log('\n# Replies and claims (grader contract)');
const ref = 'e2e_' + randomUUID();
const [r1, r2] = await Promise.all([1, 2].map(() => grader('/__grader/reply', { workspace: 'ws_acme', contact: '+14155550102', text: 'hello', client_ref: ref })));
check('same client_ref twice at once -> both 202', r1.status === 202 && r2.status === 202);
check('reply to unknown workspace -> 404', (await grader('/__grader/reply', { workspace: 'ws_x', contact: '+1', text: 'x', client_ref: 'x' })).status === 404);
const claims = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => grader('/__grader/claim', { workspace: 'ws_globex', contact: '+442079460202', agent: 'a' + i })));
check('6 agents claim at once -> exactly one 200', claims.filter((r) => r.status === 200).length === 1, claims.map((r) => r.status).join(','));
let delivered = false;
for (let i = 0; i < 20 && !delivered; i++) { await sleep(500); delivered = ['delivered', 'failed'].includes((await snapshot()).workspaces.ws_acme.outbound[ref]); }
check('reply reaches a final status from Pigeon', delivered);
check('grader without token -> 401', (await fetch(APP + '/__grader/snapshot')).status === 401);

console.log('\n# Login, tenant isolation, agent workflow');
const ben = await signIn('u_ben');
const me = await json(await api(ben, 'GET', '/api/me'));
check('Ben signs in through the IdP', me.sub === 'u_ben' && me.workspaces?.[0]?.id === 'ws_acme', JSON.stringify(me));
check('own workspace 200', (await api(ben, 'GET', '/api/conversations?workspace=ws_acme')).status === 200);
check("another workspace 403", (await api(ben, 'GET', '/api/conversations?workspace=ws_globex')).status === 403);
check('no session 401', (await fetch(APP + '/api/conversations?workspace=ws_acme')).status === 401);
const C = encodeURIComponent('+14155550101');
check('reply without claiming -> 409', (await api(ben, 'POST', `/api/conversations/${C}/reply?workspace=ws_acme`, { text: 'x' })).status === 409);
check('claim -> 200', (await api(ben, 'POST', `/api/conversations/${C}/claim?workspace=ws_acme`)).status === 200);
check('reply after claiming -> 202', (await api(ben, 'POST', `/api/conversations/${C}/reply?workspace=ws_acme`, { text: 'on it' })).status === 202);
const asha = await signIn('u_asha');
check('another agent cannot claim it (409)', (await api(asha, 'POST', `/api/conversations/${C}/claim?workspace=ws_acme`)).status === 409);
check('admin can take it over', (await api(asha, 'POST', `/api/conversations/${C}/claim?workspace=ws_acme`, { takeover: true })).status === 200);
check('former holder cannot close it now (409)', (await api(ben, 'POST', `/api/conversations/${C}/close?workspace=ws_acme`)).status === 409);
check('holder closes it', (await api(asha, 'POST', `/api/conversations/${C}/close?workspace=ws_acme`)).status === 200);
check('no reply to a closed conversation (409)', (await api(asha, 'POST', `/api/conversations/${C}/reply?workspace=ws_acme`, { text: 'x' })).status === 409);
check('junk contact rejected (400)', (await api(ben, 'POST', `/api/conversations/foo/claim?workspace=ws_acme`)).status === 400);
const form = await fetch(APP + `/api/conversations/${C}/reopen?workspace=ws_acme`, { method: 'POST', headers: { cookie: asha, 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' });
check('cross-site form post blocked (415)', form.status === 415);
check('agent cannot see billing details', (await json(await api(ben, 'GET', '/api/billing?workspace=ws_acme'))).paybox === undefined);

console.log('\n# Message pagination');
const P = '+12125550104';
for (let i = 0; i < 120; i++) await webhook(inbound('ws_acme', P, 'pmsg_pg_' + String(i).padStart(3, '0'), now - (120 - i) * 1000, 'm' + i));
const pages = [];
let before = null;
do {
  const r = await json(await api(ben, 'GET', `/api/conversations/${encodeURIComponent(P)}/messages?workspace=ws_acme` + (before ? '&before=' + encodeURIComponent(before) : '')));
  pages.push(r.items.length);
  pages.ids = [...r.items.map((m) => m.id), ...(pages.ids ?? [])];
  before = r.older;
} while (before && pages.length < 10);
check('pages of 50 newest first: 50, 50, 20', JSON.stringify([...pages]) === '[50,50,20]', JSON.stringify([...pages]));
const ids = pages.ids;
check('all 120 messages, no duplicates, in order', ids.length === 120 && new Set(ids).size === 120 && ids.every((id, i) => i === 0 || id > ids[i - 1]));

console.log('\n# Real time (WebSocket)');
const frames = [];
const sock = new WebSocket(APP.replace('http', 'ws') + '/ws?workspace=ws_acme', { headers: { cookie: ben } });
await new Promise((r) => { sock.onopen = r; sock.onerror = r; setTimeout(r, 3000); });
sock.onmessage = (m) => frames.push(JSON.parse(m.data));
await webhook(inbound('ws_acme', '+14155550103', 'pmsg_live_1', Date.now()));
await webhook(inbound('ws_globex', '+442079460201', 'pmsg_live_other', Date.now()));
await sleep(1500);
check('live frame arrives with seq', frames.some((f) => f.message_id === 'pmsg_live_1' && typeof f.seq === 'number'));
check('no frames from another workspace', !frames.some((f) => f.message_id === 'pmsg_live_other'));
const last = Math.max(...frames.map((f) => f.seq));
sock.close();
await webhook(inbound('ws_acme', '+14155550103', 'pmsg_missed_1', Date.now()));
const again = [];
const s2 = new WebSocket(APP.replace('http', 'ws') + '/ws?workspace=ws_acme&after=' + last, { headers: { cookie: ben } });
s2.onmessage = (m) => again.push(JSON.parse(m.data));
await sleep(1500);
s2.close();
check('reconnect with after= replays what was missed', again.some((f) => f.message_id === 'pmsg_missed_1') && again.every((f) => f.seq > last));
const stranger = new WebSocket(APP.replace('http', 'ws') + '/ws?workspace=ws_acme');
check('socket without a session refused', await new Promise((r) => { stranger.onopen = () => r(false); stranger.onerror = () => r(true); setTimeout(() => r(true), 2000); }));

console.log('\n# API rate limit (shared in Redis)');
const statuses = [];
for (let i = 0; i < 35; i++) statuses.push((await api(asha, 'POST', `/api/conversations/${C}/reopen?workspace=ws_acme`)).status);
check('more than 30 writes in 10 s -> 429', statuses.includes(429) && statuses.slice(0, 25).every((s) => s !== 429), statuses.filter((s) => s === 429).length + ' x 429');

console.log(failed ? `\n${failed} check(s) failed` : '\nall workflow checks passed');
process.exit(failed ? 1 : 0);
