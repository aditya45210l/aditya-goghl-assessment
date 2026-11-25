import { getRedis } from '../redis.js';
import { PACE_GAP_MS } from './constants.js';

// Pigeon allows about 4 sends per second per workspace, and after any 429 it punishes
// every request for 2 seconds. All instances share these two Redis keys, so together
// they stay under the limit:
//   cool:<ws>  exists while Pigeon told us to wait (Retry-After)
//   pace:<ws>  the earliest time (ms) the next send may start
// The script runs atomically inside Redis and uses Redis' clock, so instances never race.
const RESERVE_SLOT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local cool = redis.call('PTTL', KEYS[1])
if cool > 0 then return cool end
local nextAt = tonumber(redis.call('GET', KEYS[2]) or '0')
if nextAt > now then return nextAt - now end
redis.call('SET', KEYS[2], now + tonumber(ARGV[1]), 'PX', 60000)
return 0
`;

// Returns 0 if we may send now (and takes the slot), or how many ms to wait.
export async function reserveSendSlot(workspace: string): Promise<number> {
  const wait = await getRedis().eval(RESERVE_SLOT, 2, 'cool:' + workspace, 'pace:' + workspace, PACE_GAP_MS);
  return Number(wait);
}

// Pigeon said 429: make every instance wait out the Retry-After (plus a small margin).
export async function startCoolOff(workspace: string, ms: number) {
  await getRedis().set('cool:' + workspace, '1', 'PX', ms + 150);
}
