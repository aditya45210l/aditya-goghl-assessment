import { collections, isDup, touchConversation } from './store.js';
import { emitSafely } from './events.js';
import { STATUS_RANK } from './constants.js';

// Store a message a customer sent. Safe to call any number of times for the same message.
export async function storeInboundMessage(workspace: string, messageId: string, contact: string, text: string, occurredAt: Date) {
  const { messages } = await collections();
  let isNew = true;
  try {
    await messages.insertOne({ workspace, dir: 'in', key: messageId, contact, text, occurredAt, createdAt: new Date() });
  } catch (err) {
    if (!isDup(err)) throw err;
    isNew = false; // already stored by an earlier delivery (or another instance)
  }
  // Always (re)touch the conversation: if we were killed right after the insert last time,
  // the retry repairs it. It is idempotent ($max), so doing it twice is harmless.
  await touchConversation(workspace, contact, occurredAt);
  if (isNew) await emitSafely(workspace, { type: 'message.inbound', contact, message_id: messageId });
}

// Apply a delivery status from Pigeon to a reply we sent.
// The rank filter means a late "sent" never overwrites "delivered", and duplicates change nothing.
export async function applyStatus(workspace: string, clientRef: string, status: string) {
  const rank = STATUS_RANK[status];
  if (rank === undefined) return; // a status we do not know: ignore
  const { messages } = await collections();
  const msg = await messages.findOneAndUpdate(
    { workspace, dir: 'out', key: clientRef, rank: { $lt: rank } },
    { $set: { status, rank, statusAt: new Date() } },
  );
  if (!msg) return; // unknown client_ref, or not newer than what we have
  await emitSafely(workspace, { type: 'message.status', contact: msg.contact, client_ref: clientRef, status });
}
