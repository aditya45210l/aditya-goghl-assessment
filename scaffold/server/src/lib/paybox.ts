import { config } from '../config.js';

// Small client for the Paybox API (server side, secret key).
// Every POST must carry an Idempotency-Key: the same key returns the first answer and does nothing twice,
// so a retry after a timeout can never create a second customer or subscription.
export type PayboxResult = { status: number; data: any };

const PAYBOX_TIMEOUT_MS = 8000; // subscribe charges the card synchronously

export async function paybox(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, idempotencyKey?: string): Promise<PayboxResult> {
  if (method === 'POST' && !idempotencyKey) throw new Error('Paybox POST without an Idempotency-Key: ' + path);
  const res = await fetch(config.paybox.url + path, {
    method,
    headers: {
      authorization: 'Bearer ' + config.paybox.secretKey,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(PAYBOX_TIMEOUT_MS),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

// Human-readable reason from a Paybox error or a failed payment.
export function payboxReason(data: any): string {
  return data?.error?.code ?? data?.latest_invoice?.payment?.error?.code ?? data?.latest_invoice?.payment?.status ?? 'payment_failed';
}
