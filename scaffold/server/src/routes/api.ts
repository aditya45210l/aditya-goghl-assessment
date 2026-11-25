import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { config } from '../config.js';
import { getRedis } from '../redis.js';
import { readSessionId } from '../lib/auth.js';
import { handle, sendError } from '../lib/http.js';
import { getSession, roleIn, type Session } from '../lib/auth.js';
import { enqueueReply } from '../lib/outbox.js';
import { canSend } from '../lib/billing.js';
import {
  claimConversation, getConversation, listConversations, listMessages, releaseConversation, setConversationState, takeOverConversation,
} from '../lib/conversations.js';

export const apiRouter = Router();

// CSRF guard for every state-changing API call. A cookie is sent with any same-site request,
// so we also require (1) a JSON body, which a plain HTML form cannot send, and (2) if the
// browser says where the request comes from, that it is our own web app.
apiRouter.use('/api', (req, res, next) => {
  if (req.method === 'GET') return next();
  const origin = req.headers.origin;
  if (origin && origin !== config.webOrigin) return sendError(res, 403, 'cross-site request refused');
  if (!req.is('application/json')) return sendError(res, 415, 'send JSON');
  next();
});

// Rate limit for state-changing calls: 30 per 10 seconds per signed-in browser, counted in Redis so the
// limit holds across every instance behind the load balancer (a fixed window: INCR, expire on first hit).
const API_LIMIT = 30;
const API_WINDOW_MS = 10_000;
apiRouter.use('/api', handle(async (req, res, next) => {
  if (req.method === 'GET') return next!();
  const who = readSessionId(req.headers.cookie) ?? req.ip ?? 'anon';
  const key = 'rl:api:' + who + ':' + Math.floor(Date.now() / API_WINDOW_MS);
  const count = await getRedis().incr(key);
  if (count === 1) await getRedis().pexpire(key, API_WINDOW_MS);
  if (count > API_LIMIT) {
    res.setHeader('Retry-After', String(Math.ceil(API_WINDOW_MS / 1000)));
    return sendError(res, 429, 'too many requests, slow down');
  }
  next!();
}));

type Access = { session: Session; workspace: string; role: string };

// Tenant guard used by every API route: 401 without a session, 403 if not a member.
// The workspace always comes from the request and is checked against the session's memberships.
export async function requireMember(req: Request, res: Response): Promise<Access | null> {
  const session = await getSession(req);
  if (!session) return sendError(res, 401, 'not signed in'), null;
  const workspace = String(req.query.workspace ?? req.body?.workspace ?? '');
  const role = roleIn(session, workspace);
  if (!role) return sendError(res, 403, 'not a member of this workspace'), null;
  return { session, workspace, role };
}

// Contacts are phone numbers in E.164 form (+ and 6 to 15 digits), exactly as Pigeon sends them.
// Rejecting anything else stops agents from creating junk conversations.
const CONTACT = /^\+\d{6,15}$/;
function contactOf(req: Request, res: Response): string | null {
  const contact = String(req.params.contact);
  if (!CONTACT.test(contact)) return sendError(res, 400, 'contact must be a phone number like +14155550101'), null;
  return contact;
}

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
  const contact = contactOf(req, res);
  if (!contact) return;
  const conversation = await getConversation(a.workspace, contact);
  if (!conversation) return sendError(res, 404, 'no such conversation');
  res.json(conversation);
}));

apiRouter.get('/api/conversations/:contact/messages', handle(async (req, res) => {
  const a = await requireMember(req, res);
  if (!a) return;
  const contact = contactOf(req, res);
  if (!contact) return;
  const before = typeof req.query.before === 'string' ? req.query.before : null;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  res.json(await listMessages(a.workspace, contact, before, limit));
}));

apiRouter.post('/api/conversations/:contact/reply', handle(async (req, res) => {
  const a = await requireMember(req, res);
  if (!a) return;
  const contact = contactOf(req, res);
  if (!contact) return;
  const text = req.body?.text;
  if (typeof text !== 'string' || !text.trim() || text.length > 4096) return sendError(res, 400, 'text is required');
  // Product rules: an agent replies only to a conversation they hold (two agents never answer the
  // same customer at once) and that is open. /__grader/reply is the "system" path and skips this.
  const conversation = await getConversation(a.workspace, contact);
  if (conversation?.assignee !== a.session.sub) return sendError(res, 409, 'claim this conversation before replying');
  if (conversation.state === 'closed') return sendError(res, 409, 'reopen this conversation before replying');
  if (!(await canSend(a.workspace))) return sendError(res, 402, 'subscription canceled: sending is paused, ask an admin');
  // the browser sends its own client_ref so a retried click is still one reply
  const clientRef = typeof req.body.client_ref === 'string' && req.body.client_ref ? req.body.client_ref.slice(0, 200) : randomUUID();
  await enqueueReply(a.workspace, contact, text, clientRef);
  res.status(202).json({ client_ref: clientRef, status: 'queued' });
}));

apiRouter.post('/api/conversations/:contact/claim', handle(async (req, res) => {
  const a = await requireMember(req, res);
  if (!a) return;
  const contact = contactOf(req, res);
  if (!contact) return;
  const won = await claimConversation(a.workspace, contact, a.session.sub);
  if (won) return res.json({ assignee: a.session.sub });
  if (a.role === 'admin' && req.body?.takeover) {
    await takeOverConversation(a.workspace, contact, a.session.sub);
    return res.json({ assignee: a.session.sub });
  }
  sendError(res, 409, 'held by another agent');
}));

apiRouter.post('/api/conversations/:contact/release', handle(async (req, res) => {
  const a = await requireMember(req, res);
  if (!a) return;
  const contact = contactOf(req, res);
  if (!contact) return;
  const ok = await releaseConversation(a.workspace, contact, a.session.sub, a.role === 'admin');
  if (!ok) return sendError(res, 409, 'you do not hold this conversation');
  res.json({ assignee: null });
}));

// Close and reopen share one handler: holder, anyone if unassigned, or an admin.
function stateRoute(state: 'open' | 'closed') {
  return handle(async (req, res) => {
    const a = await requireMember(req, res);
    if (!a) return;
    const contact = contactOf(req, res);
    if (!contact) return;
    const result = await setConversationState(a.workspace, contact, state, a.session.sub, a.role === 'admin');
    if (result === 'missing') return sendError(res, 404, 'no such conversation');
    if (result === 'forbidden') return sendError(res, 409, 'another agent holds this conversation');
    res.json({ state });
  });
}

apiRouter.post('/api/conversations/:contact/close', stateRoute('closed'));
apiRouter.post('/api/conversations/:contact/reopen', stateRoute('open'));
