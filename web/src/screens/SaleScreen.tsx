import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Banknote, CircleCheck, Clock, KeyRound, Loader, Search, Send, Smartphone, TriangleAlert, UserPlus, XCircle } from 'lucide-react';

import { api } from '../lib/api';
import { useMe } from '../lib/auth';
import { apiDate, money, numericInput, qty, toD, uuid } from '../lib/format';
import { newLine, type Customer, type Json, type LineDraft, type Location, type StockLevel } from '../lib/models';
import { LIVE_MS, useConfig, useCustomers, useLocations, useRefreshEverything } from '../lib/queries';
import { alpha, colors } from '../lib/theme';
import { BottomActions, Card, Field, Pill, SectionTitle, Segmented, Spinner, TopBar } from '../ui/common';
import { LinesEditor, linesPayload } from '../ui/LinesEditor';
import { Dialog, Sheet, useConfirm, useOverlay } from '../ui/overlay';
import { LocationField, usePickLocation, usePickVariant } from '../ui/pickers';

type Payment = 'cash' | 'mpesa' | 'credit';
type MpesaMode = 'prompt' | 'code';
interface StkState {
  id: number;
  status: 'pending' | 'success' | 'failed' | 'cancelled';
  receipt_number: string;
  result_desc: string;
  amount: string;
}

const MPESA_CODE = /^[A-Z0-9]{10}$/;
const phoneOk = (p: string) => p.replace(/\D/g, '').length >= 9;
const in14Days = () => apiDate(new Date(Date.now() + 14 * 86400000));

/** Point of sale for any store where selling is switched on. Stock is checked live while the cart is open. */
export function SaleScreen({ locationId }: { locationId: number | null }) {
  const me = useMe();
  const overlay = useOverlay();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const refresh = useRefreshEverything();
  const pickVariant = usePickVariant();
  const pickLocation = usePickLocation();
  const config = useConfig().data;
  const stores = (useLocations().data ?? []).filter((l) => l.is_active !== false);
  const sellable = stores.filter((l) => l.can_sell);
  const [clientUuid, setClientUuid] = useState(uuid);
  const [shop, setShop] = useState<Location | null>(null);
  const [cart, setCart] = useState<LineDraft[]>([]);
  const [payment, setPayment] = useState<Payment>('cash');
  const [mpesaMode, setMpesaMode] = useState<MpesaMode>('prompt');
  const [mpesaCode, setMpesaCode] = useState('');
  const [stk, setStk] = useState<StkState | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [phone, setPhone] = useState('');
  const [discount, setDiscount] = useState('0');
  const [tendered, setTendered] = useState('');
  const [deposit, setDeposit] = useState('0');
  const [due, setDue] = useState(in14Days);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (shop || sellable.length === 0) return;
    setShop(sellable.find((l) => l.id === locationId) ?? sellable.find((l) => l.is_main) ?? sellable[0]);
  }, [sellable, shop, locationId]);

  // Live stock for what's in the cart: other tills may be selling the same items.
  const ids = cart.map((l) => l.variant.id).join(',');
  const live = useQuery({
    queryKey: ['stock', shop?.id, 'cart', ids],
    queryFn: () => api.list<StockLevel>('/stock/', { location: shop!.id, page_size: 500 }),
    enabled: shop != null && cart.length > 0,
    refetchInterval: LIVE_MS,
  }).data;
  useEffect(() => {
    if (!live) return;
    const byId = new Map(live.map((s) => [s.variant.id, toD(s.quantity)]));
    setCart((prev) => {
      let changed = false;
      const next = prev.map((l) => {
        const a = byId.get(l.variant.id) ?? 0;
        if (a !== l.available) changed = true;
        return a === l.available ? l : { ...l, available: a };
      });
      return changed ? next : prev;
    });
  }, [live]);

  const subtotal = cart.reduce((s, l) => s + l.quantity * l.price, 0);
  const total = Math.max(0, subtotal - toD(discount));
  const change = toD(tendered) - total;
  const owedBefore = toD(customer?.owed);
  const limit = toD(customer?.credit_limit);
  const creditAfter = owedBefore + total - toD(deposit);
  const overLimit = payment === 'credit' && limit > 0 && creditAfter > limit;
  const over = cart.find((l) => l.available != null && l.quantity > l.available);

  const chooseShop = async () => {
    const l = await pickLocation(stores, {
      title: 'Sell from which store?',
      note: (x) => (x.can_sell ? null : me.is_admin ? 'Selling off — tap to switch on' : 'Selling switched off'),
      disabled: (x) => !x.can_sell && !me.is_admin,
    });
    if (!l) return;
    if (!l.can_sell) {
      const ok = await confirm({
        title: `Sell from ${l.name}?`,
        message: `Selling is switched off at ${l.name}. Switch it on so staff can sell straight from this ${l.kind === 'godown' ? 'godown' : 'shop'}?`,
        confirm: 'Switch on',
      });
      if (!ok) return;
      try {
        await api.patch(`/locations/${l.id}/`, { can_sell: true });
        qc.invalidateQueries({ queryKey: ['locations'] });
        l.can_sell = true;
      } catch (e) {
        overlay.error(e);
        return;
      }
    }
    setShop(l);
    if (cart.length) overlay.success(`Now selling from ${l.name}. Stock re-checked for your cart.`);
  };

  const add = async () => {
    if (!shop) return;
    const picked = await pickVariant({ locationId: shop.id, inStockOnly: true });
    if (!picked) return;
    const existing = cart.find((l) => l.variant.id === picked.variant.id);
    setCart(existing ? cart.map((l) => (l === existing ? { ...l, quantity: l.quantity + 1 } : l)) : [...cart, newLine(picked.variant, picked.available)]);
  };

  const pickCustomer = async () => {
    const c = await overlay.open<Customer | 'new'>((close) => <CustomerSheet close={close} />);
    if (!c) return;
    if (c === 'new') {
      setCustomer(null);
      return;
    }
    setCustomer(c);
    setCustomerName(c.name);
    setPhone(c.phone ? `0${c.phone.slice(3)}` : '');
  };

  const reset = () => {
    setCart([]);
    setCustomer(null);
    setCustomerName('');
    setPhone('');
    setMpesaCode('');
    setStk(null);
    setDiscount('0');
    setTendered('');
    setDeposit('0');
    setDue(in14Days());
    setClientUuid(uuid());
  };

  const checkout = async (paidStk?: StkState) => {
    if (over) {
      overlay.error(`${over.variant.label}: only ${qty(over.available)} left at ${shop?.name}.`);
      return;
    }
    if (payment === 'mpesa' && mpesaMode === 'code' && !MPESA_CODE.test(mpesaCode)) {
      overlay.error('Enter the 10-character M-Pesa code from the customer\'s message, e.g. SKL4ABCD12.');
      return;
    }
    if (payment === 'credit') {
      if (!customer && (!customerName.trim() || !phoneOk(phone))) {
        overlay.error("Credit needs the customer's name and phone number.");
        return;
      }
      if (toD(deposit) >= total) {
        overlay.error('The deposit covers the whole bill: choose Cash or M-Pesa instead.');
        return;
      }
    }
    const usedStk = paidStk ?? stk;
    setBusy(true);
    try {
      const r = await api.post<Json>('/sales/', {
        client_uuid: clientUuid,
        location: shop!.id,
        customer: customer?.id ?? null,
        customer_name: customerName.trim(),
        customer_phone: phone.trim(),
        payment_method: payment,
        payment_reference: payment === 'mpesa' && mpesaMode === 'code' ? mpesaCode : '',
        mpesa_payment: payment === 'mpesa' && mpesaMode === 'prompt' ? usedStk?.id : undefined,
        discount: toD(discount).toFixed(2),
        deposit: payment === 'credit' ? toD(deposit).toFixed(2) : undefined,
        due_date: payment === 'credit' ? due : undefined,
        lines: linesPayload(cart, 'unit_price'),
      });
      refresh();
      await overlay.open((close) => (
        <Dialog onClose={() => close()} title={`Sale ${r.code} recorded`} actions={<button className="btn small" autoFocus onClick={() => close()}>New sale</button>}>
          <div style={{ textAlign: 'center' }}>
            <CircleCheck size={48} color={colors.success} />
            <p style={{ margin: '8px 0 0', fontWeight: 700 }}>Total {money(r.total)} · {payment === 'mpesa' ? `M-Pesa ${r.payment_reference}` : payment.toUpperCase()}</p>
            {payment === 'cash' && change > 0 && <p style={{ margin: '4px 0 0' }}>Change: <b>{money(change)}</b></p>}
            {payment === 'credit' && <p style={{ margin: '4px 0 0' }}>{r.customer_name} owes <b>{money(r.balance)}</b> by {r.due_date}</p>}
          </div>
        </Dialog>
      ));
      reset();
    } catch (e) {
      overlay.error(e);
    } finally {
      setBusy(false);
    }
  };

  const mpesaReady = mpesaMode === 'code' ? MPESA_CODE.test(mpesaCode) : stk?.status === 'success';
  const blocked =
    busy || cart.length === 0 || !shop || total <= 0 || !!over ||
    (payment === 'mpesa' && !mpesaReady) ||
    (payment === 'credit' && (overLimit || (!customer && (!customerName.trim() || !phoneOk(phone)))));

  return (
    <main className="page with-actions">
      <TopBar title="Sell" back />
      <LocationField label="Selling from" value={shop} onClick={chooseShop} hint={shop ? `${shop.code} · stock checked live` : undefined} />
      {sellable.length === 0 && (
        <Card style={{ marginTop: 10, background: alpha(colors.amber, 0.12) }}>
          {me.is_admin ? 'Selling is switched off at all your stores. Tap above to choose a store and switch it on.' : 'None of your stores can sell yet. Ask the owner to switch selling on.'}
        </Card>
      )}
      <SectionTitle>Cart</SectionTitle>
      <LinesEditor lines={cart} onChange={setCart} onAdd={add} priceMode="sell" checkAvailable addLabel="Add item" />

      <SectionTitle>Payment</SectionTitle>
      <div className="stack">
        <Segmented<Payment>
          value={payment}
          onChange={(p) => {
            setPayment(p);
            setStk(null);
          }}
          options={[
            { value: 'cash', label: 'Cash', icon: Banknote },
            { value: 'mpesa', label: 'M-Pesa', icon: Smartphone },
            { value: 'credit', label: 'Credit', icon: Clock },
          ]}
        />

        {payment === 'cash' && (
          <Field label="Cash received (optional, to work out change)">
            <input className="input" inputMode="decimal" placeholder={total ? total.toFixed(0) : '0'} value={tendered} onChange={(e) => setTendered(numericInput(e.target.value))} />
            {toD(tendered) > 0 && (
              <div className="bold" style={{ marginTop: 6, color: change >= 0 ? colors.success : colors.danger }}>
                {change >= 0 ? `Give change: ${money(change)}` : `Still short by ${money(-change)}`}
              </div>
            )}
          </Field>
        )}

        {payment === 'mpesa' && (
          <Card>
            <Segmented<MpesaMode>
              value={mpesaMode}
              onChange={(m) => {
                setMpesaMode(m);
                setStk(null);
              }}
              options={[
                { value: 'prompt', label: 'Send prompt', icon: Send },
                { value: 'code', label: 'Enter code', icon: KeyRound },
              ]}
            />
            {mpesaMode === 'code' ? (
              <Field label="M-Pesa confirmation code" style={{ marginTop: 12 }}>
                <input
                  className="input"
                  autoCapitalize="characters"
                  maxLength={10}
                  placeholder="e.g. SKL4ABCD12"
                  style={{ letterSpacing: 2, fontWeight: 800 }}
                  value={mpesaCode}
                  onChange={(e) => setMpesaCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                />
                <span className="tiny muted" style={{ display: 'block', marginTop: 6 }}>
                  {mpesaCode.length === 10 ? 'Check the amount on the customer\'s message matches the total.' : `${mpesaCode.length}/10 characters. Each code can only be used once.`}
                </span>
              </Field>
            ) : (
              <StkPrompt
                shop={shop}
                amount={total}
                phone={phone}
                setPhone={setPhone}
                state={stk}
                setState={setStk}
                simulated={config?.mpesa_simulated ?? true}
                onPaid={(s) => checkout(s)}
              />
            )}
          </Card>
        )}

        {payment === 'credit' && (
          <Card>
            <button className="tile" style={{ padding: '6px 4px' }} onClick={pickCustomer}>
              <span className="avatar">{customer ? customer.name[0]?.toUpperCase() : <UserPlus size={20} />}</span>
              <div className="col grow">
                <span className="bold">{customer ? customer.name : 'Choose a regular customer'}</span>
                <span className="small muted">
                  {customer ? `Owes ${money(customer.owed)}${limit > 0 ? ` · limit ${money(limit)}` : ' · no limit'}` : 'or type a new customer below'}
                </span>
              </div>
            </button>
            {!customer && (
              <div className="grid-2" style={{ marginTop: 8 }}>
                <Field label="Customer name">
                  <input className="input" autoCapitalize="words" value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
                </Field>
                <Field label="Phone">
                  <input className="input" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
                </Field>
              </div>
            )}
            <div className="grid-2" style={{ marginTop: 8 }}>
              <Field label="Deposit paid now (cash)">
                <input className="input" inputMode="decimal" value={deposit} onFocus={(e) => e.target.select()} onChange={(e) => setDeposit(numericInput(e.target.value))} />
              </Field>
              <Field label="Pay by">
                <input className="input" type="date" min={apiDate(new Date())} value={due} onChange={(e) => setDue(e.target.value)} />
              </Field>
            </div>
            <div className="row small" style={{ marginTop: 10, gap: 8, color: overLimit ? colors.danger : undefined }}>
              {overLimit && <TriangleAlert size={18} />}
              <span className="grow">
                {total > 0 ? `${money(total - toD(deposit))} goes on credit` : ''}
                {customer && total > 0 ? `; total owed becomes ${money(creditAfter)}` : ''}
                {overLimit ? `, over the ${money(limit)} limit. Take a bigger deposit.` : '.'}
              </span>
            </div>
          </Card>
        )}

        {payment !== 'credit' && (
          <div className="grid-2">
            <Field label="Customer (optional)">
              <input className="input" autoCapitalize="words" value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
            </Field>
            <Field label="Phone">
              <input className="input" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </Field>
          </div>
        )}
        <Field label="Discount (KES)">
          <input className="input" inputMode="decimal" value={discount} onFocus={(e) => e.target.select()} onChange={(e) => setDiscount(numericInput(e.target.value))} />
        </Field>
        {toD(discount) > subtotal && <span className="small" style={{ color: colors.danger }}>The discount is more than the cart total.</span>}
      </div>
      <BottomActions>
        <button className="btn success" style={{ minHeight: 56, fontSize: 17 }} disabled={blocked || toD(discount) > subtotal} onClick={() => checkout()}>
          {busy ? <Spinner /> : payment === 'credit' ? `Sell on credit · ${money(total)}` : payment === 'mpesa' && mpesaMode === 'prompt' && stk?.status !== 'success' ? `Waiting for M-Pesa · ${money(total)}` : `Charge ${money(total)}`}
        </button>
      </BottomActions>
    </main>
  );
}

/** Send the "enter your M-Pesa PIN" prompt to the customer's phone and watch for the result. */
function StkPrompt({ shop, amount, phone, setPhone, state, setState, simulated, onPaid }: {
  shop: Location | null;
  amount: number;
  phone: string;
  setPhone: (v: string) => void;
  state: StkState | null;
  setState: (s: StkState | null) => void;
  simulated: boolean;
  onPaid: (s: StkState) => void;
}) {
  const overlay = useOverlay();
  const [sending, setSending] = useState(false);
  const timer = useRef<number>();
  const paidFor = useRef<number | null>(null);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // If the cart total changes after a prompt was sent, that prompt no longer matches.
  useEffect(() => {
    if (state && state.status !== 'success' && toD(state.amount) !== Math.round(amount)) setState(null);
  }, [amount]); // eslint-disable-line react-hooks/exhaustive-deps

  const poll = (id: number, tries = 0) => {
    timer.current = window.setTimeout(async () => {
      try {
        const s = await api.get<StkState>(`/mpesa/stk/${id}/`);
        setState(s);
        if (s.status === 'pending' && tries < 60) poll(id, tries + 1);
        else if (s.status === 'success' && paidFor.current !== id) {
          paidFor.current = id;
          onPaid(s);
        }
      } catch {
        if (tries < 60) poll(id, tries + 1);
      }
    }, 3000);
  };

  const send = async () => {
    if (!shop || amount <= 0) return;
    if (!phoneOk(phone)) {
      overlay.error("Enter the customer's M-Pesa phone number.");
      return;
    }
    setSending(true);
    try {
      const s = await api.post<StkState>('/mpesa/stk/', { location: shop.id, phone, amount: Math.round(amount) });
      setState(s);
      if (s.status === 'pending') poll(s.id);
      else if (s.status === 'success') {
        paidFor.current = s.id;
        onPaid(s);
      }
    } catch (e) {
      overlay.error(e);
    } finally {
      setSending(false);
    }
  };

  const failed = state && (state.status === 'failed' || state.status === 'cancelled');
  return (
    <div style={{ marginTop: 12 }}>
      <Field label="Customer's M-Pesa number">
        <div className="row" style={{ gap: 8 }}>
          <input className="input grow" type="tel" placeholder="07xx xxx xxx" value={phone} disabled={state?.status === 'pending'} onChange={(e) => setPhone(e.target.value)} />
          <button className="btn small" disabled={sending || amount <= 0 || state?.status === 'pending' || state?.status === 'success'} onClick={send}>
            {sending ? <Spinner /> : <Send size={18} />} {failed ? 'Resend' : 'Send'}
          </button>
        </div>
      </Field>
      {state?.status === 'pending' && (
        <div className="row small" style={{ marginTop: 10, gap: 8 }}>
          <Loader size={18} className="spinning" /> Prompt sent for {money(state.amount)}. Waiting for the customer to enter their PIN…
        </div>
      )}
      {state?.status === 'success' && (
        <div className="row bold" style={{ marginTop: 10, gap: 8, color: colors.success }}>
          <CircleCheck size={18} /> Paid {money(state.amount)} · {state.receipt_number}
        </div>
      )}
      {failed && (
        <div className="row small" style={{ marginTop: 10, gap: 8, color: colors.danger }}>
          <XCircle size={18} /> {state!.status === 'cancelled' ? 'The customer cancelled or didn\'t answer.' : state!.result_desc || 'Payment failed.'} Try again or enter the code.
        </div>
      )}
      {simulated && <Pill text="Test mode: prompts are marked paid automatically (no real money)" color={colors.amber} />}
    </div>
  );
}

function CustomerSheet({ close }: { close: (c?: Customer | 'new') => void }) {
  const [term, setTerm] = useState('');
  const list = useCustomers(false, term);
  return (
    <Sheet onClose={() => close()} title="Customer" tall>
      <div style={{ padding: '0 16px 8px' }}>
        <div className="input-wrap">
          <Search size={20} />
          <input className="input" autoFocus type="search" placeholder="Name or phone" value={term} onChange={(e) => setTerm(e.target.value)} />
        </div>
      </div>
      <div className="sheet-body" style={{ flex: 1 }}>
        <button className="tile" onClick={() => close('new')}>
          <span className="avatar"><UserPlus size={20} /></span>
          <span className="bold">New customer</span>
        </button>
        {(list.data ?? []).map((c) => (
          <button key={c.id} className="tile" onClick={() => close(c)}>
            <span className="avatar">{c.name[0]?.toUpperCase()}</span>
            <div className="col grow">
              <span className="bold">{c.name}</span>
              <span className="small muted">{c.phone ? `+${c.phone}` : 'No phone'}</span>
            </div>
            {toD(c.owed) > 0 && <Pill text={`owes ${money(c.owed)}`} color={toD(c.overdue) > 0 ? colors.danger : colors.amber} />}
          </button>
        ))}
      </div>
    </Sheet>
  );
}
