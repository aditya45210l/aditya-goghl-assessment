import { createHash, createPublicKey, randomBytes, verify, type KeyObject } from 'node:crypto';
import type { Request } from 'express';
import { config } from '../config.js';
import { getRedis } from '../redis.js';
import { LOGIN_STATE_TTL_SECONDS, SESSION_TTL_SECONDS } from './constants.js';

export type Membership = { id: string; role: string };
export type Session = { sub: string; name?: string; email?: string; workspaces: Membership[] };

const randomId = () => randomBytes(32).toString('base64url');

// ----------------------------------------------------------- IdP metadata
type Discovery = { authorization_endpoint: string; token_endpoint: string; jwks_uri: string; issuer: string };
let discovery: Discovery | null = null;
async function getDiscovery(): Promise<Discovery> {
  if (!discovery) {
    const res = await fetch(config.oidc.issuer + '/.well-known/openid-configuration', { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error('IdP discovery failed: ' + res.status);
    discovery = (await res.json()) as Discovery;
  }
  return discovery;
}

// The IdP makes a new signing key every time it restarts, so keys are cached by kid
// and the key set is fetched again when an unknown kid shows up.
const keys = new Map<string, KeyObject>();
async function getSigningKey(kid: string): Promise<KeyObject | undefined> {
  if (!keys.has(kid)) {
    const res = await fetch((await getDiscovery()).jwks_uri, { signal: AbortSignal.timeout(5000) });
    const { keys: list } = (await res.json()) as { keys: Array<Record<string, string>> };
    for (const jwk of list) keys.set(jwk.kid, createPublicKey({ key: jwk as never, format: 'jwk' }));
  }
  return keys.get(kid);
}

// Check the ID token's RS256 signature and its claims. Throws if anything is wrong.
async function verifyIdToken(idToken: string, nonce: string): Promise<Record<string, any>> {
  const [h, p, s] = idToken.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  const key = header.alg === 'RS256' ? await getSigningKey(header.kid) : undefined;
  if (!key || !verify('sha256', Buffer.from(h + '.' + p), key, Buffer.from(s, 'base64url'))) throw new Error('bad id_token signature');
  const audOk = Array.isArray(claims.aud) ? claims.aud.includes(config.oidc.clientId) : claims.aud === config.oidc.clientId;
  if (claims.iss !== config.oidc.issuer || !audOk) throw new Error('id_token issuer or audience mismatch');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) throw new Error('id_token expired');
  if (claims.nonce !== nonce) throw new Error('id_token nonce mismatch');
  return claims;
}

// ----------------------------------------------------------- login flow
// Step 1: build the IdP URL. state, nonce and the PKCE verifier are kept in Redis,
// because the callback may land on a different instance.
// The state is also kept in a short cookie on the browser that started the login, and the callback
// requires both to match. Otherwise an attacker could send a victim their own callback link and sign
// the victim into the attacker's account (login CSRF).
export const LOGIN_COOKIE = 'login_state';
export function loginStateCookie(state: string, maxAgeSeconds = LOGIN_STATE_TTL_SECONDS) {
  return `${LOGIN_COOKIE}=${state}; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=${maxAgeSeconds}`;
}
export function readCookie(cookieHeader: string | undefined, name: string): string | null {
  for (const part of (cookieHeader ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=') || null;
  }
  return null;
}

export async function startLogin(): Promise<{ url: string; state: string }> {
  const state = randomId();
  const nonce = randomId();
  const verifier = randomId();
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  await getRedis().set('oidc:' + state, JSON.stringify({ nonce, verifier }), 'EX', LOGIN_STATE_TTL_SECONDS);

  const url = new URL((await getDiscovery()).authorization_endpoint);
  url.search = new URLSearchParams({
    client_id: config.oidc.clientId,
    redirect_uri: config.oidc.redirectUri,
    response_type: 'code',
    scope: 'openid profile email',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  }).toString();
  return { url: url.toString(), state };
}

// Step 2: the browser comes back with ?code&state. Exchange the code (it works once,
// for 60 s), verify the ID token, and create our own session. Returns the session id.
export async function finishLogin(code: string, state: string): Promise<string> {
  const saved = await getRedis().getdel('oidc:' + state); // single use
  if (!saved) throw new Error('unknown or expired login state');
  const { nonce, verifier } = JSON.parse(saved);

  const res = await fetch((await getDiscovery()).token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.oidc.redirectUri,
      code_verifier: verifier,
      client_id: config.oidc.clientId,
      client_secret: config.oidc.clientSecret,
    }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error('token exchange failed: ' + res.status);
  const { id_token } = (await res.json()) as { id_token: string };
  const claims = await verifyIdToken(id_token, nonce);

  const session: Session = {
    sub: claims.sub,
    name: claims.name,
    email: claims.email,
    workspaces: (claims.workspaces ?? []).map((w: Membership) => ({ id: w.id, role: w.role })),
  };
  const sid = randomId();
  await getRedis().set('sess:' + sid, JSON.stringify(session), 'EX', SESSION_TTL_SECONDS);
  return sid;
}

// ----------------------------------------------------------- sessions
export const SESSION_COOKIE = 'sid';

export function sessionCookie(sid: string, maxAgeSeconds = SESSION_TTL_SECONDS) {
  const secure = config.webOrigin.startsWith('https') ? '; Secure' : '';
  return `${SESSION_COOKIE}=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
}

export function readSessionId(cookieHeader: string | undefined): string | null {
  return readCookie(cookieHeader, SESSION_COOKIE);
}

// Session for an HTTP request or a WebSocket upgrade (both carry the cookie header).
export async function getSession(req: Pick<Request, 'headers'>): Promise<Session | null> {
  const sid = readSessionId(req.headers.cookie);
  if (!sid) return null;
  const raw = await getRedis().get('sess:' + sid);
  return raw ? (JSON.parse(raw) as Session) : null;
}

export async function deleteSession(req: Pick<Request, 'headers'>) {
  const sid = readSessionId(req.headers.cookie);
  if (!sid) return;
  await getRedis().del('sess:' + sid);
  await getRedis().publish('sessions:logout', sid); // close this session's live sockets everywhere
}

export function roleIn(session: Session, workspace: string): string | null {
  return session.workspaces.find((w) => w.id === workspace)?.role ?? null;
}
