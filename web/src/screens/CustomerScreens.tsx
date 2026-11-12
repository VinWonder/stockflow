import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { HandCoins, MessageCircle, MessageSquareText, Pencil, Phone, Plus, Search, Users } from 'lucide-react';

import { api } from '../lib/api';
import { useMe } from '../lib/auth';
import { dateOnly, money, numericInput, qty, smsHref, toD } from '../lib/format';
import type { Customer, Sale } from '../lib/models';
import { useCustomers, useCustomerStatement, useRefreshEverything } from '../lib/queries';
import { colors } from '../lib/theme';
import { Card, EmptyState, ErrorView, Field, LoadingList, Pill, SectionTitle, Segmented, Spinner, TopBar } from '../ui/common';
import { Dialog, useOverlay } from '../ui/overlay';

/** Customers, with who owes money on credit and what is overdue. */
export function CustomersScreen() {
  const navigate = useNavigate();
  const overlay = useOverlay();
  const qc = useQueryClient();
  const [owing, setOwing] = useState(true);
  const [term, setTerm] = useState('');
  const list = useCustomers(owing, term);
  const rows = list.data ?? [];
  const totalOwed = rows.reduce((s, c) => s + toD(c.owed), 0);
  const totalOverdue = rows.reduce((s, c) => s + toD(c.overdue), 0);

  const addCustomer = async () => {
    const form = await overlay.open<CustomerDraft>((close) => <CustomerForm close={close} />);
    if (!form) return;
    try {
      await api.post('/customers/', form);
      setOwing(false);
      qc.invalidateQueries({ queryKey: ['customers'] });
      overlay.success('Customer added.');
    } catch (error) {
      overlay.error(error);
    }
  };

  return (
    <main className="page">
      <TopBar title="Customers & credit" back>
        <button className="icon-btn tonal" aria-label="Add customer" title="Add customer" onClick={addCustomer}><Plus size={20} /></button>
      </TopBar>
      <Segmented<'owing' | 'all'>
        value={owing ? 'owing' : 'all'}
        onChange={(v) => setOwing(v === 'owing')}
        options={[{ value: 'owing', label: 'Owing money' }, { value: 'all', label: 'All customers' }]}
      />
      <div className="input-wrap" style={{ marginTop: 10 }}>
        <Search size={20} />
        <input className="input" type="search" placeholder="Name or phone" value={term} onChange={(e) => setTerm(e.target.value)} />
      </div>
      {owing && rows.length > 0 && (
        <div className="grid-2" style={{ marginTop: 12 }}>
          <Card><div className="tiny muted">Total owed</div><div className="kpi-value" style={{ marginTop: 4 }}>{money(totalOwed)}</div></Card>
          <Card><div className="tiny muted">Overdue</div><div className="kpi-value" style={{ marginTop: 4, color: totalOverdue > 0 ? colors.danger : undefined }}>{money(totalOverdue)}</div></Card>
        </div>
      )}
      <div style={{ paddingTop: 12 }}>
        {list.isPending ? (
          <LoadingList />
        ) : list.isError ? (
          <ErrorView error={list.error} onRetry={() => list.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState icon={owing ? HandCoins : Users} title={owing ? 'Nobody owes you money' : 'No customers yet'} message={owing ? 'Credit sales appear here until they are paid.' : 'Add customers here, or they will be saved when you sell on credit.'} action={!owing ? 'Add customer' : undefined} onAction={!owing ? addCustomer : undefined} />
        ) : (
          <div className="list">
            {rows.map((c) => (
              <Card key={c.id} onClick={() => navigate(`/customers/${c.id}`)}>
                <div className="row">
                  <span className="avatar">{c.name[0]?.toUpperCase()}</span>
                  <div className="col grow">
                    <span className="heavy">{c.name}</span>
                    <span className="small muted">{c.phone ? `+${c.phone}` : 'No phone'}{toD(c.credit_limit) > 0 ? ` · limit ${money(c.credit_limit)}` : ''}</span>
                  </div>
                  <div className="col right">
                    <span className="heavy" style={{ color: toD(c.owed) > 0 ? colors.amber : undefined }}>{money(c.owed)}</span>
                    {toD(c.overdue) > 0 && <Pill text={`${money(c.overdue)} overdue`} color={colors.danger} />}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

interface CustomerDraft {
  name: string;
  phone: string;
  credit_limit: string;
  notes: string;
}

function CustomerForm({ customer, close }: { customer?: Customer; close: (value?: CustomerDraft) => void }) {
  const overlay = useOverlay();
  const [name, setName] = useState(customer?.name ?? '');
  const [phone, setPhone] = useState(customer?.phone ? `0${customer.phone.slice(3)}` : '');
  const [limit, setLimit] = useState(String(customer?.credit_limit ?? '0'));
  const [notes, setNotes] = useState(customer?.notes ?? '');

  const submit = () => {
    if (!name.trim()) return overlay.error('Enter the customer name.');
    if (toD(limit) < 0) return overlay.error('Credit limit cannot be negative.');
    close({ name: name.trim(), phone: phone.trim(), credit_limit: toD(limit).toFixed(2), notes: notes.trim() });
  };

  return (
    <Dialog
      onClose={() => close()}
      title={customer ? 'Edit customer details' : 'Add customer'}
      actions={
        <>
          <button className="btn text" onClick={() => close()}>Cancel</button>
          <button className="btn small" onClick={submit}>{customer ? 'Save details' : 'Add customer'}</button>
        </>
      }
    >
      <div className="stack">
        <Field label="Customer name">
          <input className="input" autoFocus={!customer} autoCapitalize="words" value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Phone (optional)">
          <input className="input" type="tel" value={phone} onChange={(event) => setPhone(event.target.value)} />
        </Field>
        <Field label="Credit limit (KES; 0 means no limit)">
          <input className="input" inputMode="decimal" value={limit} onChange={(event) => setLimit(numericInput(event.target.value))} />
        </Field>
        <Field label="Notes (optional)">
          <textarea className="input" rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

function PaymentDialog({ sale, close }: { sale: Sale; close: (v?: { amount: string; method: string; reference: string }) => void }) {
  const [amount, setAmount] = useState(String(Math.round(toD(sale.balance))));
  const [method, setMethod] = useState<'cash' | 'mpesa' | 'bank'>('cash');
  const [reference, setReference] = useState('');
  return (
    <Dialog
      onClose={() => close()}
      title={`Payment for ${sale.code}`}
      actions={
        <>
          <button className="btn text" onClick={() => close()}>Cancel</button>
          <button className="btn small" onClick={() => close({ amount, method, reference })}>Record</button>
        </>
      }
    >
      <div className="stack">
        <p className="small" style={{ margin: 0 }}>Still owed: <b>{money(sale.balance)}</b></p>
        <Field label="Amount received">
          <input className="input" autoFocus inputMode="decimal" value={amount} onFocus={(e) => e.target.select()} onChange={(e) => setAmount(numericInput(e.target.value))} />
        </Field>
        <Segmented<'cash' | 'mpesa' | 'bank'>
          value={method}
          onChange={setMethod}
          options={[{ value: 'cash', label: 'Cash' }, { value: 'mpesa', label: 'M-Pesa' }, { value: 'bank', label: 'Bank' }]}
        />
        {method !== 'cash' && (
          <Field label={method === 'mpesa' ? 'M-Pesa code' : 'Reference'}>
            <input className="input" autoCapitalize="characters" value={reference} onChange={(e) => setReference(e.target.value.toUpperCase())} />
          </Field>
        )}
      </div>
    </Dialog>
  );
}

export function CustomerScreen({ id }: { id: number }) {
  const me = useMe();
  const overlay = useOverlay();
  const qc = useQueryClient();
  const refresh = useRefreshEverything();
  const data = useCustomerStatement(id);
  const [busy, setBusy] = useState(false);

  const pay = async (sale: Sale) => {
    const v = await overlay.open<{ amount: string; method: string; reference: string }>((close) => <PaymentDialog sale={sale} close={close} />);
    if (!v) return;
    setBusy(true);
    try {
      await api.post(`/sales/${sale.id}/pay/`, v);
      refresh();
      overlay.success(`${money(v.amount)} recorded`);
    } catch (e) {
      overlay.error(e);
    } finally {
      setBusy(false);
    }
  };

  const editDetails = async (c: Customer) => {
    const form = await overlay.open<CustomerDraft>((close) => <CustomerForm customer={c} close={close} />);
    if (!form) return;
    try {
      await api.patch(`/customers/${c.id}/`, form);
      qc.invalidateQueries({ queryKey: ['customer', id] });
      qc.invalidateQueries({ queryKey: ['customers'] });
      overlay.success('Customer details saved.');
    } catch (e) {
      overlay.error(e);
    }
  };

  if (data.isPending) return <main className="page"><TopBar title="Customer" back /><LoadingList /></main>;
  if (data.isError) return <main className="page"><TopBar title="Customer" back /><ErrorView error={data.error} onRetry={() => data.refetch()} /></main>;
  const { customer: c, sales } = data.data;
  const open = sales.filter((s) => s.status === 'completed' && toD(s.balance) > 0);
  const remind = (cust: Customer, unpaid: Sale[]) =>
    overlay.open((close) => <ReminderDialog customer={cust} unpaid={unpaid} close={close} />);
  const closed = sales.filter((s) => !open.includes(s));
  const today = new Date().toISOString().slice(0, 10);

  return (
    <main className="page">
      <TopBar title={c.name} back />
      <Card>
        <div className="row">
          <div className="col grow">
            <span className="small muted">Owes</span>
            <span style={{ fontSize: 28, fontWeight: 800, color: toD(c.owed) > 0 ? colors.amber : colors.success }}>{money(c.owed)}</span>
            {toD(c.overdue) > 0 && <span className="small bold" style={{ color: colors.danger }}>{money(c.overdue)} overdue</span>}
          </div>
          {c.phone && (
            <>
              <a className="icon-btn tonal" href={`tel:+${c.phone}`} aria-label="Call"><Phone size={20} /></a>
              {toD(c.owed) > 0 && (
                <button className="icon-btn tonal" aria-label="Send payment reminder" title="Send payment reminder" onClick={() => remind(c, open)}>
                  <MessageCircle size={20} />
                </button>
              )}
            </>
          )}
          {me.is_admin && (
            <button className="icon-btn tonal" aria-label="Edit customer details" title="Edit customer details" onClick={() => editDetails(c)}>
              <Pencil size={18} />
            </button>
          )}
        </div>
        <div className="row small" style={{ marginTop: 10 }}>
          <span className="grow">Credit limit: <b>{toD(c.credit_limit) > 0 ? money(c.credit_limit) : 'none'}</b></span>
        </div>
        {c.notes && <p className="small muted" style={{ margin: '10px 0 0' }}>{c.notes}</p>}
      </Card>

      <SectionTitle>Unpaid ({open.length})</SectionTitle>
      <div className="list">
        {open.length === 0 && <p className="muted small">Nothing unpaid.</p>}
        {open.map((s) => (
          <SaleCard key={s.id} s={s} overdue={!!s.due_date && s.due_date < today} onPay={() => pay(s)} busy={busy} />
        ))}
      </div>
      {closed.length > 0 && (
        <>
          <SectionTitle>History</SectionTitle>
          <div className="list">
            {closed.map((s) => (
              <SaleCard key={s.id} s={s} />
            ))}
          </div>
        </>
      )}
    </main>
  );
}

function SaleCard({ s, overdue, onPay, busy }: { s: Sale; overdue?: boolean; onPay?: () => void; busy?: boolean }) {
  return (
    <Card>
      <div className="row">
        <span className="heavy grow">{s.code}</span>
        {s.status === 'void' ? <Pill text="Voided" color={colors.slate} /> : overdue ? <Pill text={`Due ${dateOnly(s.due_date)}`} color={colors.danger} /> : s.due_date && toD(s.balance) > 0 ? <Pill text={`Due ${dateOnly(s.due_date)}`} color={colors.amber} /> : null}
      </div>
      <div className="small muted">{dateOnly(s.created_at)} · {s.location_name} · {s.lines.map((l) => `${l.variant_label} ×${qty(l.quantity)}`).join(', ')}</div>
      <div className="row" style={{ marginTop: 8 }}>
        <span className="grow small">Total {money(s.total)} · paid {money(s.amount_paid)}</span>
        {toD(s.balance) > 0 && <span className="heavy" style={{ color: colors.amber }}>{money(s.balance)}</span>}
      </div>
      {s.payments.length > 1 && (
        <div className="tiny muted" style={{ marginTop: 6 }}>
          {s.payments.map((p) => `${dateOnly(p.created_at)} ${p.method_label} ${money(p.amount)}${p.reference ? ` (${p.reference})` : ''}`).join(' · ')}
        </div>
      )}
      {onPay && (
        <button className="btn tonal small block" style={{ marginTop: 10 }} disabled={busy} onClick={onPay}>
          {busy ? <Spinner /> : <HandCoins size={18} />} Record payment
        </button>
      )}
    </Card>
  );
}

/** Payment reminder for a customer who owes money: shown first so it can be edited, then sent by SMS or WhatsApp. */
function ReminderDialog({ customer, unpaid, close }: { customer: Customer; unpaid: Sale[]; close: () => void }) {
  const me = useMe();
  const biz = me.business;
  const today = new Date().toISOString().slice(0, 10);
  const lines = unpaid.slice(0, 5).map((s) => {
    const due = s.due_date ? (s.due_date < today ? `was due ${dateOnly(s.due_date)}` : `due ${dateOnly(s.due_date)}`) : '';
    return `- ${dateOnly(s.created_at)} (${s.code}): ${money(s.balance)}${due ? `, ${due}` : ''}`;
  });
  const how = biz?.mpesa_shortcode ? `Pay by M-Pesa to ${biz.mpesa_shortcode} or at our shop.` : 'You can pay at our shop or by M-Pesa.';
  const [text, setText] = useState(
    [
      `Hello ${customer.name.split(' ')[0]}, this is ${biz?.name ?? 'your hardware shop'}.`,
      `Your account balance is ${money(customer.owed)}${toD(customer.overdue) > 0 ? `, of which ${money(customer.overdue)} is overdue` : ''}:`,
      ...lines,
      how,
      `Thank you for buying with us.${biz?.phone ? ` Questions: ${biz.phone}` : ''}`,
    ].join('\n'),
  );
  const phone = customer.phone;
  return (
    <Dialog onClose={close} title={`Remind ${customer.name}`} actions={<button className="btn text" onClick={close}>Close</button>}>
      <textarea className="input" rows={9} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row" style={{ marginTop: 12, gap: 8 }}>
        <a className="btn grow" href={smsHref(phone, text)}>
          <MessageSquareText size={20} /> SMS
        </a>
        <a className="btn whatsapp grow" href={`https://wa.me/${phone}?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer">
          <MessageCircle size={20} /> WhatsApp
        </a>
      </div>
      <p className="tiny muted" style={{ margin: '8px 0 0' }}>Opens your phone's SMS app or WhatsApp with the message ready. Sent at your normal rates.</p>
    </Dialog>
  );
}
