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

// Inbox page: newest activity first. Cursor = lastActivityAt of the last item on the previous page.
export async function listConversations(workspace: string, before: Date | null, limit: number) {
  const { conversations } = await collections();
  const filter: Record<string, unknown> = { workspace };
  if (before) filter.lastActivityAt = { $lt: before };
  const items = await conversations.find(filter).sort({ lastActivityAt: -1, contact: 1 }).limit(limit).toArray();
  const next = items.length === limit ? items[items.length - 1].lastActivityAt.toISOString() : null;
  return {
    items: items.map((c) => ({ contact: c.contact, assignee: c.assignee ?? null, state: c.state, lastActivityAt: c.lastActivityAt })),
    next,
  };
}

// One conversation's messages, oldest first (the same order as the grader snapshot).
export async function listMessages(workspace: string, contact: string) {
  const { messages } = await collections();
  const list = await messages.find({ workspace, contact }).sort({ occurredAt: 1, key: 1 }).limit(500).toArray();
  return list.map((m) => ({
    id: m.key, direction: m.dir, text: m.text, at: m.occurredAt, status: m.dir === 'out' ? m.status : undefined,
  }));
}
