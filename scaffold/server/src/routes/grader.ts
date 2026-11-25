import { Router, type NextFunction, type Request, type Response } from 'express';
import { config } from '../config.js';
import { handle, safeEqual, sendError } from '../lib/http.js';
import { collections, deleteAllData } from '../lib/store.js';

export const graderRouter = Router();

// Every /__grader route needs the x-grader-token header.
graderRouter.use('/__grader', (req: Request, res: Response, next: NextFunction) => {
  const token = req.header('x-grader-token') || '';
  if (!safeEqual(token, config.graderToken)) return sendError(res, 401, 'bad grader token');
  next();
});

graderRouter.post(
  '/__grader/reset',
  handle(async (_req, res) => {
    await deleteAllData();
    res.status(200).json({ ok: true });
  }),
);

// What the system currently believes, in the shape BRIEF.md asks for.
graderRouter.get(
  '/__grader/snapshot',
  handle(async (_req, res) => {
    const c = await collections();
    const workspaces: Record<string, { contacts: Record<string, any>; outbound: Record<string, string> }> = {};
    const wsOf = (id: string) => (workspaces[id] ??= { contacts: {}, outbound: {} });
    const contactOf = (ws: string, contact: string) => (wsOf(ws).contacts[contact] ??= { inbound: [], assignee: null });

    for (const conv of await c.conversations.find().toArray()) {
      contactOf(conv.workspace, conv.contact).assignee = conv.assignee ?? null;
    }
    // same order as the UI shows a conversation: oldest first by occurred_at
    const inbound = await c.messages.find({ dir: 'in' }).sort({ occurredAt: 1, key: 1 }).toArray();
    for (const m of inbound) contactOf(m.workspace, m.contact).inbound.push(m.key);

    for (const m of await c.messages.find({ dir: 'out' }).toArray()) {
      contactOf(m.workspace, m.contact);
      wsOf(m.workspace).outbound[m.key] = m.status;
    }
    res.status(200).json({ workspaces });
  }),
);
