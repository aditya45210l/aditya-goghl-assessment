import { useEffect, useRef, useState } from 'react';
import { CreditCard, ExternalLink, Loader2 } from 'lucide-react';
import { api, type Billing as BillingState } from './api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type Props = { workspace: string; refreshKey: number };

const dollars = (cents: number) => '$' + (cents / 100).toFixed(2);
const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString() : '');

// The state in plain words, and what to do about it.
function explain(b: BillingState): { badge: 'success' | 'warning' | 'destructive' | 'secondary' | 'brand'; label: string; text: string } {
  switch (b.status) {
    case 'active':
      return { badge: 'success', label: 'Active', text: `Paid for ${b.seats} seat(s).` + (b.cancel_at_period_end ? ` Ends on ${date(b.period_end)}.` : ` Renews on ${date(b.period_end)}.`) };
    case 'past_due':
      return { badge: 'warning', label: 'Payment failed', text: 'The last renewal was declined. Paybox retries 3 and 5 days after the first failure; if those fail too, the subscription is canceled and sending stops. Agents can still send meanwhile.' };
    case 'incomplete':
      return b.action_url
        ? { badge: 'brand', label: 'Waiting for your bank', text: 'Your bank must approve this payment. Open the bank page, approve it, and this page updates by itself. Agents can keep sending meanwhile.' }
        : { badge: 'warning', label: 'Payment declined', text: `The first payment did not go through (${b.reason ?? 'declined'}). Try another card below.` };
    case 'canceled':
      return { badge: 'destructive', label: 'Canceled', text: 'The subscription has ended. Sending replies is paused for everyone; the inbox can still be read. Subscribe again to resume.' };
    default:
      return { badge: 'secondary', label: 'Free trial', text: 'This workspace is on the free trial and can send. Subscribe to keep going.' };
  }
}

// Admin billing page. The card goes from this page straight to Paybox (publishable key);
// our server only ever receives the single-use token.
export function Billing({ workspace, refreshKey }: Props) {
  const [b, setB] = useState<BillingState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [seats, setSeats] = useState(3);
  const [card, setCard] = useState({ number: '4242 4242 4242 4242', exp: '12/30', cvc: '123' });
  const [newSeats, setNewSeats] = useState(0);
  const inFlight = useRef(false); // blocks a second click before React re-renders the disabled button

  useEffect(() => {
    api.billing(workspace).then((x) => { setB(x); setNewSeats(x.seats ?? 0); }).catch((e) => setError(e.message));
  }, [workspace, refreshKey]);

  const run = async (fn: () => Promise<{ ok: boolean; reason?: string; billing: BillingState }>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const out = await fn();
      setB((old) => ({ ...old, ...out.billing }));
      // waiting for the bank is not an error: the status card already explains it
      if (!out.ok && out.reason !== 'requires_action') setError('Not completed: ' + (out.reason ?? 'payment failed'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  // 1. card -> token at Paybox, from the browser; 2. token -> our server
  const subscribe = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      const [m, y] = card.exp.split('/').map((v) => Number(v.trim()));
      const res = await fetch(b!.paybox!.url + '/v1/tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + b!.paybox!.publishableKey },
        body: JSON.stringify({ card: { number: card.number.replace(/\s/g, ''), exp_month: m, exp_year: y < 100 ? 2000 + y : y, cvc: card.cvc } }),
      });
      const tok = await res.json();
      if (!res.ok) throw new Error('Card rejected: ' + (tok.error?.code ?? res.status));
      try {
        return await api.subscribe(workspace, seats, tok.id);
      } catch (err) {
        // 402 still carries the new state (e.g. waiting for the bank): show it
        const data = (err as { data?: { billing: BillingState; reason?: string } }).data;
        if (data?.billing) return { ok: false, reason: data.reason, billing: data.billing };
        throw err;
      }
    });
  };

  if (error && !b) return <div className="flex-1 bg-surface p-6 text-sm text-destructive">{error}</div>;
  if (!b) return <div className="flex-1 bg-surface p-6 text-sm text-muted-foreground">Loading billing…</div>;

  const info = explain(b);
  const subscribed = b.status === 'active' || b.status === 'past_due';
  const price = b.price_per_seat_cents ?? 1200;

  return (
    <div className="scroll-thin flex-1 overflow-y-auto p-4 md:p-8">
      <div className="mx-auto flex max-w-2xl flex-col gap-4">
        <Card className="rounded-xl">
          <CardHeader>
            <div className="flex items-center gap-2">
              <CardTitle>Subscription</CardTitle>
              <Badge variant={info.badge}>{info.label}</Badge>
            </div>
            <CardDescription>{info.text}</CardDescription>
          </CardHeader>
          {b.action_url && (
            <CardContent>
              <Button asChild variant="brand">
                <a href={b.action_url} target="_blank" rel="noreferrer"><ExternalLink /> Open bank page</a>
              </Button>
            </CardContent>
          )}
        </Card>

        {error && <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

        {subscribed ? (
          <Card className="rounded-xl">
            <CardHeader>
              <CardTitle>Seats</CardTitle>
              <CardDescription>
                Adding seats is charged now, pro rata for the rest of the month. Removing seats applies now and the unused
                amount becomes credit on your next invoice (no refunds).
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-2">
              <Input type="number" min={1} max={1000} value={newSeats} onChange={(e) => setNewSeats(Number(e.target.value))} className="w-28" />
              <Button variant="brand" disabled={busy || newSeats < 1 || newSeats === b.seats} onClick={() => run(() => api.changeSeats(workspace, newSeats))}>
                {busy && <Loader2 className="animate-spin" />} Update seats
              </Button>
              <span className="text-sm text-muted-foreground">{dollars(newSeats * price)} / 30 days</span>
              {!b.cancel_at_period_end && (
                <Button variant="ghost" className="ml-auto" disabled={busy} onClick={() => run(() => api.cancelBilling(workspace))}>
                  Cancel at period end
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <Card className="rounded-xl">
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><CreditCard className="size-4" /> Subscribe</CardTitle>
              <CardDescription>
                {dollars(price)} per seat every 30 days. Test cards: 4242… succeeds, 4000 0000 0000 0002 declines,
                4000 0025 0000 3155 asks your bank, 4000 0000 0000 0341 pays once.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={subscribe} className="grid gap-3 sm:grid-cols-4">
                <label className="text-sm sm:col-span-1">Seats
                  <Input type="number" min={1} max={1000} value={seats} onChange={(e) => setSeats(Number(e.target.value))} />
                </label>
                <label className="text-sm sm:col-span-3">Card number
                  <Input inputMode="numeric" autoComplete="cc-number" value={card.number} onChange={(e) => setCard({ ...card, number: e.target.value })} />
                </label>
                <label className="text-sm">Expiry (MM/YY)
                  <Input autoComplete="cc-exp" value={card.exp} onChange={(e) => setCard({ ...card, exp: e.target.value })} />
                </label>
                <label className="text-sm">CVC
                  <Input inputMode="numeric" autoComplete="cc-csc" value={card.cvc} onChange={(e) => setCard({ ...card, cvc: e.target.value })} />
                </label>
                <div className="flex items-end sm:col-span-2">
                  <Button type="submit" variant="brand" className="w-full" disabled={busy || seats < 1}>
                    {busy && <Loader2 className="animate-spin" />} Pay {dollars(seats * price)}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
