import { useEffect, useState } from 'react';
import { Inbox as InboxIcon, LogOut, MessagesSquare } from 'lucide-react';
import { api, type Me } from './api';
import { Inbox } from './Inbox';
import { Thread } from './Thread';
import { useLiveEvents } from './useLiveEvents';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar } from '@/components/ui/avatar';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

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
  const connected = useLiveEvents(workspace, () => setRefreshKey((k) => k + 1));

  if (loading) return <div className="grid min-h-screen place-items-center text-muted-foreground">Loading…</div>;
  if (!me) return <SignIn />;

  const role = me.workspaces.find((w) => w.id === workspace)?.role ?? 'agent';
  const switchWorkspace = (id: string) => { setWorkspace(id); setSelected(null); };

  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
        <div className="flex items-center gap-2 font-semibold">
          <MessagesSquare className="size-5" /> Switchboard
        </div>
        <select
          aria-label="Workspace"
          className="h-8 rounded-md border bg-transparent px-2 text-sm shadow-xs"
          value={workspace ?? ''}
          onChange={(e) => switchWorkspace(e.target.value)}
        >
          {me.workspaces.map((w) => <option key={w.id} value={w.id}>{w.id}</option>)}
        </select>
        <Badge variant="outline" className="capitalize">{role}</Badge>
        <Badge variant={connected ? 'success' : 'warning'}>
          <span className={'size-1.5 rounded-full ' + (connected ? 'bg-success' : 'bg-warning')} />
          {connected ? 'Live' : 'Reconnecting'}
        </Badge>
        <div className="ml-auto flex items-center gap-3">
          <Avatar label={me.name ?? me.sub} className="size-8" />
          <span className="hidden text-sm sm:inline">{me.name ?? me.sub}</span>
          <Button variant="ghost" size="icon" title="Sign out" onClick={async () => { await api.logout(); location.reload(); }}>
            <LogOut />
          </Button>
        </div>
      </header>

      {workspace && (
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <Inbox workspace={workspace} me={me.sub} selected={selected} onSelect={setSelected} refreshKey={refreshKey} />
          {selected ? (
            <Thread key={workspace + selected} workspace={workspace} contact={selected} me={me.sub} role={role} refreshKey={refreshKey} />
          ) : (
            <div className="hidden flex-1 flex-col items-center justify-center gap-2 text-muted-foreground md:flex">
              <InboxIcon className="size-10 opacity-40" />
              <p className="text-sm">Select a conversation to read and reply.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SignIn() {
  return (
    <div className="grid min-h-screen place-items-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <MessagesSquare className="mb-2 size-8" />
          <CardTitle className="text-xl">Switchboard</CardTitle>
          <CardDescription>The shared inbox for your support team.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild className="w-full">
            <a href="/auth/login">Sign in</a>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
