import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronsUpDown, Plus, Truck } from 'lucide-react';

import { api } from '../lib/api';
import { useMe } from '../lib/auth';
import { apiDate, money, numericInput, toD, uuid } from '../lib/format';
import { canManage, newLine, type Doc, type LineDraft, type Location, type StockLevel, type Supplier, type Variant } from '../lib/models';
import { useLocations, useRefreshEverything } from '../lib/queries';
import { colors } from '../lib/theme';
import { BottomActions, Card, Field, SectionTitle, Spinner, TopBar, useBack } from '../ui/common';
import { LinesEditor, linesPayload } from '../ui/LinesEditor';
import { useOverlay } from '../ui/overlay';
import { LocationField, usePickLocation, usePickSupplier, usePickVariant } from '../ui/pickers';

/**
 * Goods received from a supplier: who supplied them, which shop or godown they go into (chosen by the admin),
 * the items with size/colour, quantity and buying price, and how much was paid.
 */
export function ReceiveScreen({ locationId }: { locationId: number | null }) {
  const me = useMe();
  const back = useBack();
  const overlay = useOverlay();
  const refresh = useRefreshEverything();
  const pickVariant = usePickVariant();
  const pickLocation = usePickLocation();
  const pickSupplier = usePickSupplier();
  const locations = useLocations().data;
  const mine = (locations ?? []).filter((l) => l.is_active !== false && canManage(me, l.id));
  const [clientUuid] = useState(uuid);
  const [location, setLocation] = useState<Location | null>(null);
  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [date, setDate] = useState(apiDate(new Date()));
  const [invoice, setInvoice] = useState('');
  const [paid, setPaid] = useState('0');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [busy, setBusy] = useState(false);

  const usual = useQuery({
    queryKey: ['supplier-products', supplier?.id],
    queryFn: () => api.get<Variant[]>(`/suppliers/${supplier!.id}/products/`),
    enabled: supplier != null,
  }).data ?? [];

  useEffect(() => {
    if (location || !locations) return;
    setLocation(mine.find((l) => l.id === locationId) ?? mine.find((l) => l.is_main) ?? mine[0] ?? null);
  }, [locations, location, locationId]); // eslint-disable-line react-hooks/exhaustive-deps

  const total = lines.reduce((s, l) => s + l.quantity * l.price, 0);
  const paidNum = toD(paid);

  const stockHere = async (variant: Variant) => {
    if (!location) return null;
    const s = await api.list<StockLevel>('/stock/', { location: location.id, variant: variant.id }).catch(() => []);
    return s.length ? toD(s[0].quantity) : 0;
  };

  const addVariant = async (variant: Variant, available: number | null) => {
    setLines((prev) => {
      const existing = prev.find((l) => l.variant.id === variant.id);
      return existing
        ? prev.map((l) => (l === existing ? { ...l, quantity: l.quantity + 1 } : l))
        : [...prev, { ...newLine(variant, available, toD(variant.cost_price)) }];
    });
  };

  const addLine = async () => {
    const picked = await pickVariant({ locationId: location?.id, supplier, allowCreate: true, showCost: true });
    if (picked) addVariant(picked.variant, picked.available);
  };

  const submit = async () => {
    if (!location || !supplier) {
      overlay.error('Choose the supplier and where the goods go.');
      return;
    }
    if (!lines.some((l) => l.quantity > 0)) {
      overlay.error('Add at least one product.');
      return;
    }
    if (lines.some((l) => l.quantity > 0 && l.price <= 0)) {
      overlay.error('Enter the buying price for every item, so stock value and profit are right.');
      return;
    }
    if (paidNum > total) {
      overlay.error("Amount paid can't be more than the total.");
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
      overlay.success(`${r.code}: ${lines.length} item(s) added to ${location.name}`);
      back();
    } catch (e) {
      overlay.error(e);
    } finally {
      setBusy(false);
    }
  };

  const notAdded = usual.filter((v) => !lines.some((l) => l.variant.id === v.id));

  return (
    <main className="page with-actions">
      <TopBar title="Receive delivery" back />
      <div className="stack">
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
              {supplier?.phone && <span className="tiny muted">{supplier.phone}</span>}
            </div>
            <ChevronsUpDown size={20} />
          </div>
        </Card>
        <LocationField
          label="Put the stock into"
          value={location}
          hint={me.is_admin ? 'Any of your shops or godowns' : undefined}
          onClick={async () => {
            const l = await pickLocation(mine, 'Where are the goods going?');
            if (l) setLocation(l);
          }}
        />
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
      {notAdded.length > 0 && (
        <>
          <p className="small muted" style={{ margin: '0 4px 8px' }}>{supplier!.name} usually brings — tap to add:</p>
          <div className="chip-row" style={{ marginBottom: 10 }}>
            {notAdded.slice(0, 20).map((v) => (
              <button key={v.id} className="choice" onClick={async () => addVariant(v, await stockHere(v))}>
                <Plus size={14} /> {v.product_name}{v.options ? ` ${v.options}` : ''}
              </button>
            ))}
          </div>
        </>
      )}
      <LinesEditor lines={lines} onChange={setLines} onAdd={addLine} priceMode="cost" addLabel={supplier ? 'Find or add a product' : 'Add product'} />

      <SectionTitle>Payment to supplier</SectionTitle>
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
        <button className="btn" disabled={busy || !supplier || !location} onClick={submit}>
          {busy ? <Spinner /> : <Check size={20} />} Receive {lines.length} item{lines.length === 1 ? '' : 's'}
          {location ? ` into ${location.name}` : ''}
        </button>
      </BottomActions>
    </main>
  );
}
