import type { Collection, Document } from 'mongodb';
import { getDb } from '../db.js';
import { getRedis } from '../redis.js';
import { config } from '../config.js';

// All application data lives in these collections. Every document carries `workspace`.
export async function collections() {
  const db = await getDb();
  return {
    // inbound and outbound messages; an outbound message is also its own send job
    messages: db.collection('messages') as Collection<Document>,
    // one per (workspace, contact): assignee, open/closed, last activity
    conversations: db.collection('conversations') as Collection<Document>,
    // log of every real-time frame, for WebSocket replay
    events: db.collection('events') as Collection<Document>,
    // one per workspace: the last `seq` handed out
    counters: db.collection('counters') as Collection<Document>,
  };
}

// Unique indexes are what make duplicates harmless: a second insert fails instead of storing twice.
export async function ensureIndexes() {
  const c = await collections();
  await c.messages.createIndex({ workspace: 1, dir: 1, key: 1 }, { unique: true });
  await c.messages.createIndex({ workspace: 1, contact: 1, occurredAt: 1, key: 1 });
  await c.messages.createIndex({ 'send.state': 1, 'send.nextAt': 1 });
  await c.conversations.createIndex({ workspace: 1, contact: 1 }, { unique: true });
  await c.conversations.createIndex({ workspace: 1, lastActivityAt: -1 });
  await c.events.createIndex({ workspace: 1, seq: 1 }, { unique: true });
}

// MongoDB duplicate key error: the thing already exists.
export function isDup(err: unknown): boolean {
  return (err as { code?: number })?.code === 11000;
}

export function isKnownWorkspace(workspace: unknown): workspace is string {
  return typeof workspace === 'string' && Object.hasOwn(config.pigeon.apiKeys, workspace);
}

// Create the conversation if missing and move its last activity forward.
// Two requests can race to create it; the loser gets a duplicate key error and simply retries.
export async function touchConversation(workspace: string, contact: string, at: Date) {
  const { conversations } = await collections();
  const update = {
    $max: { lastActivityAt: at },
    $setOnInsert: { assignee: null, state: 'open', createdAt: new Date() },
  };
  try {
    await conversations.updateOne({ workspace, contact }, update, { upsert: true });
  } catch (err) {
    if (!isDup(err)) throw err;
    await conversations.updateOne({ workspace, contact }, update, { upsert: true });
  }
}

// Wipe application data (grader reset). Login sessions are kept.
export async function deleteAllData() {
  const c = await collections();
  await Promise.all([c.messages.deleteMany({}), c.conversations.deleteMany({}), c.events.deleteMany({}), c.counters.deleteMany({})]);
  const redis = getRedis();
  for (const pattern of ['cool:*', 'pace:*']) {
    const keys = await redis.keys(pattern); // few keys, so KEYS is fine here
    if (keys.length) await redis.del(...keys);
  }
  // If MongoDB lost its data (e.g. the container was recreated), the unique indexes that make
  // duplicates impossible are gone too. Recreate them now, while the collections are empty.
  await ensureIndexes();
}
