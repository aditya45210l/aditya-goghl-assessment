import { Router } from 'express';
import { config } from '../config.js';
import { handle, safeEqual, sendError } from '../lib/http.js';
import { deleteSession, finishLogin, getSession, LOGIN_COOKIE, loginStateCookie, readCookie, sessionCookie, startLogin } from '../lib/auth.js';

export const authRouter = Router();

authRouter.get('/auth/login', handle(async (_req, res) => {
  const { url, state } = await startLogin();
  res.setHeader('set-cookie', loginStateCookie(state));
  res.redirect(302, url);
}));

authRouter.get('/auth/callback', handle(async (req, res) => {
  const { code, state } = req.query;
  if (typeof code !== 'string' || typeof state !== 'string') return sendError(res, 400, 'missing code or state');
  // this browser must be the one that started the login
  if (!safeEqual(readCookie(req.headers.cookie, LOGIN_COOKIE) ?? '', state)) return sendError(res, 401, 'login was not started in this browser');
  try {
    const sid = await finishLogin(code, state);
    res.setHeader('set-cookie', [sessionCookie(sid), loginStateCookie('', 0)]);
    res.redirect(302, config.webOrigin + '/');
  } catch (err) {
    console.error('login failed:', (err as Error).message);
    sendError(res, 401, 'login failed, please try again');
  }
}));

authRouter.post('/auth/logout', handle(async (req, res) => {
  await deleteSession(req);
  res.setHeader('set-cookie', sessionCookie('', 0));
  res.status(200).json({ ok: true });
}));

authRouter.get('/api/me', handle(async (req, res) => {
  const session = await getSession(req);
  if (!session) return sendError(res, 401, 'not signed in');
  res.json({ sub: session.sub, name: session.name, workspaces: session.workspaces });
}));
