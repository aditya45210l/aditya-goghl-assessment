import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { api, type Conversation } from './api';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { nameOf } from '@/lib/people';
import { cn } from '@/lib/utils';

type Props = { workspace: string; me: string; selected: string | null; onSelect: (contact: string) => void; refreshKey: number };
type Filter = 'all' | 'mine' | 'unassigned' | 'closed';

const FILTERS: Array<{ id: Filter; label: string; test: (c: Conversation, me: string) => boolean }> = [
  { id: 'all', label: 'Open', test: (c) => c.state !== 'closed' },
  { id: 'mine', label: 'Mine', test: (c, me) => c.assignee === me && c.state !== 'closed' },
  { id: 'unassigned', label: 'Unassigned', test: (c) => !c.assignee && c.state !== 'closed' },
  { id: 'closed', label: 'Closed', test: (c) => c.state === 'closed' },
];

function timeAgo(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return new Date(iso).toLocaleDateString();
}

// Conversation list: newest activity first, quick filters, search, "load more" pagination.
export function Inbox({ workspace, me, selected, onSelect, refreshKey }: Props) {
  const [items, setItems] = useState<Conversation[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');

  // Live updates reload page one and merge it in, so rows loaded with "load more" stay visible.
  const loadFirst = useCallback(async () => {
    try {
      const page = await api.conversations(workspace);
      setItems((old) => {
        // keep the old object when a row did not change, so its memoized row does not re-render
        const before = new Map(old.map((c) => [c.contact, c]));
        const same = (a: Conversation, b?: Conversation) =>
          !!b && a.assignee === b.assignee && a.state === b.state && a.lastActivityAt === b.lastActivityAt;
        const fresh = page.items.map((c) => (same(c, before.get(c.contact)) ? before.get(c.contact)! : c));
        const freshIds = new Set(fresh.map((c) => c.contact));
        const rest = old.filter((c) => !freshIds.has(c.contact));
        return [...fresh, ...rest].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
      });
      setNext((n) => n ?? page.next);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [workspace]);

  useEffect(() => { setItems([]); setNext(null); }, [workspace]);
  useEffect(() => { loadFirst(); }, [loadFirst, refreshKey]);

  const loadMore = async () => {
    if (!next) return;
    try {
      const page = await api.conversations(workspace, next);
      setItems((old) => [...old, ...page.items.filter((c) => !old.some((o) => o.contact === c.contact))]);
      setNext(page.next);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // derived lists are recomputed only when their inputs change
  const shown = useMemo(() => {
    const test = FILTERS.find((f) => f.id === filter)!.test;
    const q = query.replace(/\s/g, '');
    return items.filter((c) => test(c, me) && c.contact.includes(q));
  }, [items, filter, query, me]);
  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map((f) => [f.id, items.filter((c) => f.test(c, me)).length])) as Record<Filter, number>,
    [items, me],
  );

  return (
    <aside className="flex max-h-[45vh] w-full shrink-0 flex-col overflow-hidden rounded-xl border bg-card shadow-sm md:max-h-none md:w-[320px]">
      <div className="space-y-2 border-b p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by number"
            className="h-9 w-full rounded-lg border bg-background pr-3 pl-8 text-[13px] outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/20"
          />
        </div>
        <div className="flex gap-1 rounded-lg bg-muted p-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={cn(
                'flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium transition',
                filter === f.id ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {f.label}
              <span className="tnum text-[10px] opacity-60">{counts[f.id]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="scroll-thin min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
        {error && <p className="p-3 text-sm text-destructive">{error}</p>}
        {!error && shown.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">No conversations here.</p>}
        {shown.map((c) => (
          <ConversationRow key={c.contact} c={c} me={me} active={c.contact === selected} onSelect={onSelect} />
        ))}
        {next && (
          <Button variant="ghost" size="sm" className="w-full rounded-lg" onClick={loadMore}>Load more</Button>
        )}
      </div>
    </aside>
  );
}

// One inbox row. memo: a live update re-renders only the rows whose data actually changed.
const ConversationRow = memo(function ConversationRow({ c, me, active, onSelect }: { c: Conversation; me: string; active: boolean; onSelect: (contact: string) => void }) {
  return (
    <button
      onClick={() => onSelect(c.contact)}
      className={cn(
        'animate-fade-in group flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left transition-all duration-150',
        active ? 'bg-brand/10 ring-1 ring-brand/30' : 'hover:bg-muted/70',
      )}
    >
      <Avatar label={c.contact} className="size-10 transition-transform group-hover:scale-105" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="tnum truncate text-[13px] font-semibold">{c.contact}</span>
          <span className="tnum shrink-0 text-[11px] text-muted-foreground">{timeAgo(c.lastActivityAt)}</span>
        </div>
        <div className="mt-1 flex items-center gap-1.5">
          {c.assignee ? (
            <Badge variant={c.assignee === me ? 'brand' : 'secondary'} className="gap-1 rounded-full pl-0.5">
              <Avatar label={nameOf(c.assignee)} className="size-4" />
              {c.assignee === me ? 'You' : nameOf(c.assignee)}
            </Badge>
          ) : (
            <Badge variant="outline" className="rounded-full">Unassigned</Badge>
          )}
          {c.state === 'closed' && <Badge variant="secondary" className="rounded-full">Closed</Badge>}
        </div>
      </div>
    </button>
  );
});
