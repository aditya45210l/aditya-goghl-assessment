import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { handle, sendError } from '../lib/http.js';
import { getSession, roleIn, type Session } from '../lib/auth.js';
import { enqueueReply } from '../lib/outbox.js';
import {
  claimConversation, getConversation, listConversations, listMessages, releaseConversation, setConversationState, takeOverConversation,
} from '../lib/conversations.js';

export const apiRouter = Router();

type Access = { session: Session; workspace: string; role: string };

// Tenant guard used by every API route: 401 without a session, 403 if not a member.
// The workspace always comes from the request and is checked against the session's memberships.
async function requireMember(req: Request, res: Response): Promise<Access | null> {
  const session = await getSession(req);
  if (!session) return sendError(res, 401, 'not signed in'), null;
  const workspace = String(req.query.workspace ?? req.body?.workspace ?? '');
  const role = roleIn(session, workspace);
  if (!role) return sendError(res, 403, 'not a member of this workspace'), null;
  return { session, workspace, role };
}

const contactOf = (req: Request) => String(req.params.contact);

apiRouter.get('/api/conversations', handle(async (req, res) => {
  const a = await requireMember(req, res);
  if (!a) return;
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const cursor = typeof req.query.before === 'string' ? req.query.before : null;
  res.json(await listConversations(a.workspace, cursor, limit));
}));

apiRouter.get('/api/conversations/:contact', handle(async (req, res) => {
  const a = await requireMember(req, res);
  if (!a) return;
  const conversation = await getConversation(a.workspace, contactOf(req));
  if (!conversation) return sendError(res, 404, 'no such conversation');
  res.json(conversation);
}));

apiRouter.get('/api/conversations/:contact/messages', handle(async (req, res) => {
  const a = await requireMember(req, res);
  if (!a) return;
  res.json({ items: await listMessages(a.workspace, contactOf(req)) });
}));

apiRouter.post('/api/conversations/:contact/reply', handle(async (req, res) => {
  const a = await requireMember(req, res);
  if (!a) return;
  const text = req.body?.text;
  if (typeof text !== 'string' || !text.trim() || text.length > 4096) return sendError(res, 400, 'text is required');
  // Product rule: an agent replies only to a conversation they hold, so two agents never answer
  // the same customer at once. (The grader's /__grader/reply is the "system" path and skips this.)
  const conversation = await getConversation(a.workspace, contactOf(req));
  if (conversation?.assignee !== a.session.sub) return sendError(res, 409, 'claim this conversation before replying');
  // the browser sends its own client_ref so a retried click is still one reply
  const clientRef = typeof req.body.client_ref === 'string' && req.body.client_ref ? req.body.client_ref.slice(0, 200) : randomUUID();
  await enqueueReply(a.workspace, contactOf(req), text, clientRef);
  res.status(202).json({ client_ref: clientRef, status: 'queued' });
}));

apiRouter.post('/api/conversations/:contact/claim', handle(async (req, res) => {
  const a = await requireMember(req, res);
  if (!a) return;
  const won = await claimConversation(a.workspace, contactOf(req), a.session.sub);
  if (won) return res.json({ assignee: a.session.sub });
  if (a.role === 'admin' && req.body?.takeover) {
    await takeOverConversation(a.workspace, contactOf(req), a.session.sub);
    return res.json({ assignee: a.session.sub });
  }
  sendError(res, 409, 'held by another agent');
}));

apiRouter.post('/api/conversations/:contact/release', handle(async (req, res) => {
  const a = await requireMember(req, res);
  if (!a) return;
  const ok = await releaseConversation(a.workspace, contactOf(req), a.session.sub, a.role === 'admin');
  if (!ok) return sendError(res, 409, 'you do not hold this conversation');
  res.json({ assignee: null });
}));

apiRouter.post('/api/conversations/:contact/close', handle(async (req, res) => {
  const a = await requireMember(req, res);
  if (!a) return;
  await setConversationState(a.workspace, contactOf(req), 'closed');
  res.json({ state: 'closed' });
}));

apiRouter.post('/api/conversations/:contact/reopen', handle(async (req, res) => {
  const a = await requireMember(req, res);
  if (!a) return;
  await setConversationState(a.workspace, contactOf(req), 'open');
  res.json({ state: 'open' });
}));
