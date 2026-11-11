import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BadgeCheck, CircleCheck, ClipboardList, Info, MessageCircle, PackageMinus, PackagePlus, Send, User, type LucideIcon } from 'lucide-react';

import { api } from '../lib/api';
import { useMe } from '../lib/auth';
import { ago, money, numericInput, qty, qtyOut, toD, uuid } from '../lib/format';
import { addReasons, canManage, displayName, newLine, reasons, removeReasons, type Doc, type LineDraft, type Location } from '../lib/models';
import { useLocations, useRefreshEverything, useRequest, useRequests } from '../lib/queries';
import { alpha, colors } from '../lib/theme';
import { BottomActions, Card, EmptyState, ErrorView, Field, IconBox, LoadingList, Pill, SectionTitle, Segmented, Spinner, StatusChip, Switch, TopBar } from '../ui/common';
import { LinesEditor, linesPayload } from '../ui/LinesEditor';
import { useAskText, useConfirm, useOverlay } from '../ui/overlay';
import { LocationField, usePickLocation, usePickVariant } from '../ui/pickers';

type Kind = 'remove' | 'add';

/**
 * Remove or add stock with a reason. The owner can apply it straight away; anyone else's request is checked:
 * the stock manager confirms the goods were moved, then the owner approves, and only then does stock change.
 */
export function NewRequestScreen({ locationId, kind: initialKind }: { locationId: number | null; kind: Kind }) {
  const me = useMe();
  const navigate = useNavigate();
  const overlay = useOverlay();
  const refresh = useRefreshEverything();
  const pickVariant = usePickVariant();
  const pickLocation = usePickLocation();
  const mine = (useLocations().data ?? []).filter((l) => l.is_active !== false);
  const [clientUuid] = useState(uuid);
  const [kind, setKind] = useState<Kind>(initialKind);
  const [reason, setReason] = useState(initialKind === 'remove' ? 'damaged' : 'found');
  const [location, setLocation] = useState<Location | null>(null);
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [notes, setNotes] = useState('');
  const [alreadyDone, setAlreadyDone] = useState(false);
  const [applyNow, setApplyNow] = useState(me.is_admin);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (location || mine.length === 0) return;
    setLocation(mine.find((l) => l.id === locationId) ?? mine.find((l) => l.kind === 'godown') ?? mine[0]);
  }, [mine, location, locationId]);

  const canDo = location != null && canManage(me, location.id);
  const remove = kind === 'remove';
  const sign = remove ? -1 : 1;
  const value = lines.reduce((s, l) => s + l.quantity * toD(l.variant.cost_price), 0);
  const over = remove ? lines.find((l) => l.available != null && l.quantity > l.available) : undefined;

  const add = async () => {
    if (!location) return;
    const picked = await pickVariant({ locationId: location.id, inStockOnly: remove });
    if (!picked || lines.some((l) => l.variant.id === picked.variant.id)) return;
    setLines([...lines, newLine(picked.variant, picked.available)]);
  };

  const submit = async () => {
    if (over) {
      overlay.error(`${over.variant.label}: only ${qty(over.available)} at ${location?.name}.`);
      return;
    }
    if (reason === 'other' && !notes.trim()) {
      overlay.error('Say what happened in the notes.');
      return;
    }
    setBusy(true);
    try {
      const r = await api.post<Doc>('/requests/', {
        client_uuid: clientUuid,
        kind,
        location: location!.id,
        reason,
        notes: notes.trim(),
        already_done: !me.is_admin && alreadyDone && canDo,
        apply_now: me.is_admin && applyNow,
        lines: linesPayload(lines),
      });
      refresh();
      overlay.success(
        r.status === 'approved' ? `${r.code}: stock updated at ${location!.name}`
          : r.status === 'confirmed' ? `${r.code} sent to the owner for approval`
            : `${r.code} sent to the ${location!.name} stock manager`,
      );
      navigate(`/requests/${r.id}`, { replace: true });
    } catch (e) {
      overlay.error(e);
    } finally {
      setBusy(false);
    }
  };

  const reasonList = remove ? removeReasons : addReasons;
  const flow = me.is_admin
    ? applyNow ? 'Stock changes as soon as you save. It is recorded in the item history with your name and reason.' : 'The store manager confirms the goods were moved, then you approve.'
    : alreadyDone && canDo ? 'Goes straight to the owner for approval. Stock changes once approved.'
      : canDo ? 'You confirm when the goods are moved, then the owner approves.' : 'The store manager confirms, then the owner approves.';

  return (
    <main className="page with-actions">
      <TopBar title={remove ? 'Remove stock' : 'Add stock'} back />
      <div className="stack">
        <Segmented<Kind>
          value={kind}
          onChange={(k) => {
            setKind(k);
            setReason(k === 'remove' ? 'damaged' : 'found');
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
        <Field label={remove ? 'Why are the goods leaving?' : 'Where did the extra goods come from?'}>
          <div className="wrap">
            {reasonList.map((k) => (
              <button key={k} type="button" className={`choice${reason === k ? ' on' : ''}`} onClick={() => setReason(k)}>
                {k === 'other' ? 'Write my own reason' : reasons[k]}
              </button>
            ))}
          </div>
        </Field>
      </div>
      <SectionTitle>Products</SectionTitle>
      <LinesEditor lines={lines} onChange={setLines} onAdd={add} checkAvailable={remove} />

      {lines.length > 0 && (
        <Card style={{ marginTop: 12 }}>
          <div className="bold" style={{ marginBottom: 6 }}>What will change at {location?.name}</div>
          {lines.map((l) => {
            const before = l.available ?? 0;
            const after = before + sign * l.quantity;
            return (
              <div key={l.variant.id} className="row small" style={{ padding: '4px 0' }}>
                <span className="grow ellipsis">{l.variant.label}</span>
                <span className="muted">{qty(before)}</span>
                <span style={{ color: remove ? colors.danger : colors.success, fontWeight: 800 }}>{remove ? '−' : '+'}{qty(l.quantity)}</span>
                <span>→</span>
                <span className="heavy" style={{ minWidth: 40, textAlign: 'right', color: after < 0 ? colors.danger : undefined }}>{qty(after)}</span>
              </div>
            );
          })}
          <div className="row small" style={{ marginTop: 8, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
            <span className="grow">Value at cost</span>
            <span className="heavy" style={{ color: remove ? colors.danger : colors.success }}>{remove ? '−' : '+'}{money(value)}</span>
          </div>
        </Card>
      )}

      <div className="stack" style={{ marginTop: 12 }}>
        <Field label={reason === 'other' ? 'Describe your reason (required)' : 'Notes (customer, order no., details)'}>
          <textarea
            className="input"
            rows={2}
            placeholder={reason === 'other' ? 'Type why these goods are leaving or being added' : ''}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
        {me.is_admin ? (
          <Switch checked={applyNow} onChange={setApplyNow} title="Apply now" subtitle="I've checked it myself. Skip the manager and approval steps." />
        ) : (
          canDo && (
            <Switch
              checked={alreadyDone}
              onChange={setAlreadyDone}
              title={remove ? "I've already removed these goods" : "I've already added these goods"}
              subtitle="Skips the manager step and goes straight to the owner for approval."
            />
          )
        )}
        <Card style={{ background: alpha(colors.info, 0.08) }}>
          <div className="row">
            <Info size={22} color={colors.info} />
            <span className="grow small">{flow}</span>
          </div>
        </Card>
      </div>
      <BottomActions>
        <button className={`btn${remove ? ' danger' : ' success'}`} disabled={busy || lines.length === 0 || !location || !!over} onClick={submit}>
          {busy ? <Spinner /> : <Send size={20} />}{' '}
          {me.is_admin && applyNow ? `${remove ? 'Remove' : 'Add'} ${lines.length} item(s) now` : alreadyDone && canDo ? 'Send for approval' : 'Send request'}
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
        {toD(d.value) > 0 && <div className="small muted">Value at cost: {money(d.value)}</div>}
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
