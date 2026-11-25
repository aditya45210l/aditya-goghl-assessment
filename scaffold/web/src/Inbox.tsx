import { useCallback, useEffect, useState } from 'react';
import { api, type Conversation } from './api';

type Props = { workspace: string; selected: string | null; onSelect: (contact: string) => void; refreshKey: number };

// Conversation list, newest activity first, with "load more" pagination.
export function Inbox({ workspace, selected, onSelect, refreshKey }: Props) {
  const [items, setItems] = useState<Conversation[]>([]);
  const [next, setNext] = useState<string | null>(null);
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

  return (
    <aside className="inbox">
      {error && <p className="error">{error}</p>}
      {items.length === 0 && !error && <p className="muted">No conversations yet.</p>}
      {items.map((c) => (
        <button key={c.contact} className={'conv' + (c.contact === selected ? ' active' : '')} onClick={() => onSelect(c.contact)}>
          <strong>{c.contact}</strong>
          <span className="muted">
            {c.state === 'closed' ? 'closed · ' : ''}
            {c.assignee ? 'held by ' + c.assignee : 'unassigned'} · {new Date(c.lastActivityAt).toLocaleTimeString()}
          </span>
        </button>
      ))}
      {next && <button className="more" onClick={loadMore}>Load more</button>}
    </aside>
  );
}
