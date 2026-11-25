import { useEffect, useRef, useState } from 'react';
import { Check, CheckCheck, Clock, Lock, Send, X } from 'lucide-react';
import { api, type Conversation, type Message } from './api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';

type Props = { workspace: string; contact: string; me: string; role: string; refreshKey: number };

// Delivery status of a reply, shown under the bubble.
function StatusIcon({ status }: { status?: string }) {
  if (status === 'delivered') return <span className="inline-flex items-center gap-1"><CheckCheck className="size-3.5" /> delivered</span>;
  if (status === 'sent') return <span className="inline-flex items-center gap-1"><Check className="size-3.5" /> sent</span>;
  if (status === 'failed') return <span className="inline-flex items-center gap-1 text-destructive"><X className="size-3.5" /> failed</span>;
  return <span className="inline-flex items-center gap-1"><Clock className="size-3.5" /> queued</span>;
}

// One conversation: messages oldest first, reply box, and claim / release / close / reopen.
export function Thread({ workspace, contact, me, role, refreshKey }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [info, setInfo] = useState<Conversation | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.messages(workspace, contact).then((r) => setMessages(r.items)).catch((e) => setError(e.message));
    api.conversation(workspace, contact).then(setInfo).catch(() => setInfo(null));
  }, [workspace, contact, refreshKey]);

  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [messages.length]);

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
  const closed = info?.state === 'closed';

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <Avatar label={contact} />
        <div className="min-w-0">
          <h2 className="truncate font-semibold">{contact}</h2>
          <p className="text-xs text-muted-foreground">
            {info?.assignee ? (heldByMe ? 'Assigned to you' : 'Assigned to ' + info.assignee) : 'Unassigned'}
            {closed && ' · Closed'}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          {!info?.assignee && <Button size="sm" onClick={() => act(() => api.claim(workspace, contact))}>Claim</Button>}
          {heldByOther && role === 'admin' && (
            <Button size="sm" variant="outline" onClick={() => act(() => api.claim(workspace, contact, true))}>Take over</Button>
          )}
          {(heldByMe || (heldByOther && role === 'admin')) && (
            <Button size="sm" variant="outline" onClick={() => act(() => api.release(workspace, contact))}>Release</Button>
          )}
          {closed
            ? <Button size="sm" variant="outline" onClick={() => act(() => api.reopen(workspace, contact))}>Reopen</Button>
            : <Button size="sm" variant="ghost" onClick={() => act(() => api.close(workspace, contact))}>Close</Button>}
        </div>
      </header>

      {error && <p className="border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</p>}

      <div className="min-h-0 flex-1 overflow-y-auto bg-muted/30 px-4 py-4">
        <ol className="mx-auto flex max-w-3xl flex-col gap-3">
          {messages.length === 0 && <li className="text-center text-sm text-muted-foreground">No messages yet.</li>}
          {messages.map((m) => (
            <li key={m.direction + m.id} className={cn('flex flex-col gap-1', m.direction === 'out' ? 'items-end' : 'items-start')}>
              <div
                className={cn(
                  'max-w-[75%] rounded-2xl px-4 py-2 text-sm shadow-xs',
                  m.direction === 'out' ? 'rounded-br-sm bg-primary text-primary-foreground' : 'rounded-bl-sm border bg-card',
                )}
              >
                {m.text}
              </div>
              <span className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
                {new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                {m.direction === 'out' && <StatusIcon status={m.status} />}
              </span>
            </li>
          ))}
          <div ref={bottom} />
        </ol>
      </div>

      <footer className="border-t p-3">
        {heldByMe && closed ? (
          <div className="mx-auto flex max-w-3xl items-center gap-2 rounded-md border border-dashed px-4 py-2 text-sm text-muted-foreground">
            <Lock className="size-4" /> This conversation is closed. Reopen it to reply.
          </div>
        ) : heldByMe ? (
          <form onSubmit={send} className="mx-auto flex max-w-3xl gap-2">
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a reply…" maxLength={4096} autoFocus />
            <Button type="submit" disabled={!text.trim()}><Send /> Send</Button>
          </form>
        ) : (
          <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 rounded-md border border-dashed px-4 py-2 text-sm text-muted-foreground">
            <span className="flex items-center gap-2">
              <Lock className="size-4" />
              {heldByOther ? `${info?.assignee} is handling this conversation.` : 'Claim this conversation to reply.'}
            </span>
            {!info?.assignee && <Badge variant="outline">Unassigned</Badge>}
          </div>
        )}
      </footer>
    </section>
  );
}
