import express, { Router } from 'express';
import { config } from '../config.js';
import { handle, sendError } from '../lib/http.js';
import { verifyPigeonSignature } from '../lib/signature.js';
import { isKnownWorkspace } from '../lib/store.js';
import { applyStatus, storeInboundMessage } from '../lib/inbound.js';

export const webhookRouter = Router();

const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

// Answers follow PIGEON.md "How your endpoint must answer".
// We answer 2xx only after the event is safely stored, so Pigeon's retries cover any failure.
webhookRouter.post(
  '/webhooks/pigeon',
  // the signature is over the exact bytes, so this route reads the raw body
  express.raw({ type: '*/*', limit: '256kb' }),
  handle(async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const check = verifyPigeonSignature(raw, req.header('x-pigeon-signature'), config.pigeon.webhookSecret);
    if (check !== 'ok') return sendError(res, 401, check === 'stale' ? 'signature too old' : 'invalid signature');

    let event: any;
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      return sendError(res, 400, 'body is not JSON');
    }
    if (!event || typeof event !== 'object') return sendError(res, 400, 'body is not an object');

    // unknown workspace or event type: acknowledge and ignore, otherwise Pigeon retries forever
    if (!isKnownWorkspace(event.workspace)) return res.status(200).json({ ok: true, ignored: 'workspace' });
    const data = event.data || {};

    if (event.type === 'message.inbound') {
      const occurredAt = new Date(event.occurred_at);
      if (!isText(data.message_id) || !isText(data.from) || isNaN(occurredAt.getTime())) return sendError(res, 400, 'missing fields');
      await storeInboundMessage(event.workspace, data.message_id, data.from, String(data.text ?? ''), occurredAt);
      return res.status(200).json({ ok: true });
    }

    if (event.type === 'message.status') {
      // a status we cannot match to one of our replies is "a status for a message you never sent": 2xx, ignore
      if (!isText(data.client_ref) || !isText(data.status)) return res.status(200).json({ ok: true, ignored: 'status' });
      await applyStatus(event.workspace, data.client_ref, data.status);
      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true, ignored: 'type' });
  }),
);
