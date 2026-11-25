import { useCallback, useEffect, useState } from 'react';
import { api, type Conversation } from './api';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type Props = { workspace: string; me: string; selected: string | null; onSelect: (contact: string) => void; refreshKey: number };
type Filter = 'all' | 'mine' | 'unassigned' | 'closed';

const FILTERS: Array<{ id: Filter; label: string; test: (c: Conversation, me: string) => boolean }> = [
  { id: 'all', label: 'All', test: (c) => c.state !== 'closed' },
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

// Conversation list, newest activity first, with "load more" pagination and quick filters.
export function Inbox({ workspace, me, selected, onSelect, refreshKey }: Props) {
  const [items, setItems] = useState<Conversation[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [error, setError] = useState('');

  // reload the first page whenever something changed (refreshKey) or the workspace changed
  const loadFirst = useCallback(async () => {
    try {
      const page = await api.conversations(workspace);
      setItems(page.items);
      setNext(page.next);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [workspace]);

  useEffect(() => { loadFirst(); }, [loadFirst, refreshKey]);

  const loadMore = async () => {
    if (!next) return;
    const page = await api.conversations(workspace, next);
    setItems((old) => [...old, ...page.items.filter((c) => !old.some((o) => o.contact === c.contact))]);
    setNext(page.next);
  };

  const test = FILTERS.find((f) => f.id === filter)!.test;
  const shown = items.filter((c) => test(c, me));

  return (
    <aside className="flex max-h-[40vh] w-full shrink-0 flex-col border-b md:max-h-none md:w-80 md:border-r md:border-b-0">
      <div className="flex gap-1 border-b p-2">
        {FILTERS.map((f) => (
          <Button key={f.id} size="sm" variant={filter === f.id ? 'secondary' : 'ghost'} onClick={() => setFilter(f.id)}>
            {f.label}
          </Button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && <p className="p-4 text-sm text-destructive">{error}</p>}
        {!error && shown.length === 0 && <p className="p-4 text-sm text-muted-foreground">Nothing here.</p>}
        {shown.map((c) => (
          <button
            key={c.contact}
            onClick={() => onSelect(c.contact)}
            className={cn(
              'flex w-full items-center gap-3 border-b px-3 py-3 text-left transition-colors hover:bg-accent',
              c.contact === selected && 'bg-accent',
            )}
          >
            <Avatar label={c.contact} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">{c.contact}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(c.lastActivityAt)}</span>
              </div>
              <div className="mt-1 flex gap-1">
                {c.assignee
                  ? <Badge variant={c.assignee === me ? 'default' : 'secondary'}>{c.assignee === me ? 'You' : c.assignee}</Badge>
                  : <Badge variant="outline">Unassigned</Badge>}
                {c.state === 'closed' && <Badge variant="secondary">Closed</Badge>}
              </div>
            </div>
          </button>
        ))}
        {next && (
          <div className="p-2">
            <Button variant="ghost" size="sm" className="w-full" onClick={loadMore}>Load more</Button>
          </div>
        )}
      </div>
    </aside>
  );
}
