// Billing self-test against the Paybox simulator, following what BONUS_BILLING.md says the grader does.
// Needs: services up (npm run up) and the server on :4000 (npm run scaffold:server).
// WARNING: wipes application data and Paybox (dev only).   Run: node scripts/billing-selftest.mjs
const APP = process.env.APP_URL || 'http://localhost:4000';
const PAYBOX = process.env.PAYBOX_URL || 'http://localhost:4030';
const G = { 'content-type': 'application/json', 'x-grader-token': process.env.GRADER_TOKEN || 'grader-dev-token' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (url, body, headers = { 'content-type': 'application/json' }) =>
  fetch(url, { method: 'POST', headers, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const get = (url, headers) => fetch(url, { headers }).then((r) => r.json());
let failed = 0;
const check = (name, ok, detail = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  (' + detail + ')' : '')); if (!ok) failed++; };

// the browser's job: card -> token with the publishable key
const token = async (number) => (await post(PAYBOX + '/v1/tokens', { card: { number, exp_month: 12, exp_year: 2035, cvc: '123' } }, { 'content-type': 'application/json', authorization: 'Bearer pk_test_paybox_9a7b3e' })).body.id;
const billing = async (ws) => (await get(APP + '/__grader/snapshot', G)).workspaces[ws].billing;

await post(APP + '/__grader/reset', {}, G);
await post(PAYBOX + '/__admin/reset', {});
check('free trial before subscribing', JSON.stringify(await billing('ws_acme')) === JSON.stringify({ status: 'none', seats: 0, can_send: true }));

// 1. three subscribes for one workspace in the same instant
const t1 = await token('4242424242424242');
const three = await Promise.all([1, 2, 3].map(() => post(APP + '/__grader/billing/subscribe', { workspace: 'ws_acme', seats: 3, token: t1 }, G)));
check('3 concurrent subscribes all answer 200', three.every((r) => r.status === 200), three.map((r) => r.status).join(','));
let report = await get(PAYBOX + '/__admin/report');
const acme = report.customers.filter((c) => c.workspace === 'ws_acme');
check('exactly one Paybox customer for ws_acme', acme.length === 1, String(acme.length));
check('exactly one subscription for ws_acme', acme.reduce((n, c) => n + c.subscriptions.length, 0) === 1);

// 2. change seats
const seats = await post(APP + '/__grader/billing/seats', { workspace: 'ws_acme', seats: 5 }, G);
check('seats 3 -> 5 answers 200', seats.status === 200, String(seats.status));
check('snapshot shows 5 seats, active', JSON.stringify(await billing('ws_acme')) === JSON.stringify({ status: 'active', seats: 5, can_send: true }));

// 3. a declined card is 402 and not active
const tBad = await token('4000000000000002');
const bad = await post(APP + '/__grader/billing/subscribe', { workspace: 'ws_globex', seats: 2, token: tBad }, G);
check('declined card answers 402', bad.status === 402, String(bad.status));

// 4. second workspace pays with a card that works once, then time passes beyond renewal and retries
const tOnce = await token('4000000000000341');
const once = await post(APP + '/__grader/billing/subscribe', { workspace: 'ws_globex', seats: 2, token: tOnce }, G);
check('ws_globex subscribes with the 0341 card (200)', once.status === 200, String(once.status));
// just past the 30-day renewal (it fails), then past both retries (3 and 2 days later)
await post(PAYBOX + '/v1/test_clock/advance', { hours: 30 * 24 + 1 });
await sleep(3000);
const pd = await billing('ws_globex');
check('after renewal fails: past_due and still can send', pd.status === 'past_due' && pd.can_send === true, JSON.stringify(pd));
await post(PAYBOX + '/v1/test_clock/advance', { hours: 3 * 24 });
await post(PAYBOX + '/v1/test_clock/advance', { hours: 2 * 24 });
await sleep(3000);
const g = await billing('ws_globex');
check('after retries run out: canceled, cannot send', g.status === 'canceled' && g.can_send === false, JSON.stringify(g));
check('paying workspace still active after renewal', (await billing('ws_acme')).status === 'active', JSON.stringify(await billing('ws_acme')));

// 5. canceled cannot send, paying one can
const r1 = await post(APP + '/__grader/reply', { workspace: 'ws_globex', contact: '+442079460201', text: 'hi', client_ref: 'bill_' + Date.now() }, G);
const r2 = await post(APP + '/__grader/reply', { workspace: 'ws_acme', contact: '+14155550101', text: 'hi', client_ref: 'bill_ok_' + Date.now() }, G);
check('reply from canceled workspace is 402', r1.status === 402, String(r1.status));
check('reply from paying workspace is 202', r2.status === 202, String(r2.status));

// 6. forged webhook claiming globex is active
const forge = await post(PAYBOX + '/__admin/forge', { workspace: 'ws_globex' });
check('forged webhook rejected (401)', forge.body.delivered === 401, JSON.stringify(forge.body));
await sleep(1000);
check('state unchanged after forgery', (await billing('ws_globex')).status === 'canceled');

// 7. what Paybox noticed about how we called it
await sleep(1500);
report = await get(PAYBOX + '/__admin/report');
const flags = report.flags || {};
check('no card numbers through our server', (flags.rawCardViaSecretKey ?? 0) === 0, JSON.stringify(flags));
check('no POST without Idempotency-Key', (flags.postsWithoutIdempotencyKey ?? 0) === 0, JSON.stringify(flags));
check('no forged webhook accepted', (report.webhooks?.forgedAccepted ?? 0) === 0, JSON.stringify(report.webhooks));

console.log(failed ? `\n${failed} check(s) failed` : '\nall billing checks passed');
process.exit(failed ? 1 : 0);
