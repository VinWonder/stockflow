import { useEffect, useState } from 'react';
import { ArrowLeftRight, CircleCheck, MessageCircle, MessageSquareText, PackageMinus, PackagePlus, Search, Send, Zap } from 'lucide-react';

import { api } from '../lib/api';
import { useMe } from '../lib/auth';
import { qtyOut, smsHref } from '../lib/format';
import { newLine, works, type Json, type LineDraft, type Location } from '../lib/models';
import { useDirectory, useMessagingConfig, useRefreshEverything } from '../lib/queries';
import { alpha, colors } from '../lib/theme';
import { Card, SectionTitle, Spinner, Switch, TopBar } from '../ui/common';
import { LinesEditor } from '../ui/LinesEditor';
import { useOverlay } from '../ui/overlay';
import { LocationField, usePickLocation, usePickVariant } from '../ui/pickers';

type Action = 'remove' | 'add' | 'transfer' | 'stock';

const ACTIONS: { id: Action; label: string; icon: typeof Send }[] = [
  { id: 'remove', label: 'Remove stock', icon: PackageMinus },
  { id: 'add', label: 'Add stock', icon: PackagePlus },
  { id: 'transfer', label: 'Move to a store', icon: ArrowLeftRight },
  { id: 'stock', label: 'Check stock', icon: Search },
];

const REASONS: [string, string][] = [
  ['', 'No reason'], ['damaged', 'Damaged'], ['customer', 'Customer pick-up'], ['return', 'Back to supplier'],
  ['site', 'Used on site'], ['lost', 'Lost / stolen'], ['correction', 'Correction'],
];

const digits = (n: unknown) => String(n ?? '').replace(/[^0-9]/g, '');

/**
 * Stock updates by text message, for staff working away from the app (e.g. at the godown with a basic phone).
 * Build the message here and send it by SMS or WhatsApp to the business number, or do the same thing in the app now.
 */
export function ComposeScreen({ locationId }: { locationId: number | null }) {
  const me = useMe();
  const overlay = useOverlay();
  const refresh = useRefreshEverything();
  const pickVariant = usePickVariant();
  const pickLocation = usePickLocation();
  const all = useDirectory().data;
  const mine = (all ?? []).filter((l) => works(me, l.id));
  const config = useMessagingConfig().data;
  const [action, setAction] = useState<Action>('remove');
  const [done, setDone] = useState(false);
  const [from, setFrom] = useState<Location | null>(null);
  const [to, setTo] = useState<Location | null>(null);
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [reason, setReason] = useState('');
  const [reply, setReply] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!all || ready) return;
    const f = mine.find((l) => l.id === locationId) ?? mine.find((l) => l.kind === 'godown') ?? mine[0] ?? null;
    setFrom(f);
    setTo(all.find((l) => l.is_main && l.id !== f?.id) ?? all.find((l) => l.id !== f?.id) ?? null);
    setReady(true);
  }, [all, ready, locationId]); // eslint-disable-line react-hooks/exhaustive-deps

  const wa = digits(config?.whatsapp_number);
  const sms = digits(config?.sms_number);
  const registered = (config?.phone_registered ?? true) as boolean;

  let message = '';
  if (from && lines.length) {
    if (action === 'stock') {
      message = `STOCK ${from.code} ${lines[0].variant.sku}`;
    } else {
      const items = lines.map((l) => `${l.variant.sku} ${qtyOut(l.quantity)}`).join(', ');
      const verb = action === 'remove' ? (done ? 'REMOVED' : 'REMOVE') : action === 'add' ? (done ? 'ADDED' : 'ADD') : 'TRANSFER';
      const head = action === 'transfer' ? `TRANSFER ${from.code}>${to?.code ?? '?'}` : `${verb} ${from.code}`;
      const tag = reason && action !== 'transfer' ? ` #${reason}` : '';
      message = `${head}: ${items}${tag}`;
    }
  }

  const add = async () => {
    if (!from) return;
    const picked = await pickVariant({ locationId: from.id, inStockOnly: action === 'remove' || action === 'transfer' });
    if (!picked || lines.some((l) => l.variant.id === picked.variant.id)) return;
    setLines(action === 'stock' ? [newLine(picked.variant, picked.available)] : [...lines, newLine(picked.variant, picked.available)]);
    setReply(null);
  };

  const doNow = async () => {
    setBusy(true);
    try {
      const r = await api.post<Json>('/messaging/simulate/', { text: message });
      const out = String(r.reply ?? '');
      setReply({ text: out, ok: !out.startsWith('Not ') });
      refresh();
    } catch (e) {
      overlay.error(e);
    } finally {
      setBusy(false);
    }
  };

  const off = { opacity: 0.4, pointerEvents: 'none' as const };

  return (
    <main className="page">
      <TopBar title="Send by SMS / WhatsApp" back />
      <Card style={{ background: alpha(colors.info, 0.07) }}>
        <span className="small">
          For when you're away from the app, e.g. at the godown. Choose what happened, and StockFlow writes the message for you to
          send to the business number. Or do it right now in the app.
        </span>
      </Card>
      {!registered && (
        <Card style={{ marginTop: 10, background: alpha(colors.amber, 0.12) }}>
          <span className="small">Add your phone number under More → your name, so messages from your phone are recognised.</span>
        </Card>
      )}

      <SectionTitle>What do you want to do?</SectionTitle>
      <div className="grid-2">
        {ACTIONS.map((a) => (
          <button
            key={a.id}
            className={`choice action-choice${action === a.id ? ' on' : ''}`}
            onClick={() => {
              setAction(a.id);
              setReply(null);
              if (a.id === 'stock') setLines(lines.slice(0, 1));
            }}
          >
            <a.icon size={20} /> {a.label}
          </button>
        ))}
      </div>

      <div className="stack" style={{ marginTop: 12 }}>
        <LocationField
          label={action === 'transfer' ? 'From' : 'Store'}
          value={from}
          onClick={async () => {
            const l = await pickLocation(mine, 'Your stores');
            if (l) {
              setFrom(l);
              setLines([]);
              setReply(null);
            }
          }}
        />
        {action === 'transfer' && (
          <LocationField
            label="To"
            value={to}
            onClick={async () => {
              const l = await pickLocation((all ?? []).filter((x) => x.id !== from?.id));
              if (l) setTo(l);
            }}
          />
        )}
      </div>

      <SectionTitle>{action === 'stock' ? 'Which product?' : 'Products'}</SectionTitle>
      {action === 'stock' ? (
        <Card onClick={add}>
          <span className="bold">{lines[0]?.variant.label ?? 'Tap to choose a product'}</span>
        </Card>
      ) : (
        <LinesEditor lines={lines} onChange={(l) => { setLines(l); setReply(null); }} onAdd={add} checkAvailable={action !== 'add'} />
      )}

      {(action === 'remove' || action === 'add') && (
        <>
          <SectionTitle>Reason</SectionTitle>
          <div className="wrap">
            {REASONS.map(([k, label]) => (
              <button key={k || 'none'} className={`choice${reason === k ? ' on' : ''}`} onClick={() => setReason(k)}>{label}</button>
            ))}
          </div>
          <div style={{ marginTop: 10 }}>
            <Switch
              checked={done}
              onChange={setDone}
              title={action === 'remove' ? 'Already removed' : 'Already added'}
              subtitle="Tick if the goods have already been moved; the owner just approves."
            />
          </div>
        </>
      )}

      <SectionTitle>Message preview</SectionTitle>
      <div className="phone-thread">
        {message ? (
          <div className="sms-bubble out">{message}</div>
        ) : (
          <div className="small muted" style={{ textAlign: 'center', padding: 12 }}>Choose a product to see the message.</div>
        )}
        {reply && <div className={`sms-bubble in${reply.ok ? '' : ' bad'}`}>{reply.text}</div>}
      </div>

      <div className="row" style={{ marginTop: 14, gap: 10 }}>
        <a className="btn grow" style={!message || !sms ? off : undefined} aria-disabled={!message || !sms} href={smsHref(sms, message)}>
          <MessageSquareText size={20} /> SMS
        </a>
        <a
          className="btn whatsapp grow"
          style={!message || !wa ? off : undefined}
          aria-disabled={!message || !wa}
          href={`https://wa.me/${wa}?text=${encodeURIComponent(message)}`}
          target="_blank"
          rel="noreferrer"
        >
          <MessageCircle size={20} /> WhatsApp
        </a>
      </div>
      {(!sms || !wa) && (
        <p className="tiny muted" style={{ margin: '8px 4px 0' }}>
          {!sms && !wa
            ? 'Sending by SMS or WhatsApp starts once the business number is connected. Until then, use the button below.'
            : !sms ? 'SMS starts once the business SMS number is connected.' : 'WhatsApp starts once the business WhatsApp number is connected.'}
        </p>
      )}

      <button className="btn outline block" style={{ marginTop: 12 }} disabled={!message || busy} onClick={doNow}>
        {busy ? <Spinner /> : reply?.ok ? <CircleCheck size={20} /> : <Zap size={20} />} Do it in the app now
      </button>
    </main>
  );
}
