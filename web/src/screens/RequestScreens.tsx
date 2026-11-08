import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BadgeCheck, CircleCheck, ClipboardList, Info, MessageCircle, PackageMinus, PackagePlus, Send, User, type LucideIcon } from 'lucide-react';

import { api } from '../lib/api';
import { useMe } from '../lib/auth';
import { ago, numericInput, qty, qtyOut, toD, uuid } from '../lib/format';
import { canManage, displayName, newLine, reasons, type Doc, type LineDraft, type Location } from '../lib/models';
import { useLocations, useRefreshEverything, useRequest, useRequests } from '../lib/queries';
import { alpha, colors } from '../lib/theme';
import { BottomActions, Card, EmptyState, ErrorView, Field, IconBox, LoadingList, Pill, SectionTitle, Segmented, StatusChip, Switch, TopBar } from '../ui/common';
import { LinesEditor, linesPayload } from '../ui/LinesEditor';
import { useAskText, useConfirm, useOverlay } from '../ui/overlay';
import { LocationField, usePickLocation, usePickVariant } from '../ui/pickers';

type Kind = 'remove' | 'add';

/** Ask for stock to be removed or added. Stock only changes after the admin approves. */
export function NewRequestScreen({ locationId, kind: initialKind }: { locationId: number | null; kind: Kind }) {
  const me = useMe();
  const navigate = useNavigate();
  const overlay = useOverlay();
  const refresh = useRefreshEverything();
  const pickVariant = usePickVariant();
  const pickLocation = usePickLocation();
  const mine = useLocations().data ?? [];
  const [clientUuid] = useState(uuid);
  const [kind, setKind] = useState<Kind>(initialKind);
  const [reason, setReason] = useState(initialKind === 'remove' ? 'customer_pickup' : 'found');
  const [location, setLocation] = useState<Location | null>(null);
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [notes, setNotes] = useState('');
  const [alreadyDone, setAlreadyDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (location || mine.length === 0) return;
    setLocation(mine.find((l) => l.id === locationId) ?? mine.find((l) => l.kind === 'godown') ?? mine[0]);
  }, [mine, location, locationId]);

  const canDo = location != null && canManage(me, location.id);

  const add = async () => {
    if (!location) return;
    const picked = await pickVariant({ locationId: location.id, inStockOnly: kind === 'remove' });
    if (!picked || lines.some((l) => l.variant.id === picked.variant.id)) return;
    setLines([...lines, newLine(picked.variant, picked.available)]);
  };

  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.post<Doc>('/requests/', {
        client_uuid: clientUuid,
        kind,
        location: location!.id,
        reason,
        notes: notes.trim(),
        already_done: alreadyDone && canDo,
        lines: linesPayload(lines),
      });
      refresh();
      overlay.success(r.status === 'confirmed' ? `${r.code} sent to the admin for approval` : `${r.code} sent to the stock manager`);
      navigate(`/requests/${r.id}`, { replace: true });
    } catch (e) {
      overlay.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page with-actions">
      <TopBar title={kind === 'remove' ? 'Remove stock' : 'Add stock'} back />
      <div className="stack">
        <Segmented<Kind>
          value={kind}
          onChange={(k) => {
            setKind(k);
            setReason(k === 'remove' ? 'customer_pickup' : 'found');
            setLines([]);
          }}
          options={[
            { value: 'remove', label: 'Remove', icon: PackageMinus },
            { value: 'add', label: 'Add', icon: PackagePlus },
          ]}
        />
        <LocationField
          label="Store"
          value={location}
          onClick={async () => {
            const l = await pickLocation(mine);
            if (l) {
              setLocation(l);
              setLines([]);
            }
          }}
        />
        <Field label="Reason">
          <select className="input" value={reason} onChange={(e) => setReason(e.target.value)}>
            {Object.entries(reasons).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </Field>
      </div>
      <SectionTitle>Products</SectionTitle>
      <LinesEditor lines={lines} onChange={setLines} onAdd={add} checkAvailable={kind === 'remove'} />
      <div className="stack" style={{ marginTop: 12 }}>
        <Field label="Notes (customer, order no., details)">
          <textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        {canDo && (
          <Switch
            checked={alreadyDone}
            onChange={setAlreadyDone}
            title={kind === 'remove' ? "I've already removed these goods" : "I've already added these goods"}
            subtitle="Skips the manager step and goes straight to the admin for approval."
          />
        )}
        <Card style={{ background: alpha(colors.info, 0.08) }}>
          <div className="row">
            <Info size={22} color={colors.info} />
            <span className="grow">Stock changes only after the admin approves, so a mistake here never changes the numbers on its own.</span>
          </div>
        </Card>
      </div>
      <BottomActions>
        <button className="btn" disabled={busy || lines.length === 0 || !location} onClick={submit}>
          <Send size={20} /> {alreadyDone && canDo ? 'Send for approval' : 'Send request'}
        </button>
      </BottomActions>
    </main>
  );
}

export function RequestDetailScreen({ id }: { id: number }) {
  const me = useMe();
  const overlay = useOverlay();
  const refresh = useRefreshEverything();
  const confirm = useConfirm();
  const askText = useAskText();
  const r = useRequest(id);
  const [busy, setBusy] = useState(false);
  const [actual, setActual] = useState<Record<number, string>>({});

  const act = async (action: string, done: string, body: object = {}) => {
    setBusy(true);
    try {
      await api.post(`/requests/${id}/${action}/`, body);
      refresh();
      overlay.success(done);
    } catch (e) {
      overlay.error(e);
    } finally {
      setBusy(false);
    }
  };

  const d = r.data;
  const myName = displayName(me);
  const buttons: JSX.Element[] = [];
  if (d) {
    const open = d.status === 'pending' || d.status === 'confirmed';
    const mineToCancel = open && d.people?.requested_by === myName;
    if (me.is_admin && open) {
      buttons.push(
        <button key="reject" className="btn outline" disabled={busy} onClick={async () => {
          const reason = await askText({ title: `Reject ${d.code}`, hint: 'Why?', confirm: 'Reject' });
          if (reason != null) act('reject', 'Rejected', { reason });
        }}>
          Reject
        </button>,
      );
    }
    if (d.status === 'pending' && canManage(me, d.location)) {
      buttons.push(
        <button key="confirm" className="btn" disabled={busy} onClick={() => {
          const quantities = Object.fromEntries(d.lines.map((l) => [String(l.id), actual[l.id] ?? qtyOut(toD(l.quantity))]).map(([k, v]) => [k, v === '' ? '0' : v]));
          act('confirm', 'Confirmed. The admin has been asked to approve.', { quantities });
        }}>
          <CircleCheck size={20} /> {d.kind === 'remove' ? 'Done: removed' : 'Done: added'}
        </button>,
      );
    }
    if (me.is_admin && (d.status === 'confirmed' || (d.status === 'pending' && d.people?.requested_by === myName))) {
      buttons.push(
        <button key="approve" className="btn success" disabled={busy} onClick={async () => {
          if (await confirm({ title: `Approve ${d.code}?`, message: `Stock at ${d.location_name} will be updated now.`, confirm: 'Approve' })) {
            act('approve', 'Approved. Stock updated.');
          }
        }}>
          <BadgeCheck size={20} /> Approve
        </button>,
      );
    }
    if (buttons.length === 0 && mineToCancel) {
      buttons.push(
        <button key="cancel" className="btn outline" disabled={busy} onClick={() => act('cancel', 'Cancelled')}>
          Cancel request
        </button>,
      );
    }
  }

  return (
    <main className={`page${buttons.length ? ' with-actions' : ''}`}>
      <TopBar title={d?.code ?? 'Request'} back />
      {r.isPending ? (
        <LoadingList count={4} />
      ) : r.isError ? (
        <ErrorView error={r.error} onRetry={() => r.refetch()} />
      ) : (
        <RequestBody d={r.data} confirming={r.data.status === 'pending' && canManage(me, r.data.location)} actual={actual} setActual={setActual} />
      )}
      {buttons.length > 0 && <BottomActions>{buttons}</BottomActions>}
    </main>
  );
}

function RequestBody({ d, confirming, actual, setActual }: {
  d: Doc;
  confirming: boolean;
  actual: Record<number, string>;
  setActual: (v: Record<number, string>) => void;
}) {
  const remove = d.kind === 'remove';
  const p = d.people ?? {};
  return (
    <>
      <Card>
        <div className="row" style={{ gap: 8 }}>
          <Pill text={remove ? 'REMOVE' : 'ADD'} color={remove ? colors.danger : colors.success} icon={remove ? PackageMinus : PackagePlus} />
          {d.source && d.source !== 'app' && <Pill text={d.source === 'whatsapp' ? 'WhatsApp' : 'SMS'} color={colors.success} icon={MessageCircle} />}
          <span className="grow" />
          <StatusChip status={d.status} label={d.status_label} />
        </div>
        <div className="heavy" style={{ fontSize: 17, marginTop: 12 }}>{d.location_name}</div>
        <div>Reason: {d.reason_label}</div>
        {d.notes && <div>{d.notes}</div>}
        {d.raw_message && <div className="whatsapp-bubble" style={{ marginTop: 10 }}>{d.raw_message}</div>}
        {d.rejection_reason && <div style={{ color: colors.danger, marginTop: 8 }}>Rejected: {d.rejection_reason}</div>}
      </Card>

      <SectionTitle>Who did what</SectionTitle>
      <Card>
        <Who icon={User} label="Asked by" name={p.requested_by} when={d.created_at} />
        <Who icon={ClipboardList} label="Confirmed by" name={p.confirmed_by} when={d.confirmed_at} />
        <Who icon={BadgeCheck} label="Approved by" name={p.approved_by} when={d.approved_at} />
      </Card>

      <SectionTitle>{confirming ? `How many did you actually ${remove ? 'remove' : 'add'}?` : 'Products'}</SectionTitle>
      <div className="list">
        {d.lines.map((l) => {
          const confirmed = l.confirmed_quantity != null ? toD(l.confirmed_quantity) : null;
          const differs = confirmed != null && confirmed !== toD(l.quantity);
          return (
            <Card key={l.id} style={{ padding: '12px 14px' }}>
              <div className="row">
                <div className="col grow">
                  <span className="bold">{l.variant_label}</span>
                  <span className="small">{l.sku} · asked {qty(l.quantity)} {l.unit}{differs ? ` · actual ${qty(confirmed)}` : ''}</span>
                </div>
                {confirming ? (
                  <Field label="Actual" style={{ width: 90 }}>
                    <input
                      className="input"
                      style={{ textAlign: 'center', minHeight: 44, padding: 8 }}
                      inputMode="decimal"
                      value={actual[l.id] ?? qtyOut(toD(l.quantity))}
                      onFocus={(e) => e.target.select()}
                      onChange={(e) => setActual({ ...actual, [l.id]: numericInput(e.target.value) })}
                    />
                  </Field>
                ) : (
                  <span className="heavy" style={{ fontSize: 17, color: remove ? colors.danger : colors.success }}>
                    {remove ? '−' : '+'}{qty(confirmed ?? l.quantity)}
                  </span>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </>
  );
}

function Who({ icon: Icon, label, name, when }: { icon: LucideIcon; label: string; name?: string | null; when?: string | null }) {
  return (
    <div className="row" style={{ padding: '6px 0', gap: 10 }}>
      <Icon size={20} color={name ? colors.success : 'var(--muted)'} />
      <span className="grow">{label}</span>
      <span className="bold right">{name ? `${name}${when ? ` · ${ago(when)}` : ''}` : '—'}</span>
    </div>
  );
}

export function RequestList({ status }: { status: string }) {
  const list = useRequests(status);
  const navigate = useNavigate();
  if (list.isPending) return <LoadingList />;
  if (list.isError) return <ErrorView error={list.error} onRetry={() => list.refetch()} />;
  if (list.data.length === 0) return <EmptyState icon={CircleCheck} title="All clear" message="Nothing waiting here." />;
  return (
    <div className="list">
      {list.data.map((d) => {
        const remove = d.kind === 'remove';
        const c = remove ? colors.danger : colors.success;
        const label = d.status === 'confirmed' ? 'To approve' : d.status === 'pending' ? 'To do' : d.status_label.split(' ')[0];
        return (
          <Card key={d.id} onClick={() => navigate(`/requests/${d.id}`)}>
            <div className="row">
              <IconBox icon={remove ? PackageMinus : PackagePlus} color={c} />
              <div className="col grow">
                <div className="row" style={{ gap: 6 }}>
                  <span className="heavy">{d.code}</span>
                  {d.source && d.source !== 'app' && <MessageCircle size={15} color={colors.success} />}
                </div>
                <span className="small ellipsis">{d.location_name} · {d.lines.map((l) => `${l.sku}×${qty(l.quantity)}`).join(', ')}</span>
                <span className="tiny muted">{ago(d.created_at)}</span>
              </div>
              <StatusChip status={d.status} label={label} />
            </div>
          </Card>
        );
      })}
    </div>
  );
}
