import { useEffect, useState } from 'react';
import { Bot, CirclePlay, Copy, MessageCircle, MessageSquareText } from 'lucide-react';

import { api } from '../lib/api';
import { copyText, qtyOut } from '../lib/format';
import { newLine, type Json, type LineDraft, type Location } from '../lib/models';
import { useDirectory, useMessagingConfig, useRefreshEverything } from '../lib/queries';
import { alpha, colors } from '../lib/theme';
import { Card, SectionTitle, TopBar } from '../ui/common';
import { LinesEditor } from '../ui/LinesEditor';
import { useOverlay } from '../ui/overlay';
import { LocationField, usePickLocation, usePickVariant } from '../ui/pickers';

const verbs = {
  REMOVE: 'Ask to remove',
  REMOVED: 'Already removed',
  ADD: 'Ask to add',
  ADDED: 'Already added',
  TRANSFER: 'Transfer',
} as const;
type Verb = keyof typeof verbs;

const reasonTags = ['', 'damaged', 'customer', 'return', 'site', 'expired', 'lost', 'correction'];

const digits = (n: unknown) => String(n ?? '').replace(/[^0-9]/g, '');

/** Builds a correct SMS/WhatsApp stock command from a form, then opens WhatsApp or SMS. */
export function ComposeScreen({ locationId }: { locationId: number | null }) {
  const overlay = useOverlay();
  const refresh = useRefreshEverything();
  const pickVariant = usePickVariant();
  const pickLocation = usePickLocation();
  const all = useDirectory().data;
  const config = useMessagingConfig().data;
  const [verb, setVerb] = useState<Verb>('REMOVE');
  const [from, setFrom] = useState<Location | null>(null);
  const [to, setTo] = useState<Location | null>(null);
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [reason, setReason] = useState('');
  const [reply, setReply] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!all || ready) return;
    const f = all.find((l) => l.id === locationId) ?? all.find((l) => l.kind === 'godown') ?? null;
    setFrom(f);
    setTo(all.find((l) => l.is_main && l.id !== f?.id) ?? null);
    setReady(true);
  }, [all, ready, locationId]);

  const wa = digits(config?.whatsapp_number);
  const sms = digits(config?.sms_number);
  const registered = (config?.phone_registered ?? true) as boolean;

  let message = '';
  if (from && lines.length) {
    const items = lines.map((l) => `${l.variant.sku} ${qtyOut(l.quantity)}`).join(', ');
    const head = verb === 'TRANSFER' ? `TRANSFER ${from.code}>${to?.code ?? '?'}` : `${verb} ${from.code}`;
    const tag = reason === '' || verb === 'TRANSFER' ? '' : ` #${reason}`;
    message = `${head}: ${items}${tag}`;
  }

  const add = async () => {
    if (!from) return;
    const removing = verb === 'REMOVE' || verb === 'REMOVED' || verb === 'TRANSFER';
    const picked = await pickVariant({ locationId: from.id, inStockOnly: removing });
    if (!picked || lines.some((l) => l.variant.id === picked.variant.id)) return;
    setLines([...lines, newLine(picked.variant, picked.available)]);
  };

  const simulate = async () => {
    try {
      const r = await api.post<Json>('/messaging/simulate/', { text: message });
      setReply((r.reply as string) ?? null);
      refresh();
    } catch (e) {
      overlay.error(e);
    }
  };

  return (
    <main className="page">
      <TopBar title="Message command" back />
      {!registered && (
        <Card style={{ marginBottom: 12, background: alpha(colors.amber, 0.12) }}>
          Your phone number is not registered, so messages from your phone will be ignored. Ask the admin to add it to your account.
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
            const l = await pickLocation(all ?? []);
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

      <SectionTitle>Products</SectionTitle>
      <LinesEditor lines={lines} onChange={setLines} onAdd={add} checkAvailable={verb !== 'ADD' && verb !== 'ADDED'} />

      {verb !== 'TRANSFER' && (
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
          {message || 'Add a product to build the message'}
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

      {reply && (
        <Card style={{ marginTop: 10 }}>
          <div className="row">
            <Bot size={22} />
            <span className="grow" style={{ whiteSpace: 'pre-line' }}>{reply}</span>
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
        <p className="small" style={{ margin: '8px 4px 0' }}>
          Business WhatsApp/SMS numbers are not set on the server yet (BUSINESS_WHATSAPP_NUMBER / BUSINESS_SMS_NUMBER in .env).
        </p>
      )}
      <button className="btn outline block" style={{ marginTop: 10 }} disabled={!message} onClick={simulate}>
        <CirclePlay size={20} /> Run it now without sending a message
      </button>
    </main>
  );
}
