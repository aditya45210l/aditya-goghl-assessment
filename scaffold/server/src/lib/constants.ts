// Every tuning number lives here, with the reason for its value.

// Pigeon rejects webhooks older than this, and so do we (PIGEON.md).
export const WEBHOOK_MAX_AGE_SECONDS = 300;

// Status of an outbound message only moves forward. delivered and failed are final.
export const STATUS_RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, failed: 2 };

// Sending replies (used from Phase B on).
export const SEND_TIMEOUT_MS = 4000; // Pigeon sometimes answers after 12 s; give up early and retry with the same key
export const LEASE_MS = 10000; // a dead instance's sends are picked up by another one after this
export const PACE_GAP_MS = 275; // < 4 sends per second per workspace, Pigeon's refill rate
export const RETRY_BACKOFF_MS = [300, 600, 1200, 2400, 3000];
export const WORKER_IDLE_MS = 200;

// Sessions and login.
export const SESSION_TTL_SECONDS = 8 * 3600;
export const LOGIN_STATE_TTL_SECONDS = 600;
