import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { getRedis } from '../redis.js';
import { getSession, roleIn } from './auth.js';
import { collections } from './store.js';

type Frame = { seq: number; [field: string]: unknown };
type Client = { socket: WebSocket; workspace: string; lastSent: number; chain: Promise<void> };

const clients = new Set<Client>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Frames must reach each client in strictly increasing seq order, with nothing missing.
// Frames made by other instances come through Redis and may arrive out of order, so:
//   - a frame at or below lastSent was already sent: skip it
//   - a frame further ahead than lastSent + 1 means we missed some: read them from MongoDB first
// Each client has its own promise chain, so its frames are handled one at a time.
function queue(client: Client, task: () => Promise<void>) {
  client.chain = client.chain.then(task).catch((err) => console.error('ws send failed:', err.message));
}

function send(client: Client, frame: Frame) {
  if (frame.seq <= client.lastSent || client.socket.readyState !== client.socket.OPEN) return;
  client.socket.send(JSON.stringify(frame));
  client.lastSent = frame.seq;
}

// Send every stored frame after lastSent (up to `upTo`, if given), in order.
async function sendStored(client: Client, upTo?: number) {
  const { events } = await collections();
  const seq: Record<string, number> = { $gt: client.lastSent };
  if (upTo !== undefined) seq.$lt = upTo;
  const missed = await events.find({ workspace: client.workspace, seq }).sort({ seq: 1 }).toArray();
  for (const e of missed) send(client, e.frame as Frame);
}

async function deliverLive(client: Client, frame: Frame) {
  if (frame.seq <= client.lastSent) return;
  if (frame.seq > client.lastSent + 1) {
    await sendStored(client, frame.seq);
    // the missing frame may still be on its way into MongoDB: give it a moment, once
    if (frame.seq > client.lastSent + 1) {
      await sleep(300);
      await sendStored(client, frame.seq);
    }
  }
  send(client, frame);
}

// Start point for a new socket: ?after=N replays everything after N; without it, live only.
async function startClient(client: Client, after: number | null) {
  if (after !== null) {
    client.lastSent = after;
    await sendStored(client);
  } else {
    const { counters } = await collections();
    const counter = await counters.findOne({ _id: client.workspace as never });
    client.lastSent = (counter?.seq as number) ?? 0;
  }
}

function refuse(socket: Duplex, status: number, text: string) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function attachWebSocket(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  // Only signed-in members of the workspace may connect.
  server.on('upgrade', async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ws') return refuse(socket, 404, 'Not Found');
      const workspace = url.searchParams.get('workspace') ?? '';
      const afterParam = url.searchParams.get('after');
      const after = afterParam !== null && /^\d+$/.test(afterParam) ? Number(afterParam) : null;

      const session = await getSession(req);
      if (!session) return refuse(socket, 401, 'Unauthorized');
      if (!roleIn(session, workspace)) return refuse(socket, 403, 'Forbidden');

      wss.handleUpgrade(req, socket, head, (ws) => {
        const client: Client = { socket: ws, workspace, lastSent: Number.MAX_SAFE_INTEGER, chain: Promise.resolve() };
        // register first, so frames published while we replay are queued, not lost
        clients.add(client);
        queue(client, () => startClient(client, after));
        ws.on('close', () => clients.delete(client));
        ws.on('error', () => clients.delete(client));
      });
    } catch (err) {
      console.error('ws upgrade failed:', (err as Error).message);
      refuse(socket, 500, 'Internal Server Error');
    }
  });

  // One Redis subscription per instance; frames go to this instance's sockets of that workspace.
  const subscriber = getRedis().duplicate();
  subscriber.psubscribe('ev:*').catch((err) => console.error('redis subscribe failed:', err.message));
  subscriber.on('pmessage', (_pattern: string, channel: string, message: string) => {
    const workspace = channel.slice('ev:'.length);
    const frame = JSON.parse(message) as Frame;
    for (const client of clients) {
      if (client.workspace === workspace) queue(client, () => deliverLive(client, frame));
    }
  });
}
