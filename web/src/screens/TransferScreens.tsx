import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeftRight, ArrowRight, ArrowUpDown, Bike, Check, Copy, Footprints, MapPin, MessageCircle, MessageSquareText,
  Navigation, PackageCheck, Phone, Plus, Radio, Send, ShoppingCart, Truck, TriangleAlert, User, type LucideIcon,
} from 'lucide-react';

import { api } from '../lib/api';
import { useMe } from '../lib/auth';
import { ago, copyText, dateTime, numericInput, qty, qtyOut, toD, uuid } from '../lib/format';
import {
  canManage, displayName, isMotor, newLine, vehicles, works, type Doc, type LineDraft, type Location, type StockLevel,
  type Tracking,
} from '../lib/models';
import { useDirectory, useRefreshEverything, useTracking, useTransfer, useTransfers } from '../lib/queries';
import { colors } from '../lib/theme';
import {
  BottomActions, Card, EmptyState, ErrorView, Field, LoadingList, Pill, SectionTitle, Spinner, StatusChip, TopBar,
} from '../ui/common';
import { LinesEditor, linesPayload } from '../ui/LinesEditor';
import { directionsLink, MapView, type Marker } from '../ui/MapView';
import { Sheet, useAskText, useOverlay } from '../ui/overlay';
import { LocationField, usePickLocation, usePickVariant } from '../ui/pickers';

const vehicleIcon: Record<string, LucideIcon> = { motorbike: Bike, tuktuk: Truck, pickup: Truck, lorry: Truck, handcart: ShoppingCart, on_foot: Footprints, other: Truck };
const digits = (v: unknown) => String(v ?? '').replace(/\D/g, '');
const intlPhone = (v: string) => {
  const d = digits(v);
  return d.startsWith('0') && d.length === 10 ? `254${d.slice(1)}` : d;
};

export interface DriverDraft {
  driver_name: string;
  driver_phone: string;
  vehicle_type: string;
  vehicle_reg: string;
}

export const emptyDriver = (): DriverDraft => ({ driver_name: '', driver_phone: '', vehicle_type: '', vehicle_reg: '' });

/** Who is taking the goods and on what: name, phone, tuk-tuk / motorbike and its number plate. */
export function DriverFields({ value, onChange }: { value: DriverDraft; onChange: (v: DriverDraft) => void }) {
  const set = (patch: Partial<DriverDraft>) => onChange({ ...value, ...patch });
  return (
    <div className="stack">
      <div className="grid-2">
        <Field label="Driver / carrier name">
          <input className="input" autoCapitalize="words" placeholder="e.g. Otieno" value={value.driver_name} onChange={(e) => set({ driver_name: e.target.value })} />
        </Field>
        <Field label="Driver's phone">
          <input className="input" type="tel" placeholder="07xx xxx xxx" value={value.driver_phone} onChange={(e) => set({ driver_phone: e.target.value })} />
        </Field>
      </div>
      <Field label="Travelling by">
        <div className="wrap">
          {vehicles.map((v) => {
            const Icon = vehicleIcon[v.value] ?? Truck;
            return (
              <button key={v.value} type="button" className={`choice${value.vehicle_type === v.value ? ' on' : ''}`} onClick={() => set({ vehicle_type: v.value })}>
                <Icon size={16} /> {v.label}
              </button>
            );
          })}
        </div>
      </Field>
      {isMotor(value.vehicle_type) && (
        <Field label="Number plate">
          <input
            className="input"
            autoCapitalize="characters"
            placeholder={value.vehicle_type === 'motorbike' ? 'e.g. KMEA 123B' : value.vehicle_type === 'tuktuk' ? 'e.g. KTWA 456C' : 'e.g. KDA 789X'}
            style={{ textTransform: 'uppercase', fontWeight: 700, letterSpacing: 1 }}
            value={value.vehicle_reg}
            onChange={(e) => set({ vehicle_reg: e.target.value.toUpperCase() })}
          />
        </Field>
      )}
    </div>
  );
}

function driverProblem(d: DriverDraft): string | null {
  if (!d.driver_name.trim()) return 'Enter the name of the person taking the goods.';
  if (digits(d.driver_phone).length < 9) return "Enter the driver's phone number.";
  if (!d.vehicle_type) return 'Choose how the goods are travelling.';
  if (isMotor(d.vehicle_type) && d.vehicle_reg.replace(/\s/g, '').length < 5) return 'Enter the number plate.';
  return null;
}

// ----------------------------------------------------------------------------- list
type ListTab = 'moving' | 'approve' | 'dispatch' | 'done';
const TAB_STATUS: Record<ListTab, string> = { moving: 'in_transit', approve: 'requested', dispatch: 'approved', done: 'received,rejected,cancelled' };

export function TransfersScreen() {
  const me = useMe();
  const navigate = useNavigate();
  const [tab, setTab] = useState<ListTab>('moving');
  const tabs: { id: ListTab; label: string }[] = [
    { id: 'moving', label: 'On the way' },
    { id: 'approve', label: me.is_admin ? 'To approve' : 'Waiting approval' },
    { id: 'dispatch', label: 'To dispatch' },
    { id: 'done', label: 'Done' },
  ];
  return (
    <main className="page with-actions">
      <TopBar title="Transfers" back>
        <span className="row tiny muted" style={{ gap: 6, paddingRight: 8 }}>
          <span className="live-dot on" /> Live
        </span>
      </TopBar>
      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div style={{ paddingTop: 16 }}>
        <TransferList status={TAB_STATUS[tab]} />
      </div>
      <BottomActions>
        <button className="btn" onClick={() => navigate('/transfers/new')}>
          <Plus size={20} /> New transfer
        </button>
      </BottomActions>
    </main>
  );
}

/** List used by the Transfers screen and the Inbox. `status` may be a comma-separated list. */
export function TransferList({ status }: { status: string }) {
  const list = useTransfers(status);
  const navigate = useNavigate();
  if (list.isPending) return <LoadingList />;
  if (list.isError) return <ErrorView error={list.error} onRetry={() => list.refetch()} />;
  if (list.data.length === 0) return <EmptyState icon={ArrowLeftRight} title="No transfers here" />;
  return (
    <div className="list">
      {list.data.map((d) => {
        const Icon = vehicleIcon[d.vehicle_type] ?? Truck;
        return (
          <Card key={d.id} onClick={() => navigate(`/transfers/${d.id}`)}>
            <div className="row">
              <span className="heavy grow">{d.code}</span>
              {d.has_discrepancy && <Pill text="Short" color={colors.danger} icon={TriangleAlert} />}
              <StatusChip status={d.status} label={d.status_label} />
            </div>
            <div style={{ fontWeight: 700, marginTop: 6 }}>{d.source_name} → {d.destination_name}</div>
            <div className="small muted">{d.lines.length} item(s) · {d.lines.map((l) => `${l.sku}×${qty(l.quantity)}`).slice(0, 3).join(', ')}</div>
            {d.driver_name && (
              <div className="row small" style={{ gap: 6, marginTop: 6 }}>
                <Icon size={15} /> {d.driver_name}{d.vehicle_reg ? ` · ${d.vehicle_reg}` : ''}
                {d.status === 'in_transit' && (
                  <span className="muted">
                    {' · '}{d.arrived_near_at ? 'arriving now' : d.last_seen ? `seen ${ago(d.last_seen.at)}` : 'no GPS yet'}
                  </span>
                )}
              </div>
            )}
            <div className="tiny muted" style={{ marginTop: 4 }}>{ago(d.dispatched_at ?? d.created_at)}</div>
          </Card>
        );
      })}
    </div>
  );
}

// ----------------------------------------------------------------------------- new
export function NewTransferScreen({ sourceId, destinationId, variantId }: { sourceId: number | null; destinationId: number | null; variantId: number | null }) {
  const me = useMe();
  const navigate = useNavigate();
  const overlay = useOverlay();
  const refresh = useRefreshEverything();
  const pickVariant = usePickVariant();
  const pickLocation = usePickLocation();
  const all = useDirectory().data;
  const [clientUuid] = useState(uuid);
  const [from, setFrom] = useState<Location | null>(null);
  const [to, setTo] = useState<Location | null>(null);
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [notes, setNotes] = useState('');
  const [driver, setDriver] = useState<DriverDraft>(emptyDriver);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!all || ready) return;
    setReady(true);
    (async () => {
      const dest = all.find((l) => l.id === destinationId) ?? null;
      let src = all.find((l) => l.id === sourceId) ?? null;
      if (variantId) {
        // Restocking one item: take it from the store that has the most of it.
        const levels = await api.list<StockLevel>('/stock/', { variant: variantId, in_stock: 1 }).catch(() => []);
        const best = levels.filter((l) => l.location !== dest?.id).sort((a, b) => toD(b.quantity) - toD(a.quantity))[0];
        if (!src && best) src = all.find((l) => l.id === best.location) ?? null;
        if (best && src?.id === best.location) setLines([newLine(best.variant, toD(best.quantity))]);
        else if (!best) overlay.error('No other store has this item in stock. Receive a delivery instead.');
      }
      src ??= all.find((l) => l.kind === 'godown' && l.id !== dest?.id) ?? null;
      setFrom(src);
      setTo(dest ?? all.find((l) => l.is_main && l.id !== src?.id) ?? null);
    })();
  }, [all, ready, sourceId, destinationId, variantId]); // eslint-disable-line react-hooks/exhaustive-deps

  const seeStock = from != null && works(me, from.id);

  const addLine = async () => {
    if (!from) {
      overlay.error('Choose where the goods come from first.');
      return;
    }
    const picked = await pickVariant(seeStock ? { locationId: from.id, inStockOnly: true } : {});
    if (!picked || lines.some((l) => l.variant.id === picked.variant.id)) return;
    setLines([...lines, newLine(picked.variant, picked.available)]);
  };

  const submit = async () => {
    if (!from || !to || from.id === to.id) {
      overlay.error('Choose two different stores.');
      return;
    }
    const over = lines.find((l) => l.available != null && l.quantity > l.available);
    if (over) {
      overlay.error(`${over.variant.label}: only ${qty(over.available)} at ${from.name}.`);
      return;
    }
    const anyDriver = driver.driver_name || driver.driver_phone || driver.vehicle_type;
    if (anyDriver && isMotor(driver.vehicle_type) && driver.vehicle_reg && driver.vehicle_reg.replace(/\s/g, '').length < 5) {
      overlay.error('That number plate looks too short.');
      return;
    }
    setBusy(true);
    try {
      const r = await api.post<Doc>('/transfers/', {
        client_uuid: clientUuid,
        source: from.id,
        destination: to.id,
        notes: notes.trim(),
        ...driver,
        lines: linesPayload(lines),
      });
      refresh();
      overlay.success(r.status === 'approved' ? `${r.code} ready to dispatch` : `${r.code} sent to the owner for approval`);
      navigate(`/transfers/${r.id}`, { replace: true });
    } catch (e) {
      overlay.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page with-actions">
      <TopBar title="New transfer" back />
      <LocationField
        label="From"
        value={from}
        onClick={async () => {
          const l = await pickLocation((all ?? []).filter((x) => x.id !== to?.id), 'Send from');
          if (l) {
            setFrom(l);
            setLines([]);
          }
        }}
      />
      <div style={{ display: 'flex', justifyContent: 'center', margin: '6px 0' }}>
        <button
          className="icon-btn tonal"
          aria-label="Swap"
          title="Swap"
          onClick={() => {
            setFrom(to);
            setTo(from);
            setLines([]);
          }}
        >
          <ArrowUpDown size={20} />
        </button>
      </div>
      <LocationField
        label="To"
        value={to}
        onClick={async () => {
          const l = await pickLocation((all ?? []).filter((x) => x.id !== from?.id), 'Send to');
          if (l) setTo(l);
        }}
      />
      {!me.is_admin && <p className="small" style={{ margin: '10px 4px 0' }}>The owner approves this transfer before it can be dispatched.</p>}
      <SectionTitle>Products</SectionTitle>
      {!seeStock && from && <p className="small muted" style={{ margin: '0 4px 8px' }}>You don't work at {from.name}, so its stock isn't shown. The owner checks it on approval.</p>}
      <LinesEditor lines={lines} onChange={setLines} onAdd={addLine} checkAvailable />

      <SectionTitle>Who is taking the goods?</SectionTitle>
      <Card>
        <p className="small muted" style={{ margin: '0 0 12px' }}>Fill in now or when dispatching. Needed before the goods leave.</p>
        <DriverFields value={driver} onChange={setDriver} />
      </Card>
      <Field label="Notes (optional)" style={{ marginTop: 12 }}>
        <textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <BottomActions>
        <button className="btn" disabled={busy || lines.length === 0} onClick={submit}>
          {busy ? <Spinner /> : <Send size={20} />} {me.is_admin ? 'Create transfer' : 'Request transfer'}
        </button>
      </BottomActions>
    </main>
  );
}

// ----------------------------------------------------------------------------- dispatch sheet
function DispatchSheet({ d, close }: { d: Doc; close: (v?: DriverDraft & { notify_driver: boolean }) => void }) {
  const overlay = useOverlay();
  const [driver, setDriver] = useState<DriverDraft>({
    driver_name: d.driver_name ?? '',
    driver_phone: d.driver_phone ? `0${String(d.driver_phone).slice(3)}` : '',
    vehicle_type: d.vehicle_type ?? '',
    vehicle_reg: d.vehicle_reg ?? '',
  });
  const [notify, setNotify] = useState(true);
  return (
    <Sheet onClose={() => close()} title={`Dispatch ${d.code}`} tall>
      <div className="sheet-body stack" style={{ flex: 1 }}>
        <Card style={{ background: 'var(--primary-soft)' }}>
          <div className="bold">{d.source_name} → {d.destination_name}</div>
          <div className="small">{d.lines.map((l) => `${l.variant_label} × ${qty(l.quantity)}`).join(', ')}</div>
          <div className="small muted" style={{ marginTop: 6 }}>Stock leaves {d.source_name} now. {d.destination_name} is told the goods are on the way.</div>
        </Card>
        <DriverFields value={driver} onChange={setDriver} />
        <label className="switch-row">
          <div className="col grow">
            <span className="bold">Send the tracking link to the driver</span>
            <span className="small muted">By SMS. The driver opens it so you can follow the goods on the map.</span>
          </div>
          <input type="checkbox" hidden checked={notify} onChange={(e) => setNotify(e.target.checked)} />
          <span className={`switch${notify ? ' on' : ''}`} aria-hidden="true" />
        </label>
      </div>
      <div style={{ padding: '8px 12px 12px' }}>
        <button
          className="btn block"
          onClick={() => {
            const problem = driverProblem(driver);
            if (problem) overlay.error(problem);
            else close({ ...driver, notify_driver: notify });
          }}
        >
          <Truck size={20} /> Dispatch now
        </button>
      </div>
    </Sheet>
  );
}

// ----------------------------------------------------------------------------- detail
/** Transfer detail with a status timeline, driver, live map, and the right button for the right person at each step. */
export function TransferDetailScreen({ id }: { id: number }) {
  const me = useMe();
  const overlay = useOverlay();
  const refresh = useRefreshEverything();
  const askText = useAskText();
  const t = useTransfer(id);
  const [busy, setBusy] = useState(false);
  const [received, setReceived] = useState<Record<number, string>>({});

  const act = async (action: string, done: string, body: object = {}) => {
    setBusy(true);
    try {
      await api.post(`/transfers/${id}/${action}/`, body);
      refresh();
      overlay.success(done);
    } catch (e) {
      overlay.error(e);
    } finally {
      setBusy(false);
    }
  };

  const d = t.data;
  const buttons: JSX.Element[] = [];
  if (d) {
    if (d.status === 'requested' && me.is_admin) {
      buttons.push(
        <button key="reject" className="btn outline" disabled={busy} onClick={async () => {
          const reason = await askText({ title: 'Reject transfer', hint: 'Reason', confirm: 'Reject' });
          if (reason != null) act('reject', 'Transfer rejected', { reason });
        }}>
          Reject
        </button>,
        <button key="approve" className="btn" disabled={busy} onClick={() => act('approve', 'Approved. The store has been told to dispatch.')}>
          Approve
        </button>,
      );
    }
    if (d.status === 'approved' && canManage(me, d.source)) {
      buttons.push(
        <button key="dispatch" className="btn" disabled={busy} onClick={async () => {
          const driver = await overlay.open<DriverDraft & { notify_driver: boolean }>((close) => <DispatchSheet d={d} close={close} />);
          if (driver) act('dispatch', `Dispatched with ${driver.driver_name}. ${d.destination_name} has been notified.`, driver);
        }}>
          <Truck size={20} /> Dispatch
        </button>,
      );
    }
    if (d.status === 'in_transit' && works(me, d.destination)) {
      buttons.push(
        <button key="receive" className="btn" disabled={busy} onClick={() => {
          const quantities = Object.fromEntries(d.lines.map((l) => {
            const v = received[l.id] ?? qtyOut(toD(l.quantity));
            return [String(l.id), v === '' ? '0' : v];
          }));
          act('receive', `Received into ${d.destination_name}`, { quantities });
        }}>
          <PackageCheck size={20} /> Confirm received
        </button>,
      );
    }
    const mayCancel = (d.status === 'requested' || d.status === 'approved') && (me.is_admin || d.people?.requested_by === displayName(me));
    if (mayCancel && buttons.length < 2) {
      buttons.unshift(
        <button key="cancel" className="btn text" disabled={busy} onClick={() => act('cancel', 'Transfer cancelled')}>
          Cancel
        </button>,
      );
    }
  }

  return (
    <main className={`page${buttons.length ? ' with-actions' : ''}`}>
      <TopBar title={d?.code ?? 'Transfer'} back />
      {t.isPending ? (
        <LoadingList count={4} />
      ) : t.isError ? (
        <ErrorView error={t.error} onRetry={() => t.refetch()} />
      ) : (
        <TransferBody d={t.data} receiving={t.data.status === 'in_transit' && works(me, t.data.destination)} received={received} setReceived={setReceived} />
      )}
      {buttons.length > 0 && <BottomActions>{buttons}</BottomActions>}
    </main>
  );
}

function TransferBody({ d, receiving, received, setReceived }: {
  d: Doc;
  receiving: boolean;
  received: Record<number, string>;
  setReceived: (v: Record<number, string>) => void;
}) {
  const me = useMe();
  const overlay = useOverlay();
  const refresh = useRefreshEverything();
  const p = d.people ?? {};
  const steps = [
    { title: 'Requested', who: p.requested_by, when: d.created_at, done: true },
    { title: 'Approved', who: p.approved_by, when: d.approved_at, done: d.approved_at != null },
    { title: 'Dispatched', who: [p.dispatched_by, d.driver_name ? `carried by ${d.driver_name}` : null].filter(Boolean).join(', '), when: d.dispatched_at, done: d.dispatched_at != null },
    { title: d.arrived_near_at && !d.received_at ? 'Arriving now' : 'Received', who: p.received_by, when: d.received_at ?? d.arrived_near_at, done: d.received_at != null },
  ];
  const editable = ['requested', 'approved', 'in_transit'].includes(d.status) && canManage(me, d.source);

  const editDriver = async () => {
    const v = await overlay.open<DriverDraft & { notify_driver: boolean }>((close) => <DispatchSheet d={d} close={close} />);
    if (!v) return;
    try {
      await api.post(`/transfers/${d.id}/driver/`, v);
      refresh();
      overlay.success('Driver details saved');
    } catch (e) {
      overlay.error(e);
    }
  };

  return (
    <>
      <Card>
        <div className="row">
          <StatusChip status={d.status} label={d.status_label} />
          <span className="grow" />
          {d.has_discrepancy && <Pill text="Arrived short" color={colors.danger} icon={TriangleAlert} />}
        </div>
        <div className="row" style={{ marginTop: 14 }}>
          <Place label={`From (${d.source_kind === 'godown' ? 'godown' : 'shop'})`} name={d.source_name} />
          <ArrowRight size={22} />
          <Place label={`To (${d.destination_kind === 'godown' ? 'godown' : 'shop'})`} name={d.destination_name} />
        </div>
        {d.notes && <p style={{ margin: '10px 0 0' }}>{d.notes}</p>}
        {d.rejection_reason && <p style={{ margin: '10px 0 0', color: colors.danger }}>Reason: {d.rejection_reason}</p>}
      </Card>

      <SectionTitle action={editable && d.driver_name ? 'Change' : undefined} onAction={editDriver}>Driver &amp; vehicle</SectionTitle>
      <DriverCard d={d} onAdd={editable ? editDriver : undefined} />

      {(d.status === 'in_transit' || d.dispatched_at) && <LiveTracking d={d} />}

      <SectionTitle>Progress</SectionTitle>
      <Card>
        {steps.map((s, i) => (
          <Step key={s.title} {...s} last={i === steps.length - 1} />
        ))}
      </Card>

      <SectionTitle>{receiving ? 'Count what arrived' : 'Products'}</SectionTitle>
      <div className="list">
        {d.lines.map((l) => {
          const short = toD(l.shortage) > 0;
          return (
            <Card key={l.id} style={{ padding: '12px 14px' }}>
              <div className="row">
                <div className="col grow">
                  <span className="bold">{l.variant_label}</span>
                  <span className="small" style={{ color: short ? colors.danger : 'var(--muted)' }}>
                    Sent {qty(l.quantity)} {l.unit}
                    {l.received_quantity != null ? ` · received ${qty(l.received_quantity)}` : ''}
                  </span>
                </div>
                {receiving ? (
                  <Field label="Arrived" style={{ width: 90 }}>
                    <input
                      className="input"
                      style={{ textAlign: 'center', minHeight: 44, padding: 8 }}
                      inputMode="decimal"
                      value={received[l.id] ?? qtyOut(toD(l.quantity))}
                      onFocus={(e) => e.target.select()}
                      onChange={(e) => setReceived({ ...received, [l.id]: numericInput(e.target.value) })}
                    />
                  </Field>
                ) : (
                  <span className="heavy" style={{ fontSize: 17 }}>{qty(l.quantity)}</span>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </>
  );
}

function DriverCard({ d, onAdd }: { d: Doc; onAdd?: () => void }) {
  if (!d.driver_name) {
    return (
      <Card>
        <div className="row">
          <User size={22} color="var(--muted)" />
          <span className="grow muted">Not set yet. Needed before dispatch.</span>
          {onAdd && <button className="btn tonal small" onClick={onAdd}>Add</button>}
        </div>
      </Card>
    );
  }
  const Icon = vehicleIcon[d.vehicle_type] ?? Truck;
  return (
    <Card>
      <div className="row">
        <span className="icon-box" style={{ background: 'var(--primary-soft)', color: 'var(--primary)', width: 48, height: 48 }}>
          <Icon size={24} />
        </span>
        <div className="col grow">
          <span className="heavy" style={{ fontSize: 16 }}>{d.driver_name}</span>
          <span className="small">{d.vehicle_label || 'Vehicle not set'}{d.vehicle_reg ? ' · ' : ''}{d.vehicle_reg && <span className="plate">{d.vehicle_reg}</span>}</span>
          {d.driver_phone && <span className="small muted">+{d.driver_phone}</span>}
        </div>
        {d.driver_phone && (
          <>
            <a className="icon-btn tonal" href={`tel:+${d.driver_phone}`} aria-label={`Call ${d.driver_name}`}>
              <Phone size={20} />
            </a>
            <a className="icon-btn tonal" href={`https://wa.me/${d.driver_phone}`} target="_blank" rel="noreferrer" aria-label={`WhatsApp ${d.driver_name}`}>
              <MessageCircle size={20} />
            </a>
          </>
        )}
      </div>
    </Card>
  );
}

function LiveTracking({ d }: { d: Doc }) {
  const navigate = useNavigate();
  const overlay = useOverlay();
  const active = d.status === 'in_transit';
  const tr = useTracking(d.id, true).data as Tracking | undefined;
  if (!tr) return null;
  const markers: Marker[] = [];
  if (tr.source) markers.push({ ...tr.source, label: 'A', color: colors.steel });
  if (tr.destination) markers.push({ ...tr.destination, label: 'B', color: colors.success });
  if (tr.last) markers.push({ ...tr.last, label: '🚚', color: colors.violet, name: 'Goods' });
  const km = tr.distance_left_m != null ? (tr.distance_left_m / 1000).toFixed(tr.distance_left_m < 10000 ? 1 : 0) : null;
  const stale = tr.last ? tr.last.seconds_ago > 120 : false;
  const link = tr.driver_link;
  const message = link ? `StockFlow ${d.code}: please open this link and keep it open while you deliver to ${d.destination_name}: ${link}` : '';
  const phone = d.driver_phone ? intlPhone(String(d.driver_phone)) : '';

  return (
    <>
      <SectionTitle>
        <span className="row" style={{ gap: 8 }}>
          {active && <span className={`live-dot${tr.last && !stale ? ' on' : ''}`} />} {active ? 'Live tracking' : 'Route taken'}
        </span>
      </SectionTitle>
      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <MapView markers={markers} path={tr.points} follow={active ? tr.last : null} height={280} />
        <div style={{ padding: 14 }}>
          {tr.last ? (
            <div className="mini-stats" style={{ marginTop: 0 }}>
              <div><b>{km != null ? `${km} km` : '—'}</b><span>left to go</span></div>
              <div><b>{active && tr.eta_minutes != null ? `${tr.eta_minutes} min` : '—'}</b><span>arrives in</span></div>
              <div><b style={{ color: stale ? colors.danger : undefined }}>{ago(tr.last.at)}</b><span>last GPS</span></div>
            </div>
          ) : (
            <p className="small muted" style={{ margin: 0 }}>
              {active ? 'Waiting for the driver to open the tracking link and tap Start.' : 'No GPS points were shared on this trip.'}
            </p>
          )}
          {tr.arrived_near_at && active && (
            <div className="row bold" style={{ marginTop: 10, color: colors.success, gap: 6 }}>
              <MapPin size={18} /> Arrived near {d.destination_name} {ago(tr.arrived_near_at)}
            </div>
          )}
          {!tr.destination && (
            <p className="tiny muted" style={{ margin: '8px 0 0' }}>Set {d.destination_name}'s map position (Stores → ⚙) to see distance and arrival time.</p>
          )}
          {active && link && (
            <div className="wrap" style={{ marginTop: 12 }}>
              {phone && (
                <a className="btn whatsapp small" href={`https://wa.me/${phone}?text=${encodeURIComponent(message)}`} target="_blank" rel="noreferrer">
                  <MessageCircle size={18} /> Send link
                </a>
              )}
              {phone && (
                <a className="btn tonal small" href={`sms:+${phone}?body=${encodeURIComponent(message)}`}>
                  <MessageSquareText size={18} /> SMS
                </a>
              )}
              <button className="btn outline small" onClick={async () => {
                await copyText(link);
                overlay.success('Tracking link copied');
              }}>
                <Copy size={18} /> Copy link
              </button>
              <button className="btn outline small" onClick={() => navigate(`/drive/${link.split('/drive/')[1]}`)}>
                <Radio size={18} /> I'm carrying it
              </button>
              {tr.last && tr.destination && (
                <a className="btn outline small" href={directionsLink(tr.destination, tr.last)} target="_blank" rel="noreferrer">
                  <Navigation size={18} /> Google Maps
                </a>
              )}
            </div>
          )}
        </div>
      </Card>
    </>
  );
}

function Place({ label, name }: { label: string; name: string }) {
  return (
    <div className="col grow">
      <span className="tiny">{label}</span>
      <span className="heavy" style={{ fontSize: 15 }}>{name}</span>
    </div>
  );
}

function Step({ title, who, when, done, last }: { title: string; who?: string | null; when?: string | null; done: boolean; last: boolean }) {
  const c = done ? colors.success : 'var(--border)';
  return (
    <div className="timeline-row">
      <div className="timeline-rail">
        <span
          style={{ width: 24, height: 24, borderRadius: '50%', border: `2px solid ${c}`, background: done ? c : 'transparent', display: 'grid', placeItems: 'center', color: '#fff' }}
        >
          {done && <Check size={15} strokeWidth={3} />}
        </span>
        {!last && <span className="line" style={{ background: c }} />}
      </div>
      <div className="col grow" style={{ paddingBottom: last ? 0 : 16 }}>
        <span className="heavy" style={{ color: done ? undefined : 'var(--muted)' }}>{title}</span>
        {(who || when) && <span className="small">{[who, when ? dateTime(when) : null].filter(Boolean).join(' · ')}</span>}
      </div>
    </div>
  );
}

