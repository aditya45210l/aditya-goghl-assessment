import { useEffect, useState } from 'react';
import { CreditCard, Inbox as InboxIcon, LogOut, MessagesSquare, Moon, Sun } from 'lucide-react';
import { api, type Me } from './api';
import { Inbox } from './Inbox';
import { Thread } from './Thread';
import { Billing } from './Billing';
import { useLiveEvents } from './useLiveEvents';
import { useTheme } from '@/lib/theme';
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
  const [page, setPage] = useState<'inbox' | 'billing'>('inbox');
  const [sendingPaused, setSendingPaused] = useState(false);
  const theme = useTheme();

  useEffect(() => {
    api.me()
      .then((m) => { setMe(m); setWorkspace(m.workspaces[0]?.id ?? null); })
      .catch(() => setMe(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!workspace) return;
    api.billing(workspace).then((x) => setSendingPaused(!x.can_send)).catch(() => setSendingPaused(false));
  }, [workspace, refreshKey]);

  // any live change (new message, status, assignment) refreshes the visible data
  const connected = useLiveEvents(workspace, () => setRefreshKey((k) => k + 1));

  if (loading) return <div className="grid min-h-screen place-items-center text-sm text-muted-foreground">Loading…</div>;
  if (!me) return <SignIn />;

  const role = me.workspaces.find((w) => w.id === workspace)?.role ?? 'agent';
  const showBilling = page === 'billing' && role === 'admin';
  const switchWorkspace = (id: string) => { setWorkspace(id); setSelected(null); };

  return (
    <div className="flex h-screen">
      {/* left rail, like the playground CRM */}
      <nav className="hidden w-14 shrink-0 flex-col items-center gap-1 bg-zinc-950 py-3 md:flex">
        <div className="mb-3 flex size-8 items-center justify-center rounded-md bg-brand text-white">
          <MessagesSquare className="size-4" />
        </div>
        <RailButton active={!showBilling} title="Inbox" onClick={() => setPage('inbox')}><InboxIcon className="size-4" /></RailButton>
        {role === 'admin' && (
          <RailButton active={showBilling} title="Billing" onClick={() => setPage('billing')}><CreditCard className="size-4" /></RailButton>
        )}
        <button
          onClick={theme.toggle}
          title={theme.mode === 'dark' ? 'Light mode' : 'Dark mode'}
          className="mt-auto flex size-9 items-center justify-center rounded-md text-zinc-400 hover:bg-white/10 hover:text-white"
        >
          {theme.mode === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </button>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-card px-4">
          <span className="font-semibold md:hidden">Switchboard</span>
          <span className="hidden text-sm font-semibold md:inline">Conversations</span>
          <select
            aria-label="Workspace"
            className="h-8 rounded-md border bg-background px-2 text-[13px] shadow-xs"
            value={workspace ?? ''}
            onChange={(e) => switchWorkspace(e.target.value)}
          >
            {me.workspaces.map((w) => <option key={w.id} value={w.id}>{w.id}</option>)}
          </select>
          <Badge variant="outline" className="capitalize">{role}</Badge>
          <Badge variant={connected ? 'success' : 'warning'}>
            <span className={'size-1.5 rounded-full ' + (connected ? 'bg-emerald-500' : 'bg-amber-500')} />
            {connected ? 'Live' : 'Reconnecting'}
          </Badge>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="icon" className="md:hidden" title="Toggle theme" onClick={theme.toggle}>
              {theme.mode === 'dark' ? <Sun /> : <Moon />}
            </Button>
            <Avatar label={me.name ?? me.sub} className="size-8" />
            <span className="hidden text-[13px] font-medium sm:inline">{me.name ?? me.sub}</span>
            <Button variant="ghost" size="icon" title="Sign out" onClick={async () => { await api.logout(); location.reload(); }}>
              <LogOut />
            </Button>
          </div>
        </header>

        {sendingPaused && (
          <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-[13px] text-destructive">
            This workspace's subscription is canceled: sending replies is paused. {role === 'admin' ? 'Open Billing to subscribe again.' : 'Ask an admin to subscribe again.'}
          </div>
        )}
        {workspace && showBilling && <Billing workspace={workspace} refreshKey={refreshKey} />}
        {workspace && !showBilling && (
          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            <Inbox workspace={workspace} me={me.sub} selected={selected} onSelect={setSelected} refreshKey={refreshKey} />
            {selected ? (
              <Thread key={workspace + selected} workspace={workspace} contact={selected} me={me.sub} role={role} refreshKey={refreshKey} />
            ) : (
              <div className="hidden flex-1 flex-col items-center justify-center gap-2 bg-surface text-muted-foreground md:flex">
                <InboxIcon className="size-10 opacity-40" />
                <p className="text-sm">Select a conversation to read and reply.</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function RailButton({ active, title, onClick, children }: { active: boolean; title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={'flex size-9 items-center justify-center rounded-md ' + (active ? 'bg-white/10 text-white' : 'text-zinc-400 hover:bg-white/10 hover:text-white')}
    >
      {children}
    </button>
  );
}

function SignIn() {
  return (
    <div className="grid min-h-screen place-items-center bg-surface p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <div className="mx-auto mb-2 flex size-10 items-center justify-center rounded-md bg-brand text-white">
            <MessagesSquare className="size-5" />
          </div>
          <CardTitle className="text-xl">Switchboard</CardTitle>
          <CardDescription>The shared inbox for your support team.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="brand" className="w-full">
            <a href="/auth/login">Sign in</a>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
