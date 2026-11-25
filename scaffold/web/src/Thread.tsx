import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, CheckCheck, Clock, Lock, LockOpen, Send, UserCheck, UserMinus, UserPlus, X } from 'lucide-react';
import { api, type Conversation, type Message } from './api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar } from '@/components/ui/avatar';
import { nameOf } from '@/lib/people';
import { cn } from '@/lib/utils';

type Props = { workspace: string; contact: string; me: string; role: string; refreshKey: number; sendingPaused: boolean };

// Delivery status of a reply, shown under the bubble.
function StatusIcon({ status }: { status?: string }) {
  if (status === 'delivered') return <span className="inline-flex items-center gap-1 text-wa-tick"><CheckCheck className="size-3.5" /> delivered</span>;
  if (status === 'sent') return <span className="inline-flex items-center gap-1"><Check className="size-3.5" /> sent</span>;
  if (status === 'failed') return <span className="inline-flex items-center gap-1 text-destructive"><X className="size-3.5" /> failed</span>;
  return <span className="inline-flex items-center gap-1"><Clock className="size-3.5" /> queued</span>;
}

// One conversation: messages oldest first, reply box, and claim / take over / release / close / reopen.
export function Thread({ workspace, contact, me, role, refreshKey, sendingPaused }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [info, setInfo] = useState<Conversation | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [localKey, setLocalKey] = useState(0); // reload after our own actions, even if the live socket is down
  const [older, setOlder] = useState<string | null>(null); // cursor for the next older page, null = none left
  const [loadingOlder, setLoadingOlder] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const keepScroll = useRef<number | null>(null); // distance from the bottom to restore after prepending
  const nearBottom = useRef(true);

  // Newest page only. Live updates and our own actions re-fetch it and merge it into what is loaded,
  // so older pages the agent scrolled to stay, and statuses of recent replies update in place.
  useEffect(() => {
    api.messages(workspace, contact)
      .then((r) => {
        setMessages((old) => mergeMessages(old, r.items));
        setOlder((o) => (messagesLoaded.current ? o : r.older));
        messagesLoaded.current = true;
      })
      .catch((e) => setError(e.message));
    api.conversation(workspace, contact).then(setInfo).catch(() => setInfo(null));
  }, [workspace, contact, refreshKey, localKey]);
  const messagesLoaded = useRef(false);

  // older messages when the agent scrolls to the top
  const loadOlder = async () => {
    if (!older || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const r = await api.messages(workspace, contact, older);
      const el = scroller.current;
      if (el) keepScroll.current = el.scrollHeight - el.scrollTop;
      setMessages((old) => mergeMessages(old, r.items));
      setOlder(r.older);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingOlder(false);
    }
  };

  // after prepending older messages, keep what the agent was looking at in place
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && keepScroll.current !== null) {
      el.scrollTop = el.scrollHeight - keepScroll.current;
      keepScroll.current = null;
    } else if (el && nearBottom.current) {
      el.scrollTop = el.scrollHeight; // new message while at the bottom: follow it
    }
  }, [messages]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 60) loadOlder();
  };

  // run an action, show its error if any, then reload this view
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
      setLocalKey((k) => k + 1);
    }
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    if (await act(() => api.reply(workspace, contact, text.trim()))) setText(''); // keep the text if it failed
  };

  const heldByMe = info?.assignee === me;
  const heldByOther = !!info?.assignee && !heldByMe;
  const closed = info?.state === 'closed';
  const isAdmin = role === 'admin';

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card shadow-sm">
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <Avatar label={contact} className="size-10" />
        <div className="min-w-0">
          <h2 className="tnum truncate text-sm font-semibold">{contact}</h2>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            {info?.assignee ? (
              <>
                <Avatar label={nameOf(info.assignee)} className="size-4" />
                {heldByMe ? 'You are handling this' : nameOf(info.assignee) + ' is handling this'}
              </>
            ) : (
              'Nobody is handling this yet'
            )}
            {closed && <Badge variant="secondary" className="ml-1 rounded-full">Closed</Badge>}
          </div>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          {!info?.assignee && (
            <Button size="sm" variant="brand" className="rounded-lg" disabled={busy} onClick={() => act(() => api.claim(workspace, contact))}>
              <UserPlus /> Claim
            </Button>
          )}
          {heldByOther && isAdmin && (
            <Button size="sm" variant="outline" className="rounded-lg" disabled={busy} onClick={() => act(() => api.claim(workspace, contact, true))}>
              <UserCheck /> Take over
            </Button>
          )}
          {(heldByMe || (heldByOther && isAdmin)) && (
            <Button size="sm" variant="outline" className="rounded-lg" disabled={busy} onClick={() => act(() => api.release(workspace, contact))}>
              <UserMinus /> Release
            </Button>
          )}
          {(!heldByOther || isAdmin) &&
            (closed ? (
              <Button size="sm" variant="outline" className="rounded-lg" disabled={busy} onClick={() => act(() => api.reopen(workspace, contact))}>
                <LockOpen /> Reopen
              </Button>
            ) : (
              <Button size="sm" variant="ghost" className="rounded-lg" disabled={busy} onClick={() => act(() => api.close(workspace, contact))}>
                <Lock /> Close
              </Button>
            ))}
        </div>
      </header>

      {error && <p className="animate-fade-in border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</p>}

      <div ref={scroller} onScroll={onScroll} className="wa-wallpaper scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-5">
        <ol className="mx-auto flex max-w-3xl flex-col gap-2.5">
          {older && (
            <li className="text-center">
              <button onClick={loadOlder} className="rounded-full bg-card/80 px-3 py-1 text-xs text-muted-foreground shadow-sm transition hover:text-foreground">
                {loadingOlder ? 'Loading…' : 'Load earlier messages'}
              </button>
            </li>
          )}
          {messages.length === 0 && <li className="text-center text-sm text-muted-foreground">No messages yet.</li>}
          {messages.map((m) => <Bubble key={m.direction + m.id} m={m} />)}
        </ol>
      </div>

      <footer className="border-t p-3">
        {heldByMe && !closed && !sendingPaused ? (
          <form onSubmit={send} className="mx-auto flex max-w-3xl items-center gap-2">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Write a reply…"
              maxLength={4096}
              autoFocus
              className="h-10 flex-1 rounded-full border bg-background px-4 text-sm outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/20"
            />
            <Button type="submit" variant="brand" size="icon" className="size-10 rounded-full transition-transform hover:scale-105" disabled={!text.trim() || busy} title="Send">
              <Send />
            </Button>
          </form>
        ) : (
          <div className="mx-auto flex max-w-3xl items-center gap-2 rounded-xl border border-dashed px-4 py-2.5 text-sm text-muted-foreground">
            <Lock className="size-4 shrink-0" />
            {sendingPaused
              ? 'Sending is paused: this workspace’s subscription is canceled.'
              : heldByOther
                ? `${nameOf(info!.assignee!)} is handling this conversation.`
                : closed
                  ? 'This conversation is closed. Reopen it to reply.'
                  : 'Claim this conversation to reply.'}
          </div>
        )}
      </footer>
    </section>
  );
}

// Merge a page into what is loaded: same message (direction + id) is replaced by the fresh copy
// (its status may have changed), the old object is kept when nothing changed (memo), then sorted by time.
function mergeMessages(old: Message[], page: Message[]): Message[] {
  const byKey = new Map(old.map((m) => [m.direction + m.id, m]));
  for (const m of page) {
    const prev = byKey.get(m.direction + m.id);
    if (!prev || prev.status !== m.status) byKey.set(m.direction + m.id, m);
  }
  return [...byKey.values()].sort((a, b) => (a.at === b.at ? a.id.localeCompare(b.id) : String(a.at).localeCompare(String(b.at))));
}

// One chat bubble. memo: only bubbles whose message changed re-render on a live update.
const Bubble = memo(function Bubble({ m }: { m: Message }) {
  return (
    <li className={cn('animate-fade-up flex flex-col gap-1', m.direction === 'out' ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'max-w-[75%] rounded-2xl px-3.5 py-2 text-[14px] leading-snug text-zinc-900 shadow-sm dark:text-zinc-100',
          m.direction === 'out' ? 'rounded-tr-md bg-wa-out dark:bg-wa-out-dark' : 'rounded-tl-md bg-white dark:bg-zinc-800',
        )}
      >
        {m.text}
      </div>
      <span className="tnum flex items-center gap-2 px-1 text-[11px] text-muted-foreground">
        {new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        {m.direction === 'out' && <StatusIcon status={m.status} />}
      </span>
    </li>
  );
});
