import { Router } from 'express';
import { config } from '../config.js';
import { handle, sendError } from '../lib/http.js';
import { requireMember } from './api.js';
import { billingState, cancelAtPeriodEnd, changeSeats, subscribeWorkspace } from '../lib/billing.js';

// Admin-only billing API for our UI. (The CSRF guard in api.ts covers every POST under /api.)
export const billingRouter = Router();

// Members may know whether sending is paused; only admins see and change billing details.
billingRouter.get('/api/billing', handle(async (req, res) => {
  const a = await requireMember(req, res);
  if (!a) return;
  const state = await billingState(a.workspace);
  if (a.role !== 'admin') return res.json({ can_send: state.can_send, status: state.status === 'canceled' ? 'canceled' : 'ok' });
  // the publishable key is meant for browsers: it can only turn a card into a token
  res.json({ ...state, paybox: { url: config.paybox.url, publishableKey: config.paybox.publishableKey }, price_per_seat_cents: 1200 });
}));

const isSeats = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 1000;

billingRouter.post('/api/billing/subscribe', handle(async (req, res) => {
  const a = await requireMember(req, res);
  if (!a) return;
  if (a.role !== 'admin') return sendError(res, 403, 'only admins can manage billing');
  // the card must never reach this server: refuse anything that looks like card details
  if (req.body?.card || req.body?.number) return sendError(res, 400, 'send a Paybox token, not card details');
  const { seats, token } = req.body ?? {};
  if (!isSeats(seats) || typeof token !== 'string' || !token.startsWith('tok_')) return sendError(res, 400, 'seats and a card token are required');
  const out = await subscribeWorkspace(a.workspace, seats, token);
  res.status(out.ok ? 200 : 402).json({ ...out, billing: await billingState(a.workspace) });
}));

billingRouter.post('/api/billing/seats', handle(async (req, res) => {
  const a = await requireMember(req, res);
  if (!a) return;
  if (a.role !== 'admin') return sendError(res, 403, 'only admins can manage billing');
  if (!isSeats(req.body?.seats)) return sendError(res, 400, 'seats must be a whole number from 1 to 1000');
  const out = await changeSeats(a.workspace, req.body.seats);
  res.status(out.ok ? 200 : 402).json({ ...out, billing: await billingState(a.workspace) });
}));

billingRouter.post('/api/billing/cancel', handle(async (req, res) => {
  const a = await requireMember(req, res);
  if (!a) return;
  if (a.role !== 'admin') return sendError(res, 403, 'only admins can manage billing');
  const out = await cancelAtPeriodEnd(a.workspace);
  res.status(out.ok ? 200 : 409).json({ ...out, billing: await billingState(a.workspace) });
}));
