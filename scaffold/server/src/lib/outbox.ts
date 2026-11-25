import { randomUUID } from 'node:crypto';
import type { Document } from 'mongodb';
import { collections, isDup, touchConversation } from './store.js';
import { emitSafely } from './events.js';
import { sendToPigeon } from './pigeon.js';
import { reserveSendSlot, startCoolOff } from './pacer.js';
import { LEASE_MS, RETRY_BACKOFF_MS, STATUS_RANK, WORKER_IDLE_MS } from './constants.js';

// An outbound message is also its own send job (the `send` field), so one insert
// stores both. There is no moment where a reply exists without its job, or the reverse.

// Store a reply to be sent. Same client_ref twice (even at the same instant) = one reply.
// Returns once it is safely stored; the worker sends it later.
export async function enqueueReply(workspace: string, contact: string, text: string, clientRef: string) {
  const { messages } = await collections();
  const now = new Date();
  try {
    await messages.insertOne({
      workspace, dir: 'out', key: clientRef, contact, text, occurredAt: now, createdAt: now,
      status: 'queued', rank: STATUS_RANK.queued,
      send: { state: 'pending', nextAt: now, attempts: 0, leaseUntil: null, owner: null },
    });
  } catch (err) {
    if (isDup(err)) return; // already queued
    throw err;
  }
  await touchConversation(workspace, contact, now);
  await emitSafely(workspace, { type: 'message.status', contact, client_ref: clientRef, status: 'queued' });
  wakeWorker();
}

// ---------------------------------------------------------------- worker
const workerId = randomUUID(); // identifies this instance's leases
let wake: (() => void) | null = null;
const sleep = (ms: number) => new Promise<void>((r) => { wake = r; setTimeout(r, ms); });
function wakeWorker() { wake?.(); }

// Take one due job and lease it to this instance. If an instance dies mid-send,
// its lease runs out and another instance takes the job over.
async function leaseNextJob(): Promise<Document | null> {
  const { messages } = await collections();
  const now = new Date();
  return messages.findOneAndUpdate(
    {
      dir: 'out',
      'send.state': { $in: ['pending', 'inflight'] },
      'send.nextAt': { $lte: now },
      $or: [{ 'send.leaseUntil': null }, { 'send.leaseUntil': { $lt: now } }],
    },
    { $set: { 'send.state': 'inflight', 'send.leaseUntil': new Date(now.getTime() + LEASE_MS), 'send.owner': workerId } },
    { sort: { 'send.nextAt': 1 } },
  );
}

// Put the job back to be tried again after `delayMs`.
async function retryLater(job: Document, delayMs: number, countAttempt: boolean) {
  const { messages } = await collections();
  await messages.updateOne(
    { _id: job._id, 'send.owner': workerId },
    {
      $set: { 'send.state': 'pending', 'send.nextAt': new Date(Date.now() + delayMs), 'send.leaseUntil': null },
      $inc: { 'send.attempts': countAttempt ? 1 : 0 },
    },
  );
}

async function finish(job: Document, fields: Record<string, unknown>) {
  const { messages } = await collections();
  await messages.updateOne({ _id: job._id }, { $set: { 'send.leaseUntil': null, ...fields } });
}

async function processJob(job: Document) {
  // 1. wait our turn: shared per-workspace pacing and Retry-After
  const waitMs = await reserveSendSlot(job.workspace);
  if (waitMs > 0) return retryLater(job, waitMs, false);

  // 2. send; the status itself (sent/delivered/failed) arrives later by webhook
  const result = await sendToPigeon(job.workspace, job.contact, job.text, job.key);

  if (result.kind === 'accepted') return finish(job, { 'send.state': 'done', 'send.pigeonId': result.pigeonId });
  if (result.kind === 'rate_limited') {
    await startCoolOff(job.workspace, result.retryAfterMs);
    return retryLater(job, result.retryAfterMs + 150, false);
  }
  if (result.kind === 'retry') {
    const attempts = job.send.attempts ?? 0;
    const base = RETRY_BACKOFF_MS[Math.min(attempts, RETRY_BACKOFF_MS.length - 1)];
    return retryLater(job, base + Math.random() * base, true); // backoff with jitter
  }
  // rejected: Pigeon will never take it. Mark the reply failed so the agent sees it.
  const { messages } = await collections();
  await finish(job, { 'send.state': 'failed' });
  const updated = await messages.updateOne(
    { _id: job._id, rank: { $lt: STATUS_RANK.failed } },
    { $set: { status: 'failed', rank: STATUS_RANK.failed } },
  );
  if (updated.modifiedCount) await emitSafely(job.workspace, { type: 'message.status', contact: job.contact, client_ref: job.key, status: 'failed' });
}

// A few loops per instance, so one slow send (up to the timeout) does not hold up the others.
export function startOutboxWorker(loops = 4) {
  for (let i = 0; i < loops; i++) {
    (async () => {
      for (;;) {
        try {
          const job = await leaseNextJob();
          if (!job) await sleep(WORKER_IDLE_MS);
          else await processJob(job);
        } catch (err) {
          console.error('outbox worker error:', (err as Error).message);
          await sleep(1000);
        }
      }
    })();
  }
}
