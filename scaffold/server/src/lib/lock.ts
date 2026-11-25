import { randomUUID } from 'node:crypto';
import { getRedis } from '../redis.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Release only if we still own the lock (it may have expired and been taken by someone else).
const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;

// Run fn while holding a Redis lock shared by all instances. Waits up to waitMs for it.
// The lock expires on its own (ttlMs), so a killed instance cannot hold it forever.
export async function withLock<T>(name: string, fn: () => Promise<T>, ttlMs = 20000, waitMs = 20000): Promise<T> {
  const key = 'lock:' + name;
  const token = randomUUID();
  const deadline = Date.now() + waitMs;
  while ((await getRedis().set(key, token, 'PX', ttlMs, 'NX')) !== 'OK') {
    if (Date.now() > deadline) throw new Error('busy: ' + name);
    await sleep(100);
  }
  try {
    return await fn();
  } finally {
    await getRedis().eval(RELEASE, 1, key, token).catch(() => {});
  }
}
