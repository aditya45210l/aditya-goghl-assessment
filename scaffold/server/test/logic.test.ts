// Tests for the pieces most likely to be wrong. Run: npm --prefix scaffold/server test
// The claim test uses the real MongoDB from docker compose, in a separate test database.
process.env.MONGO_URL = (process.env.MONGO_URL ?? 'mongodb://localhost:27017/switchboard').replace(/\/[^/]*$/, '/switchboard_test');

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyPigeonSignature } from '../src/lib/signature.js';
import { readSessionId } from '../src/lib/auth.js';
import { claimConversation, setConversationState } from '../src/lib/conversations.js';
import { collections, ensureIndexes, touchConversation } from '../src/lib/store.js';
import { getDb } from '../src/db.js';
import { getRedis } from '../src/redis.js';

const SECRET = 'whsec_test';
const sign = (body: string, t: number, secret = SECRET) => `t=${t},v1=${createHmac('sha256', secret).update(t + '.' + body).digest('hex')}`;
const now = () => Math.floor(Date.now() / 1000);

test('signature: genuine, forged, stale, malformed', () => {
  const body = Buffer.from('{"id":"evt_1"}');
  assert.equal(verifyPigeonSignature(body, sign(body.toString(), now()), SECRET), 'ok');
  assert.equal(verifyPigeonSignature(body, sign(body.toString(), now(), 'wrong'), SECRET), 'bad');
  assert.equal(verifyPigeonSignature(Buffer.from('{"id":"evt_2"}'), sign(body.toString(), now()), SECRET), 'bad'); // body changed
  assert.equal(verifyPigeonSignature(body, sign(body.toString(), now() - 3600), SECRET), 'stale');
  assert.equal(verifyPigeonSignature(body, sign(body.toString(), now() - 240), SECRET), 'ok'); // slow network is fine
  assert.equal(verifyPigeonSignature(body, undefined, SECRET), 'bad');
  assert.equal(verifyPigeonSignature(body, 'garbage', SECRET), 'bad');
});

test('session cookie is read from a cookie header with several cookies', () => {
  assert.equal(readSessionId('a=1; sid=abc-123; b=2'), 'abc-123');
  assert.equal(readSessionId('a=1'), null);
  assert.equal(readSessionId(undefined), null);
});

test('claim: six agents at the same instant, exactly one winner; holder may claim again', async () => {
  await ensureIndexes();
  const { conversations } = await collections();
  await conversations.deleteMany({});
  const results = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => claimConversation('ws_test', '+100', 'agent_' + i)));
  assert.equal(results.filter(Boolean).length, 1);
  const winner = 'agent_' + (results.indexOf(true) + 1);
  assert.equal(await claimConversation('ws_test', '+100', winner), true);
  assert.equal(await claimConversation('ws_test', '+100', 'someone_else'), false);
  assert.equal((await conversations.findOne({ workspace: 'ws_test', contact: '+100' }))?.assignee, winner);
});

test('claim: same agent double-clicks a brand-new contact, both succeed', async () => {
  const results = await Promise.all([claimConversation('ws_test', '+200', 'agent_a'), claimConversation('ws_test', '+200', 'agent_a')]);
  assert.deepEqual(results, [true, true]);
});

test('claim: racing the first customer message never gives a false 409', async () => {
  const now = new Date();
  for (let i = 0; i < 20; i++) {
    const contact = '+3' + i;
    const [won] = await Promise.all([claimConversation('ws_test', contact, 'agent_a'), touchConversation('ws_test', contact, now)]);
    assert.equal(won, true, 'claim on ' + contact);
  }
});

test('close/reopen: holder or admin only; missing conversation reported', async () => {
  await claimConversation('ws_test', '+400', 'agent_a');
  assert.equal(await setConversationState('ws_test', '+400', 'closed', 'agent_b', false), 'forbidden');
  assert.equal(await setConversationState('ws_test', '+400', 'closed', 'agent_a', false), 'ok');
  assert.equal(await setConversationState('ws_test', '+400', 'open', 'admin_x', true), 'ok');
  assert.equal(await setConversationState('ws_test', '+999', 'closed', 'agent_a', false), 'missing');
});

after(async () => {
  await (await getDb()).dropDatabase();
  getRedis().disconnect();
  process.exit(0); // close the lazily opened Mongo client
});
