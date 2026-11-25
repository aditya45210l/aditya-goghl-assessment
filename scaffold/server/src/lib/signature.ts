import { createHmac } from 'node:crypto';
import { safeEqual } from './http.js';
import { WEBHOOK_MAX_AGE_SECONDS } from './constants.js';

// Header format: "t=<unix seconds>,v1=<hex>", v1 = HMAC-SHA256("<t>.<raw body>", secret).
// Returns 'ok', 'bad' (missing, malformed or wrong) or 'stale' (more than five minutes away from now).
export function verifyPigeonSignature(rawBody: Buffer, header: string | undefined, secret: string): 'ok' | 'bad' | 'stale' {
  if (!header) return 'bad';
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=')));
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isInteger(t) || typeof v1 !== 'string' || !/^[0-9a-f]+$/i.test(v1)) return 'bad';

  const expected = createHmac('sha256', secret).update(t + '.').update(rawBody).digest('hex');
  if (!safeEqual(expected, v1.toLowerCase())) return 'bad';

  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - t);
  return ageSeconds > WEBHOOK_MAX_AGE_SECONDS ? 'stale' : 'ok';
}
