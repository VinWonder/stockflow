import { useEffect, useState } from 'react';
import { Check, ChevronsUpDown, Truck } from 'lucide-react';

import { api } from '../lib/api';
import { useMe } from '../lib/auth';
import { apiDate, money, numericInput, toD, uuid } from '../lib/format';
import { canManage, newLine, type Doc, type LineDraft, type Location, type Supplier } from '../lib/models';
import { useLocations, useRefreshEverything } from '../lib/queries';
import { colors } from '../lib/theme';
import { BottomActions, Card, Field, SectionTitle, Spinner, TopBar, useBack } from '../ui/common';
import { LinesEditor, linesPayload } from '../ui/LinesEditor';
import { useOverlay } from '../ui/overlay';
import { LocationField, usePickLocation, usePickSupplier, usePickVariant } from '../ui/pickers';

/** Goods received from a supplier: supplier, date, invoice, items with size/colour, quantity, cost, amount paid. */
export function ReceiveScreen({ locationId }: { locationId: number | null }) {
  const me = useMe();
  const back = useBack();
  const overlay = useOverlay();
  const refresh = useRefreshEverything();
  const pickVariant = usePickVariant();
  const pickLocation = usePickLocation();
  const pickSupplier = usePickSupplier();
  const locations = useLocations().data;
  const mine = (locations ?? []).filter((l) => canManage(me, l.id));
  const [clientUuid] = useState(uuid);
  const [location, setLocation] = useState<Location | null>(null);
  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [date, setDate] = useState(apiDate(new Date()));
  const [invoice, setInvoice] = useState('');
  const [paid, setPaid] = useState('0');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (location || locationId == null || !locations) return;
    setLocation(locations.find((l) => l.id === locationId) ?? null);
  }, [locations, location, locationId]);

  const total = lines.reduce((s, l) => s + l.quantity * l.price, 0);
  const paidNum = toD(paid);

  const addLine = async () => {
    const picked = await pickVariant({ locationId: location?.id });
    if (!picked) return;
    const existing = lines.find((l) => l.variant.id === picked.variant.id);
    setLines(
      existing
        ? lines.map((l) => (l === existing ? { ...l, quantity: l.quantity + 1 } : l))
        : [...lines, newLine(picked.variant, null, toD(picked.variant.cost_price))],
    );
  };

  const submit = async () => {
    if (!location || !supplier) {
      overlay.error('Choose the store and the supplier.');
      return;
    }
    if (!lines.some((l) => l.quantity > 0)) {
      overlay.error('Add at least one product.');
      return;
    }
    setBusy(true);
    try {
      const r = await api.post<Doc>('/receipts/', {
        client_uuid: clientUuid,
        location: location.id,
        supplier: supplier.id,
        supplied_on: date,
        invoice_number: invoice.trim(),
        amount_paid: paidNum.toFixed(2),
        notes: notes.trim(),
        lines: linesPayload(lines, 'unit_cost'),
      });
      refresh();
      overlay.success(`${r.code} received into ${location.name}`);
      back();
    } catch (e) {
      overlay.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page with-actions">
      <TopBar title="Receive delivery" back />
      <div className="stack">
        <LocationField
          label="Receiving store"
          value={location}
          onClick={async () => {
            const l = await pickLocation(mine, 'Where did the goods arrive?');
            if (l) setLocation(l);
          }}
        />
        <Card
          onClick={async () => {
            const s = await pickSupplier();
            if (s) setSupplier(s);
          }}
          style={{ padding: '12px 14px' }}
        >
          <div className="row">
            <span className="avatar"><Truck size={20} /></span>
            <div className="col grow">
              <span className="tiny muted">Supplier</span>
              <span className="bold" style={{ fontSize: 15 }}>{supplier?.name ?? 'Tap to choose or add'}</span>
            </div>
            <ChevronsUpDown size={20} />
          </div>
        </Card>
        <div className="grid-2">
          <Field label="Date supplied">
            <input className="input" type="date" min="2020-01-01" max={apiDate(new Date())} value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Invoice / delivery no.">
            <input className="input" value={invoice} onChange={(e) => setInvoice(e.target.value)} />
          </Field>
        </div>
      </div>

      <SectionTitle>Products supplied</SectionTitle>
      <LinesEditor lines={lines} onChange={setLines} onAdd={addLine} priceMode="cost" />

      <SectionTitle>Payment</SectionTitle>
      <Card>
        <div className="row">
          <span className="bold grow">Total value</span>
          <span className="heavy" style={{ fontSize: 18 }}>{money(total)}</span>
        </div>
        <Field label="Amount paid now (KES)" style={{ marginTop: 12 }}>
          <div className="row" style={{ gap: 8 }}>
            <input className="input grow" inputMode="decimal" value={paid} onFocus={(e) => e.target.select()} onChange={(e) => setPaid(numericInput(e.target.value))} />
            <button type="button" className="btn tonal small" onClick={() => setPaid(total.toFixed(0))}>Paid in full</button>
          </div>
        </Field>
        <div className="bold" style={{ marginTop: 8, color: paidNum >= total ? colors.success : '#C2410C' }}>
          {paidNum >= total && total > 0 ? 'Fully paid' : `Balance owed to supplier: ${money(total - paidNum)}`}
        </div>
      </Card>
      <Field label="Notes (optional)" style={{ marginTop: 12 }}>
        <textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>

      <BottomActions>
        <button className="btn" disabled={busy} onClick={submit}>
          {busy ? <Spinner /> : <Check size={20} />} Receive {lines.length} item{lines.length === 1 ? '' : 's'} into stock
        </button>
      </BottomActions>
    </main>
  );
}
