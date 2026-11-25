import { collections } from './store.js';
import { getRedis } from '../redis.js';

export type Frame = { type: string; contact: string; [field: string]: unknown };

export const channelFor = (workspace: string) => 'ev:' + workspace;

// Record a real-time change and tell every instance about it.
// 1. take the next seq for this workspace (atomic $inc, shared by all instances)
// 2. store the frame, so a client that reconnects with ?after=N can get it again
// 3. publish it on Redis, so sockets on every instance receive it live
export async function emit(workspace: string, frame: Frame) {
  const c = await collections();
  const counter = await c.counters.findOneAndUpdate(
    { _id: workspace as never },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  const full = { seq: counter!.seq as number, ...frame };
  await c.events.insertOne({ workspace, seq: full.seq, frame: full, at: new Date() });
  await getRedis().publish(channelFor(workspace), JSON.stringify(full));
}

// Emitting is best effort: the data is already stored, a lost frame must not fail the request.
export async function emitSafely(workspace: string, frame: Frame) {
  try {
    await emit(workspace, frame);
  } catch (err) {
    console.error('emit failed', workspace, frame.type, (err as Error).message);
  }
}
