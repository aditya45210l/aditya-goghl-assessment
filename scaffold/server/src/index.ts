import { createServer } from 'node:http';
import { config } from './config.js';
import { getDb } from './db.js';
import { getRedis } from './redis.js';
import { ensureIndexes } from './lib/store.js';
import { createApp, state } from './app.js';
import { startOutboxWorker, stopOutboxWorker } from './lib/outbox.js';
import { attachWebSocket, startLiveFanout } from './lib/ws.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Wait for MongoDB and Redis instead of crashing: they may start after us.
async function connectWithRetry() {
  for (let attempt = 1; ; attempt++) {
    try {
      await (await getDb()).command({ ping: 1 });
      await getRedis().ping();
      await ensureIndexes();
      return;
    } catch (err) {
      console.error(`storage not ready (attempt ${attempt}):`, (err as Error).message);
      await sleep(Math.min(2000, 200 * attempt));
    }
  }
}

// Last line of defence: log instead of dying on a stray error. Even if the process did die,
// nothing would be lost (all work is in MongoDB with leases), but staying up is better.
process.on('unhandledRejection', (err) => console.error('unhandled rejection:', (err as Error)?.message ?? err));
process.on('uncaughtException', (err) => console.error('uncaught exception:', err.message));

async function main() {
  const server = createServer(createApp());
  attachWebSocket(server);
  // listen first so /healthz can say "not ready yet" (503) instead of refusing connections.
  // If the port cannot be used (e.g. already taken), exit: a process that cannot serve is useless.
  server.on('error', (err) => {
    console.error('server error:', err.message);
    process.exit(1);
  });
  server.listen(config.port, () => console.log(`server on http://localhost:${config.port}`));

  await connectWithRetry();
  startLiveFanout(); // before "ready", so no socket connects before live frames flow
  state.ready = true;
  startOutboxWorker(); // also picks up replies left unsent by an instance that died
  console.log('ready');

  // graceful stop on SIGTERM / Ctrl+C. A kill -9 skips this, which is why all state is in MongoDB/Redis.
  const stop = () => {
    state.ready = false; // load balancer stops sending us traffic
    stopOutboxWorker(); // stop claiming new send jobs
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main();
