import { Router, type NextFunction, type Request, type Response } from 'express';
import { config } from '../config.js';
import { handle, safeEqual, sendError } from '../lib/http.js';
import { collections, deleteAllData, isKnownWorkspace } from '../lib/store.js';
import { enqueueReply } from '../lib/outbox.js';
import { claimConversation } from '../lib/conversations.js';

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

const isText = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

// Same code path as an agent replying in the UI.
graderRouter.post(
  '/__grader/reply',
  handle(async (req, res) => {
    const { workspace, contact, text, client_ref } = req.body ?? {};
    if (!isKnownWorkspace(workspace)) return sendError(res, 404, 'unknown workspace');
    if (!isText(contact, 64) || !isText(text) || !isText(client_ref, 200)) return sendError(res, 400, 'contact, text and client_ref are required');
    await enqueueReply(workspace, contact, text, client_ref);
    res.status(202).json({ ok: true, client_ref });
  }),
);

// Same code path as an agent clicking "claim" in the UI.
graderRouter.post(
  '/__grader/claim',
  handle(async (req, res) => {
    const { workspace, contact, agent } = req.body ?? {};
    if (!isKnownWorkspace(workspace)) return sendError(res, 404, 'unknown workspace');
    if (!isText(contact, 64) || !isText(agent, 200)) return sendError(res, 400, 'contact and agent are required');
    const won = await claimConversation(workspace, contact, agent);
    if (!won) return sendError(res, 409, 'held by another agent');
    res.status(200).json({ ok: true, assignee: agent });
  }),
);
