import { useEffect, useState } from 'react';
import { Bot, CirclePlay, Copy, MessageCircle, MessageSquareText, Send } from 'lucide-react';

import { api } from '../lib/api';
import { useMe } from '../lib/auth';
import { copyText, qtyOut } from '../lib/format';
import { newLine, works, type Json, type LineDraft, type Location } from '../lib/models';
import { useDirectory, useMessagingConfig, useRefreshEverything } from '../lib/queries';
import { alpha, colors } from '../lib/theme';
import { Card, SectionTitle, Spinner, TopBar } from '../ui/common';
import { LinesEditor } from '../ui/LinesEditor';
import { useOverlay } from '../ui/overlay';
import { LocationField, usePickLocation, usePickVariant } from '../ui/pickers';

const verbs = {
  REMOVE: 'Ask to remove',
  REMOVED: 'Already removed',
  ADD: 'Ask to add',
  ADDED: 'Already added',
  TRANSFER: 'Transfer',
  STOCK: 'Check stock',
} as const;
type Verb = keyof typeof verbs;

const reasonTags = ['', 'damaged', 'customer', 'return', 'site', 'expired', 'lost', 'correction'];

const digits = (n: unknown) => String(n ?? '').replace(/[^0-9]/g, '');

/**
 * Stock commands by SMS / WhatsApp: build a correct message from a form (or type one), test it here
 * without sending anything, then open WhatsApp or SMS with it ready to send.
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
  const [verb, setVerb] = useState<Verb>('REMOVE');
  const [from, setFrom] = useState<Location | null>(null);
  const [to, setTo] = useState<Location | null>(null);
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
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

  let built = '';
  if (from && lines.length) {
    if (verb === 'STOCK') {
      built = `STOCK ${from.code} ${lines[0].variant.sku}`;
    } else {
      const items = lines.map((l) => `${l.variant.sku} ${qtyOut(l.quantity)}`).join(', ');
      const head = verb === 'TRANSFER' ? `TRANSFER ${from.code}>${to?.code ?? '?'}` : `${verb} ${from.code}`;
      const tag = reason === '' || verb === 'TRANSFER' ? '' : ` #${reason}`;
      built = `${head}: ${items}${tag}`;
    }
  }
  const message = typed.trim() || built;

  const add = async () => {
    if (!from) return;
    const removing = verb === 'REMOVE' || verb === 'REMOVED' || verb === 'TRANSFER';
    const picked = await pickVariant({ locationId: from.id, inStockOnly: removing });
    if (!picked || lines.some((l) => l.variant.id === picked.variant.id)) return;
    setLines(verb === 'STOCK' ? [newLine(picked.variant, picked.available)] : [...lines, newLine(picked.variant, picked.available)]);
  };

  const simulate = async (text = message) => {
    setBusy(true);
    try {
      const r = await api.post<Json>('/messaging/simulate/', { text });
      const out = String(r.reply ?? '');
      setReply({ text: out, ok: !out.startsWith('Not ') });
      refresh();
    } catch (e) {
      overlay.error(e);
    } finally {
      setBusy(false);
    }
  };

  const examples = from
    ? [`STOCK ${from.code} ${lines[0]?.variant.sku ?? 'CEM'}`, `REMOVE ${from.code}: CEM 2 #damaged`, ...(to ? [`TRANSFER ${from.code}>${to.code}: CEM 5`] : []), 'HELP']
    : ['HELP'];

  return (
    <main className="page">
      <TopBar title="Message command" back />
      {!registered && (
        <Card style={{ marginBottom: 12, background: alpha(colors.amber, 0.12) }}>
          Your phone number isn't on your account, so messages from your phone will be ignored. Add it under More → My account.
        </Card>
      )}
      <div className="wrap">
        {(Object.keys(verbs) as Verb[]).map((v) => (
          <button
            key={v}
            className={`choice${verb === v ? ' on' : ''}`}
            onClick={() => {
              setVerb(v);
              setReply(null);
              setTyped('');
              if (v === 'STOCK') setLines(lines.slice(0, 1));
            }}
          >
            {verbs[v]}
          </button>
        ))}
      </div>
      <div className="stack" style={{ marginTop: 12 }}>
        <LocationField
          label={verb === 'TRANSFER' ? 'From' : 'Store'}
          value={from}
          onClick={async () => {
            const l = await pickLocation(mine, 'Your stores');
            if (l) {
              setFrom(l);
              setLines([]);
            }
          }}
        />
        {verb === 'TRANSFER' && (
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

      <SectionTitle>{verb === 'STOCK' ? 'Product to check' : 'Products'}</SectionTitle>
      {verb === 'STOCK' ? (
        <Card onClick={add}>
          <span className="bold">{lines[0]?.variant.label ?? 'Tap to choose a product'}</span>
        </Card>
      ) : (
        <LinesEditor lines={lines} onChange={setLines} onAdd={add} checkAvailable={verb !== 'ADD' && verb !== 'ADDED'} />
      )}

      {verb !== 'TRANSFER' && verb !== 'STOCK' && (
        <>
          <SectionTitle>Reason</SectionTitle>
          <div className="wrap">
            {reasonTags.map((r) => (
              <button key={r || 'none'} className={`choice${reason === r ? ' on' : ''}`} onClick={() => setReason(r)}>
                {r || 'None'}
              </button>
            ))}
          </div>
        </>
      )}

      <SectionTitle>Message</SectionTitle>
      <div className="whatsapp-bubble row" style={{ padding: '12px 8px 12px 16px', borderRadius: 18 }}>
        <span className="grow" style={{ fontWeight: 600, fontSize: 15, userSelect: 'text' }}>
          {message || 'Add a product to build the message, or type one below'}
        </span>
        <button
          className="icon-btn"
          style={{ color: 'rgba(0,0,0,.55)' }}
          disabled={!message}
          aria-label="Copy"
          onClick={async () => {
            await copyText(message);
            overlay.success('Copied');
          }}
        >
          <Copy size={20} />
        </button>
      </div>
      <div className="input-wrap" style={{ marginTop: 10 }}>
        <Send size={20} />
        <input
          className="input"
          placeholder="Or type any command, e.g. STOCK CEM"
          autoCapitalize="characters"
          value={typed}
          onChange={(e) => {
            setTyped(e.target.value);
            setReply(null);
          }}
          onKeyDown={(e) => e.key === 'Enter' && typed.trim() && simulate()}
        />
      </div>
      <div className="chip-row" style={{ marginTop: 8 }}>
        {examples.map((x) => (
          <button key={x} className="choice" onClick={() => { setTyped(x); simulate(x); }}>{x}</button>
        ))}
      </div>

      <button className="btn outline block" style={{ marginTop: 12 }} disabled={!message || busy} onClick={() => simulate()}>
        {busy ? <Spinner /> : <CirclePlay size={20} />} Test it here (runs the command, no SMS sent)
      </button>

      {reply && (
        <Card style={{ marginTop: 10, background: alpha(reply.ok ? colors.success : colors.danger, 0.08) }}>
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <Bot size={22} color={reply.ok ? colors.success : colors.danger} />
            <span className="grow" style={{ whiteSpace: 'pre-line' }}>{reply.text}</span>
          </div>
        </Card>
      )}

      <div className="row" style={{ marginTop: 16, gap: 10 }}>
        <a
          className="btn whatsapp grow"
          aria-disabled={!message || !wa}
          style={!message || !wa ? { opacity: 0.4, pointerEvents: 'none' } : undefined}
          href={`https://wa.me/${wa}?text=${encodeURIComponent(message)}`}
          target="_blank"
          rel="noreferrer"
        >
          <MessageCircle size={20} /> WhatsApp
        </a>
        <a
          className="btn grow"
          aria-disabled={!message || !sms}
          style={!message || !sms ? { opacity: 0.4, pointerEvents: 'none' } : undefined}
          href={`sms:+${sms}?body=${encodeURIComponent(message)}`}
        >
          <MessageSquareText size={20} /> SMS
        </a>
      </div>
      {!wa && !sms && (
        <p className="small muted" style={{ margin: '8px 4px 0' }}>
          The business WhatsApp/SMS numbers aren't set on the server yet, so use “Test it here” for now.
        </p>
      )}

      <SectionTitle>All commands</SectionTitle>
      <Card>
        <pre className="small" style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{String(config?.help ?? '')}</pre>
      </Card>
    </main>
  );
}
