import { useEffect, useState } from 'react';
import { api, type Me } from './api';
import { Inbox } from './Inbox';
import { Thread } from './Thread';
import { useLiveEvents, type LiveFrame } from './useLiveEvents';
import './styles.css';

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    api.me()
      .then((m) => { setMe(m); setWorkspace(m.workspaces[0]?.id ?? null); })
      .catch(() => setMe(null))
      .finally(() => setLoading(false));
  }, []);

  // any live change (new message, status, assignment) refreshes the visible data
  const connected = useLiveEvents(workspace, (_frame: LiveFrame) => setRefreshKey((k) => k + 1));

  if (loading) return <main className="center">Loading…</main>;
  if (!me) {
    return (
      <main className="center">
        <h1>Switchboard</h1>
        <p className="muted">Shared inbox for your support team.</p>
        <a className="button" href="/auth/login">Sign in</a>
      </main>
    );
  }

  const role = me.workspaces.find((w) => w.id === workspace)?.role ?? 'agent';

  return (
    <div className="app">
      <nav className="top">
        <strong>Switchboard</strong>
        <select value={workspace ?? ''} onChange={(e) => { setWorkspace(e.target.value); setSelected(null); }}>
          {me.workspaces.map((w) => <option key={w.id} value={w.id}>{w.id} ({w.role})</option>)}
        </select>
        <span className={connected ? 'live on' : 'live'}>{connected ? 'live' : 'reconnecting…'}</span>
        <span className="spacer" />
        <span className="muted">{me.name ?? me.sub}</span>
        <button onClick={async () => { await api.logout(); location.reload(); }}>Sign out</button>
      </nav>
      {workspace && (
        <div className="main">
          <Inbox workspace={workspace} selected={selected} onSelect={setSelected} refreshKey={refreshKey} />
          {selected
            ? <Thread workspace={workspace} contact={selected} me={me.sub} role={role} refreshKey={refreshKey} />
            : <section className="thread center muted">Pick a conversation</section>}
        </div>
      )}
    </div>
  );
}
