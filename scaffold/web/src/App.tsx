import { useEffect, useState } from 'react';
import { ChevronRight, CreditCard, Inbox as InboxIcon, LogOut, MessagesSquare, Moon, Sun } from 'lucide-react';
import { api, type Me } from './api';
import { Inbox } from './Inbox';
import { Thread } from './Thread';
import { Billing } from './Billing';
import { useLiveEvents } from './useLiveEvents';
import { useTheme } from '@/lib/theme';
import { TEST_USERS } from '@/lib/people';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar } from '@/components/ui/avatar';
import { ChatIllustration, TeamIllustration } from '@/components/illustrations';
import { cn } from '@/lib/utils';

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

  // whether this workspace may send (billing); refreshed on every live change
  useEffect(() => {
    if (!workspace) return;
    api.billing(workspace).then((x) => setSendingPaused(!x.can_send)).catch(() => setSendingPaused(false));
  }, [workspace, refreshKey]);

  // any live change (new message, status, assignment, billing) refreshes the visible data
  const connected = useLiveEvents(workspace, () => setRefreshKey((k) => k + 1));

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center bg-surface">
        <div className="size-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }
  if (!me) return <SignIn dark={theme.mode === 'dark'} onToggleTheme={theme.toggle} />;

  const role = me.workspaces.find((w) => w.id === workspace)?.role ?? 'agent';
  const showBilling = page === 'billing' && role === 'admin';
  const switchWorkspace = (id: string) => { setWorkspace(id); setSelected(null); setPage('inbox'); };

  return (
    <div className="flex h-screen bg-surface">
      {/* left rail, like the playground CRM */}
      <nav className="hidden w-16 shrink-0 flex-col items-center gap-2 bg-zinc-950 py-4 md:flex">
        <div className="mb-4 flex size-9 items-center justify-center rounded-xl bg-brand text-white shadow-lg shadow-brand/30">
          <MessagesSquare className="size-4" />
        </div>
        <RailButton active={!showBilling} title="Inbox" onClick={() => setPage('inbox')}><InboxIcon className="size-[18px]" /></RailButton>
        {role === 'admin' && (
          <RailButton active={showBilling} title="Billing" onClick={() => setPage('billing')}><CreditCard className="size-[18px]" /></RailButton>
        )}
        <div className="mt-auto flex flex-col items-center gap-2">
          <RailButton active={false} title={theme.mode === 'dark' ? 'Light mode' : 'Dark mode'} onClick={theme.toggle}>
            {theme.mode === 'dark' ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
          </RailButton>
          <RailButton active={false} title="Sign out" onClick={async () => { await api.logout(); location.reload(); }}>
            <LogOut className="size-[18px]" />
          </RailButton>
        </div>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center gap-3 px-4 md:px-5">
          <div className="min-w-0">
            <h1 className="text-[15px] font-semibold">{showBilling ? 'Billing' : 'Conversations'}</h1>
            <p className="text-xs text-muted-foreground">{showBilling ? 'Seats and payments for this workspace' : 'Customer messages, live'}</p>
          </div>
          <div className="ml-2 flex items-center gap-2">
            <select
              aria-label="Workspace"
              className="h-9 rounded-lg border bg-card px-3 text-[13px] font-medium shadow-xs transition hover:border-brand/50"
              value={workspace ?? ''}
              onChange={(e) => switchWorkspace(e.target.value)}
            >
              {me.workspaces.map((w) => <option key={w.id} value={w.id}>{w.id}</option>)}
            </select>
            <Badge variant="outline" className="hidden rounded-full capitalize sm:inline-flex">{role}</Badge>
            <Badge variant={connected ? 'success' : 'warning'} className="rounded-full">
              <span className="relative flex size-1.5">
                {connected && <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-60" />}
                <span className={'relative inline-flex size-1.5 rounded-full ' + (connected ? 'bg-emerald-500' : 'bg-amber-500')} />
              </span>
              {connected ? 'Live' : 'Reconnecting'}
            </Badge>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="icon" className="rounded-lg md:hidden" title="Toggle theme" onClick={theme.toggle}>
              {theme.mode === 'dark' ? <Sun /> : <Moon />}
            </Button>
            <div className="flex items-center gap-2 rounded-full border bg-card py-1 pr-3 pl-1 shadow-xs">
              <Avatar label={me.name ?? me.sub} className="size-7" />
              <span className="hidden text-[13px] font-medium sm:inline">{me.name ?? me.sub}</span>
            </div>
            <Button variant="ghost" size="icon" className="rounded-lg md:hidden" title="Sign out" onClick={async () => { await api.logout(); location.reload(); }}>
              <LogOut />
            </Button>
          </div>
        </header>

        {sendingPaused && (
          <div className="animate-fade-in mx-4 mb-3 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-[13px] text-destructive md:mx-5">
            This workspace's subscription is canceled, so sending replies is paused. {role === 'admin' ? 'Open Billing to subscribe again.' : 'Ask an admin to subscribe again.'}
          </div>
        )}

        {workspace && showBilling && (
          <div className="flex min-h-0 flex-1 px-3 pb-3 md:px-5 md:pb-5">
            <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border bg-card shadow-sm">
              <Billing workspace={workspace} refreshKey={refreshKey} />
            </div>
          </div>
        )}
        {workspace && !showBilling && (
          <div className="flex min-h-0 flex-1 flex-col gap-3 px-3 pb-3 md:flex-row md:px-5 md:pb-5">
            <Inbox workspace={workspace} me={me.sub} selected={selected} onSelect={setSelected} refreshKey={refreshKey} />
            {selected ? (
              <Thread key={workspace + selected} workspace={workspace} contact={selected} me={me.sub} role={role} refreshKey={refreshKey} sendingPaused={sendingPaused} />
            ) : (
              <div className="hidden flex-1 flex-col items-center justify-center gap-3 rounded-xl border bg-card text-center shadow-sm md:flex">
                <ChatIllustration className="w-48" />
                <div>
                  <p className="font-medium">Pick a conversation</p>
                  <p className="text-sm text-muted-foreground">Claim it to reply. New messages appear here live.</p>
                </div>
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
      aria-label={title}
      onClick={onClick}
      className={cn(
        'flex size-10 items-center justify-center rounded-xl transition-all duration-150',
        active ? 'bg-white/15 text-white' : 'text-zinc-400 hover:bg-white/10 hover:text-white',
      )}
    >
      {children}
    </button>
  );
}

// Sign-in page: the mock IdP's own page is a plain list, so we show its test users here.
// Clicking one runs the normal OIDC + PKCE flow with the mock's `login` hint, which skips that list.
function SignIn({ dark, onToggleTheme }: { dark: boolean; onToggleTheme: () => void }) {
  return (
    <div className="grid min-h-screen place-items-center bg-surface p-4">
      <button
        onClick={onToggleTheme}
        title="Toggle theme"
        className="absolute top-4 right-4 flex size-9 items-center justify-center rounded-lg border bg-card text-muted-foreground shadow-xs transition hover:text-foreground"
      >
        {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
      </button>
      <div className="animate-fade-up grid w-full max-w-4xl overflow-hidden rounded-2xl border bg-card shadow-xl md:grid-cols-2">
        <div className="relative hidden flex-col justify-between bg-gradient-to-br from-brand to-indigo-700 p-8 text-white md:flex">
          <div className="flex items-center gap-2 font-semibold">
            <span className="flex size-8 items-center justify-center rounded-lg bg-white/15"><MessagesSquare className="size-4" /></span>
            Switchboard
          </div>
          <TeamIllustration className="mx-auto w-64" />
          <div>
            <h2 className="text-xl font-semibold">One inbox for the whole team</h2>
            <p className="mt-1 text-sm text-white/75">Customer messages arrive live. Claim a conversation, reply, and nobody answers twice.</p>
          </div>
        </div>

        <div className="p-6 md:p-8">
          <h1 className="text-lg font-semibold">Sign in</h1>
          <p className="mt-1 text-sm text-muted-foreground">Choose a test account. Sign-in still goes through the identity provider.</p>
          <div className="mt-5 space-y-2">
            {TEST_USERS.map((u) => (
              <a
                key={u.sub}
                href={'/auth/login?login=' + u.sub}
                className="group flex items-center gap-3 rounded-xl border p-3 transition-all duration-150 hover:-translate-y-0.5 hover:border-brand/40 hover:bg-brand/5 hover:shadow-md"
              >
                <Avatar label={u.name} className="size-10" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{u.name}</div>
                  <div className="truncate text-xs text-muted-foreground">{u.email} · {u.roles}</div>
                </div>
                <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-brand" />
              </a>
            ))}
          </div>
          <a href="/auth/login" className="mt-4 inline-block text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            Use the identity provider's own page instead
          </a>
        </div>
      </div>
    </div>
  );
}
