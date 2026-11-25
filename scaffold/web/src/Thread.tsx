import { useEffect, useState } from 'react';
import { api, type Conversation, type Message } from './api';

type Props = { workspace: string; contact: string; me: string; role: string; refreshKey: number };

// One conversation: messages oldest first, reply box, and claim / release / close / reopen.
export function Thread({ workspace, contact, me, role, refreshKey }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [info, setInfo] = useState<Conversation | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api.messages(workspace, contact).then((r) => setMessages(r.items)).catch((e) => setError(e.message));
    // the inbox list carries assignee/state; fetch it from there to keep one source
    api.conversations(workspace).then((r) => setInfo(r.items.find((c) => c.contact === contact) ?? null)).catch(() => {});
  }, [workspace, contact, refreshKey]);

  // run an action and show its error, if any; live updates refresh the view afterwards
  const act = async (fn: () => Promise<unknown>) => {
    try { setError(''); await fn(); } catch (e) { setError((e as Error).message); }
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    await act(() => api.reply(workspace, contact, text.trim()));
    setText('');
  };

  const heldByMe = info?.assignee === me;
  const heldByOther = !!info?.assignee && !heldByMe;

  return (
    <section className="thread">
      <header>
        <h2>{contact}</h2>
        <div className="actions">
          {!info?.assignee && <button onClick={() => act(() => api.claim(workspace, contact))}>Claim</button>}
          {heldByOther && role === 'admin' && <button onClick={() => act(() => api.claim(workspace, contact, true))}>Take over</button>}
          {(heldByMe || (heldByOther && role === 'admin')) && <button onClick={() => act(() => api.release(workspace, contact))}>Release</button>}
          {info?.state === 'closed'
            ? <button onClick={() => act(() => api.reopen(workspace, contact))}>Reopen</button>
            : <button onClick={() => act(() => api.close(workspace, contact))}>Close</button>}
        </div>
      </header>
      <p className="muted">{info?.assignee ? 'Held by ' + info.assignee : 'Nobody holds this conversation'} · {info?.state ?? 'open'}</p>
      {error && <p className="error">{error}</p>}
      <ol className="messages">
        {messages.map((m) => (
          <li key={m.direction + m.id} className={m.direction}>
            <div>{m.text}</div>
            <small>{new Date(m.at).toLocaleTimeString()}{m.status ? ' · ' + m.status : ''}</small>
          </li>
        ))}
      </ol>
      <form onSubmit={send} className="reply">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type a reply" maxLength={4096} />
        <button type="submit" disabled={!text.trim()}>Send</button>
      </form>
    </section>
  );
}
