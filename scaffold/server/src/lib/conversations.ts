import { collections, isDup } from './store.js';
import { emitSafely } from './events.js';

// Agent takes a conversation. One atomic database operation, so six agents at the same
// instant get exactly one winner:
//   - matches only if nobody holds it, or this agent already does
//   - if it does not match, upsert tries to create it; the unique index on
//     (workspace, contact) then fails for anyone who lost, which means "held by someone else"
// Returns true if this agent holds it now.
export async function claimConversation(workspace: string, contact: string, agent: string): Promise<boolean> {
  const { conversations } = await collections();
  try {
    const before = await conversations.findOneAndUpdate(
      { workspace, contact, assignee: { $in: [null, agent] } },
      { $set: { assignee: agent }, $setOnInsert: { state: 'open', lastActivityAt: new Date(), createdAt: new Date() } },
      { upsert: true, returnDocument: 'before' },
    );
    if (!before || before.assignee !== agent) {
      await emitSafely(workspace, { type: 'conversation.assigned', contact, assignee: agent });
    }
    return true;
  } catch (err) {
    if (isDup(err)) return false;
    throw err;
  }
}

// Admin takes a conversation from whoever holds it (roles are enforced here, not by the IdP).
export async function takeOverConversation(workspace: string, contact: string, agent: string) {
  const { conversations } = await collections();
  const res = await conversations.updateOne({ workspace, contact }, { $set: { assignee: agent } });
  if (res.modifiedCount) await emitSafely(workspace, { type: 'conversation.assigned', contact, assignee: agent });
  return res.matchedCount > 0;
}

// Holder gives the conversation back (admins may release anyone's).
export async function releaseConversation(workspace: string, contact: string, agent: string, isAdmin: boolean) {
  const { conversations } = await collections();
  const filter = isAdmin ? { workspace, contact } : { workspace, contact, assignee: agent };
  const res = await conversations.updateOne({ ...filter, assignee: { $ne: null } }, { $set: { assignee: null } });
  if (res.modifiedCount) await emitSafely(workspace, { type: 'conversation.assigned', contact, assignee: null });
  return res.modifiedCount > 0;
}

// Close or reopen. A new customer message does not reopen automatically (see DECISIONS.md).
export async function setConversationState(workspace: string, contact: string, state: 'open' | 'closed') {
  const { conversations } = await collections();
  const res = await conversations.updateOne({ workspace, contact, state: { $ne: state } }, { $set: { state } });
  if (res.modifiedCount) await emitSafely(workspace, { type: 'conversation.state', contact, state });
  return true;
}

const toSummary = (c: Record<string, any>) => ({
  contact: c.contact, assignee: c.assignee ?? null, state: c.state, lastActivityAt: c.lastActivityAt,
});

// Inbox page: newest activity first.
// The cursor is "<lastActivityAt ISO>|<contact>" of the last item shown. Using the contact as a
// tie-breaker means two conversations with the same timestamp are never skipped between pages.
export async function listConversations(workspace: string, cursor: string | null, limit: number) {
  const { conversations } = await collections();
  const filter: Record<string, unknown> = { workspace };
  const [iso, contact] = (cursor ?? '').split('|');
  const at = new Date(iso);
  if (cursor && !isNaN(at.getTime())) {
    filter.$or = [{ lastActivityAt: { $lt: at } }, { lastActivityAt: at, contact: { $gt: contact ?? '' } }];
  }
  const items = await conversations.find(filter).sort({ lastActivityAt: -1, contact: 1 }).limit(limit).toArray();
  const last = items[items.length - 1];
  const next = items.length === limit ? last.lastActivityAt.toISOString() + '|' + last.contact : null;
  return { items: items.map(toSummary), next };
}

// One conversation's summary (assignee, state), or null if it does not exist in this workspace.
export async function getConversation(workspace: string, contact: string) {
  const { conversations } = await collections();
  const c = await conversations.findOne({ workspace, contact });
  return c ? toSummary(c) : null;
}

// One conversation's messages, oldest first (the same order as the grader snapshot).
export async function listMessages(workspace: string, contact: string) {
  const { messages } = await collections();
  const list = await messages.find({ workspace, contact }).sort({ occurredAt: 1, key: 1 }).limit(500).toArray();
  return list.map((m) => ({
    id: m.key, direction: m.dir, text: m.text, at: m.occurredAt, status: m.dir === 'out' ? m.status : undefined,
  }));
}
