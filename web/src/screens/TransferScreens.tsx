import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeftRight, ArrowRight, ArrowUpDown, Check, PackageCheck, Send, TriangleAlert, Truck } from 'lucide-react';

import { api } from '../lib/api';
import { useMe } from '../lib/auth';
import { ago, dateTime, numericInput, qty, qtyOut, toD, uuid } from '../lib/format';
import { canManage, displayName, newLine, works, type Doc, type LineDraft, type Location } from '../lib/models';
import { useDirectory, useRefreshEverything, useTransfer, useTransfers } from '../lib/queries';
import { colors } from '../lib/theme';
import { BottomActions, Card, EmptyState, ErrorView, Field, LoadingList, Pill, SectionTitle, StatusChip, TopBar } from '../ui/common';
import { LinesEditor, linesPayload } from '../ui/LinesEditor';
import { useAskText, useConfirm, useOverlay } from '../ui/overlay';
import { LocationField, usePickLocation, usePickVariant } from '../ui/pickers';

export function NewTransferScreen({ sourceId }: { sourceId: number | null }) {
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
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!all || ready) return;
    const f = all.find((l) => l.id === sourceId) ?? all.find((l) => l.kind === 'godown') ?? null;
    setFrom(f);
    setTo(all.find((l) => l.is_main && l.id !== f?.id) ?? null);
    setReady(true);
  }, [all, ready, sourceId]);

  const addLine = async () => {
    if (!from) {
      overlay.error('Choose where the goods come from first.');
      return;
    }
    const picked = await pickVariant({ locationId: from.id, inStockOnly: true });
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
    setBusy(true);
    try {
      const r = await api.post<Doc>('/transfers/', {
        client_uuid: clientUuid,
        source: from.id,
        destination: to.id,
        notes: notes.trim(),
        lines: linesPayload(lines),
      });
      refresh();
      overlay.success(r.status === 'approved' ? `${r.code} ready to dispatch` : `${r.code} sent to admin for approval`);
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
          const l = await pickLocation(all ?? [], 'Send from');
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
      {!me.is_admin && <p className="small" style={{ margin: '10px 4px 0' }}>The admin will approve this transfer before it can be dispatched.</p>}
      <SectionTitle>Products</SectionTitle>
      <LinesEditor lines={lines} onChange={setLines} onAdd={addLine} checkAvailable />
      <Field label="Notes (driver, vehicle, reason)" style={{ marginTop: 12 }}>
        <textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <BottomActions>
        <button className="btn" disabled={busy || lines.length === 0} onClick={submit}>
          <Send size={20} /> {me.is_admin ? 'Create transfer' : 'Request transfer'}
        </button>
      </BottomActions>
    </main>
  );
}

/** Transfer detail with a status timeline and the right button for the right person at each step. */
export function TransferDetailScreen({ id }: { id: number }) {
  const me = useMe();
  const overlay = useOverlay();
  const refresh = useRefreshEverything();
  const confirm = useConfirm();
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
          const ok = await confirm({
            title: 'Dispatch now?',
            message: `Stock will leave ${d.source_name} and ${d.destination_name} will be notified.`,
            confirm: 'Dispatch',
          });
          if (ok) act('dispatch', `Dispatched. ${d.destination_name} has been notified.`);
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
  const p = d.people ?? {};
  const steps = [
    { title: 'Requested', who: p.requested_by, when: d.created_at, done: true },
    { title: 'Approved', who: p.approved_by, when: d.approved_at, done: d.approved_at != null },
    { title: 'Dispatched', who: p.dispatched_by, when: d.dispatched_at, done: d.dispatched_at != null },
    { title: 'Received', who: p.received_by, when: d.received_at, done: d.received_at != null },
  ];
  return (
    <>
      <Card>
        <div className="row">
          <StatusChip status={d.status} label={d.status_label} />
          <span className="grow" />
          {d.has_discrepancy && <Pill text="Arrived short" color={colors.danger} icon={TriangleAlert} />}
        </div>
        <div className="row" style={{ marginTop: 14 }}>
          <Place label="From" name={d.source_name} />
          <ArrowRight size={22} />
          <Place label="To" name={d.destination_name} />
        </div>
        {d.notes && <p style={{ margin: '10px 0 0' }}>{d.notes}</p>}
        {d.rejection_reason && <p style={{ margin: '10px 0 0', color: colors.danger }}>Reason: {d.rejection_reason}</p>}
      </Card>

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
        {done && (who || when) && <span className="small">{[who, when ? dateTime(when) : null].filter(Boolean).join(' · ')}</span>}
      </div>
    </div>
  );
}

/** List used inside the Inbox. */
export function TransferList({ status }: { status: string }) {
  const list = useTransfers(status);
  const navigate = useNavigate();
  if (list.isPending) return <LoadingList />;
  if (list.isError) return <ErrorView error={list.error} onRetry={() => list.refetch()} />;
  if (list.data.length === 0) return <EmptyState icon={ArrowLeftRight} title="No transfers here" />;
  return (
    <div className="list">
      {list.data.map((d) => (
        <Card key={d.id} onClick={() => navigate(`/transfers/${d.id}`)}>
          <div className="row">
            <span className="heavy grow">{d.code}</span>
            <StatusChip status={d.status} label={d.status_label} />
          </div>
          <div style={{ fontWeight: 600, marginTop: 6 }}>{d.source_name} → {d.destination_name}</div>
          <div className="small muted">{d.lines.length} item(s) · {ago(d.created_at)}</div>
        </Card>
      ))}
    </div>
  );
}
