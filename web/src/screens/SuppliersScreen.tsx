import { useQuery } from '@tanstack/react-query';
import { Phone, Plus, Truck } from 'lucide-react';

import { api } from '../lib/api';
import { apiDate, dateOnly, money, numericInput, toD } from '../lib/format';
import { useMe } from '../lib/auth';
import type { Supplier } from '../lib/models';
import { useRefreshEverything, useSuppliers } from '../lib/queries';
import { BottomActions, Card, EmptyState, ErrorView, Field, LoadingList, SectionTitle, Segmented, Spinner, TopBar } from '../ui/common';
import { useOverlay } from '../ui/overlay';
import { useAddSupplier } from '../ui/pickers';

interface SupplierReceipt {
  id: number;
  code: string;
  invoice_number: string;
  supplied_on: string;
  balance_due: string | number;
  next_payment_date: string | null;
}

export function SuppliersScreen() {
  const list = useSuppliers();
  const overlay = useOverlay();
  const addSupplier = useAddSupplier();

  return (
    <main className="page with-actions">
      <TopBar title="Suppliers" back />
      {list.isPending ? (
        <LoadingList />
      ) : list.isError ? (
        <ErrorView error={list.error} onRetry={() => list.refetch()} />
      ) : list.data.length === 0 ? (
        <EmptyState icon={Truck} title="No suppliers yet" />
      ) : (
        <div className="list">
          {list.data.map((s) => (
            <Card key={s.id}>
              <div className="row">
                <span className="avatar">{s.name[0]?.toUpperCase()}</span>
                <div className="col grow">
                  <span className="heavy">{s.name}</span>
                  {(s.contact_person || s.phone) && <span className="small">{[s.contact_person, s.phone].filter(Boolean).join(' · ')}</span>}
                  <span className="small muted">{s.deliveries} deliveries · {money(s.total_supplied)} supplied{s.product_count ? ` · ${s.product_count} products` : ''}</span>
                  {Number(s.owed ?? 0) > 0 && <span className="small bold" style={{ color: '#C2410C' }}>You owe {money(s.owed)}</span>}
                </div>
                {Number(s.owed ?? 0) > 0 && (
                  <button className="btn tonal small" onClick={() => overlay.open((close) => <SupplierBalanceSheet supplier={s} close={close} />)}>
                    Payments
                  </button>
                )}
                {s.phone && (
                  <a className="icon-btn" href={`tel:${s.phone}`} aria-label={`Call ${s.name}`}>
                    <Phone size={20} />
                  </a>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
      <BottomActions>
        <button
          className="btn"
          onClick={async () => {
            const s = await addSupplier();
            if (s) overlay.success(`${s.name} added`);
          }}
        >
          <Plus size={20} /> Supplier
        </button>
      </BottomActions>
    </main>
  );
}

function SupplierBalanceSheet({ supplier, close }: { supplier: Supplier; close: () => void }) {
  const me = useMe();
  const overlay = useOverlay();
  const refresh = useRefreshEverything();
  const [selected, setSelected] = useState<SupplierReceipt | null>(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<'cash' | 'mpesa' | 'bank' | 'cheque'>('cash');
  const [reference, setReference] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [busy, setBusy] = useState(false);
  const receipts = useQuery({
    queryKey: ['supplier-receipts', supplier.id],
    queryFn: () => api.list<SupplierReceipt>('/receipts/', { supplier: supplier.id, status: 'posted', page_size: 100 }),
  });
  const unpaid = (receipts.data ?? []).filter((r) => toD(r.balance_due) > 0);

  const choose = (receipt: SupplierReceipt) => {
    setSelected(receipt);
    setAmount(toD(receipt.balance_due).toFixed(2));
    setDueDate(receipt.next_payment_date ?? '');
    setMethod('cash');
    setReference('');
  };

  const savePayment = async () => {
    if (!selected || !me.is_admin) return;
    const paid = toD(amount);
    if (paid <= 0 || paid > toD(selected.balance_due)) {
      overlay.error("Enter a payment greater than zero and no more than the remaining balance.");
      return;
    }
    setBusy(true);
    try {
      await api.post(`/receipts/${selected.id}/payment/`, {
        amount: paid.toFixed(2),
        method,
        reference: reference.trim(),
        next_payment_date: paid < toD(selected.balance_due) ? dueDate || null : null,
      });
      refresh();
      overlay.success(`${money(paid)} payment recorded for ${selected.code}.`);
      setSelected(null);
      receipts.refetch();
    } catch (e) {
      overlay.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="scrim" onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="sheet tall" role="dialog" aria-modal="true" aria-label={`${supplier.name} payments`}>
        <div className="handle" />
        <div className="sheet-title">{supplier.name} · supplier balance</div>
        <div className="sheet-body" style={{ padding: 16, flex: 1 }}>
          {receipts.isPending ? <LoadingList /> : receipts.isError ? <ErrorView error={receipts.error} onRetry={() => receipts.refetch()} /> : (
            <>
              <div className="small muted">Outstanding deliveries and their next payment dates.</div>
              {!selected ? (
                <div className="list" style={{ marginTop: 12 }}>
                  {unpaid.length === 0 ? <EmptyState icon={Truck} title="Nothing unpaid" /> : unpaid.map((r) => (
                    <Card key={r.id}>
                      <div className="row">
                        <span className="heavy grow">{r.code}{r.invoice_number ? ` · ${r.invoice_number}` : ''}</span>
                        <span className="heavy">{money(r.balance_due)}</span>
                      </div>
                      <div className="small muted">
                        Supplied {dateOnly(r.supplied_on)}{r.next_payment_date ? ` · Next payment ${dateOnly(r.next_payment_date)}` : ''}
                      </div>
                      {me.is_admin && <button className="btn tonal small block" style={{ marginTop: 8 }} onClick={() => choose(r)}>Record payment</button>}
                    </Card>
                  ))}
                </div>
              ) : (
                <>
                  <button className="btn text small" onClick={() => setSelected(null)}>← All unpaid deliveries</button>
                  <SectionTitle>{selected.code} · Balance {money(selected.balance_due)}</SectionTitle>
                  <Field label="Amount paid now (KES)">
                    <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(numericInput(e.target.value))} />
                  </Field>
                  <Field label="Payment method" style={{ marginTop: 12 }}>
                    <Segmented<'cash' | 'mpesa' | 'bank' | 'cheque'> value={method} onChange={setMethod} options={[
                      { value: 'cash', label: 'Cash' }, { value: 'mpesa', label: 'M-Pesa' },
                      { value: 'bank', label: 'Bank' }, { value: 'cheque', label: 'Cheque' },
                    ]} />
                  </Field>
                  {(method === 'bank' || method === 'mpesa' || method === 'cheque') && (
                    <Field label={method === 'cheque' ? 'Cheque number (optional)' : 'Payment reference (optional)'} style={{ marginTop: 12 }}>
                      <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} />
                    </Field>
                  )}
                  {toD(amount) < toD(selected.balance_due) && (
                    <Field label="Next payment due (optional)" style={{ marginTop: 12 }}>
                      <input className="input" type="date" min={apiDate(new Date())} value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
                    </Field>
                  )}
                  <button className="btn block" style={{ marginTop: 16 }} disabled={busy} onClick={savePayment}>
                    {busy ? <Spinner /> : null} Save payment
                  </button>
                </>
              )}
            </>
          )}
        </div>
        <div style={{ padding: 12 }}><button className="btn outline block" onClick={close}>Close</button></div>
      </div>
    </div>
  );
}
