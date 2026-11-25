import express, { Router } from 'express';
import { config } from '../config.js';
import { handle, sendError } from '../lib/http.js';
import { verifyPigeonSignature } from '../lib/signature.js';
import { handlePayboxEvent } from '../lib/billing.js';

export const payboxWebhookRouter = Router();

// Paybox signs exactly like Pigeon (t=..,v1=HMAC("<t>.<raw body>")), so the same check is reused.
// Anyone can post here, so a forged "payment succeeded" gets 401 and changes nothing.
payboxWebhookRouter.post(
  '/webhooks/paybox',
  express.raw({ type: '*/*', limit: '256kb' }),
  handle(async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const check = verifyPigeonSignature(raw, req.header('x-paybox-signature'), config.paybox.webhookSecret);
    if (check !== 'ok') return sendError(res, 401, 'invalid signature');
    let event: unknown;
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      return sendError(res, 400, 'body is not JSON');
    }
    try {
      await handlePayboxEvent(event);
    } catch (err) {
      // could not reach Paybox or storage: not stored yet, so ask Paybox to send it again
      console.error('paybox webhook failed:', (err as Error).message);
      return sendError(res, 503, 'try again');
    }
    res.status(200).json({ ok: true });
  }),
);
