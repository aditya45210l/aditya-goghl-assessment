import { config } from '../config.js';
import { SEND_TIMEOUT_MS } from './constants.js';

export type SendResult =
  | { kind: 'accepted'; pigeonId: string }
  | { kind: 'rate_limited'; retryAfterMs: number } // 429: the whole workspace must wait
  | { kind: 'retry' } // 503, timeout, network error: outcome unknown, try again with the same key
  | { kind: 'rejected'; status: number }; // 400/401: retrying will not help

// One send to Pigeon. Idempotency-Key = client_ref, so repeating it can never send twice.
export async function sendToPigeon(workspace: string, to: string, text: string, clientRef: string): Promise<SendResult> {
  try {
    const res = await fetch(config.pigeon.url + '/v1/messages', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + config.pigeon.apiKeys[workspace],
        'content-type': 'application/json',
        'idempotency-key': clientRef,
      },
      body: JSON.stringify({ to, text, client_ref: clientRef }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    if (res.ok) return { kind: 'accepted', pigeonId: body.id ?? '' };
    if (res.status === 429) return { kind: 'rate_limited', retryAfterMs: Number(res.headers.get('retry-after') || 2) * 1000 };
    if (res.status >= 500) return { kind: 'retry' };
    return { kind: 'rejected', status: res.status };
  } catch {
    return { kind: 'retry' }; // timeout or connection error: Pigeon may or may not have it
  }
}
