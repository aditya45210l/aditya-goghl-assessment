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
