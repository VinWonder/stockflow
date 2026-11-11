import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownLeft, ArrowLeftRight, Bell, BellOff, CheckCheck, ClipboardCheck, ListChecks, MessageCircle, MessageSquareText,
  MessagesSquare, PackageX, TriangleAlert,
} from 'lucide-react';

import { api } from '../lib/api';
import { useMe } from '../lib/auth';
import { ago } from '../lib/format';
import type { AppNotification, Json } from '../lib/models';
import { useMessageLog, useNotifications, useUnread } from '../lib/queries';
import { alpha, colors } from '../lib/theme';
import { Card, EmptyState, ErrorView, IconBox, LoadingList, Pill, TopBar } from '../ui/common';
import { useOverlay } from '../ui/overlay';
import { RequestList } from './RequestScreens';
import { TransferList } from './TransferScreens';

type Tab = 'alerts' | 'todo' | 'transfers' | 'requests' | 'messages';
const TABS: Tab[] = ['alerts', 'todo', 'transfers', 'requests', 'messages'];

function readTab(): Tab {
  try {
    const t = sessionStorage.getItem('inbox-tab') as Tab | null;
    return t && TABS.includes(t) ? t : 'alerts';
  } catch {
    return 'alerts';
  }
}

export function InboxScreen() {
  const me = useMe();
  const qc = useQueryClient();
  const overlay = useOverlay();
  const navigate = useNavigate();
  const unread = useUnread().data;
  const [tab, setTabState] = useState<Tab>(readTab);
  const setTab = (t: Tab) => {
    setTabState(t);
    try {
      sessionStorage.setItem('inbox-tab', t);
    } catch {
      // ignore
    }
  };

  const markAll = async () => {
    try {
      await api.post('/notifications/read_all/');
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['unread'] });
    } catch (e) {
      overlay.error(e);
    }
  };

  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: 'alerts', label: 'Alerts', badge: unread?.unread },
    { id: 'todo', label: me.is_admin ? 'To approve' : 'To do' },
    { id: 'transfers', label: 'Transfers' },
    { id: 'requests', label: 'Remove / add' },
    ...(me.is_admin ? [{ id: 'messages' as Tab, label: 'SMS & WhatsApp' }] : []),
  ];
  const current = tabs.some((t) => t.id === tab) ? tab : 'alerts';

  return (
    <main className="page">
      <TopBar title="Inbox">
        <button className="icon-btn" onClick={() => navigate('/compose')} aria-label="Send a command" title="Send a command">
          <MessageSquareText size={22} />
        </button>
        <button className="icon-btn" onClick={markAll} aria-label="Mark all read" title="Mark all read">
          <CheckCheck size={22} />
        </button>
      </TopBar>
      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={current === t.id} className={current === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
            {t.label}
            {t.badge ? <span className="tab-badge">{t.badge > 99 ? '99+' : t.badge}</span> : null}
          </button>
        ))}
      </div>
      <div style={{ paddingTop: 16 }}>
        {current === 'alerts' && <Notifications />}
        {current === 'todo' && <RequestList status={me.is_admin ? 'confirmed' : 'pending'} />}
        {current === 'transfers' && <TransferList status="requested,approved,in_transit" />}
        {current === 'requests' && <RequestList status="" />}
        {current === 'messages' && <MessageLog />}
      </div>
    </main>
  );
}

const icons = { transfer: ArrowLeftRight, request: ClipboardCheck, low_stock: TriangleAlert, receipt: ArrowDownLeft, count: ListChecks };
const tints: Record<string, string> = { low_stock: colors.amber, request: colors.info, transfer: colors.violet, receipt: colors.success, count: colors.steel };

function Notifications() {
  const list = useNotifications();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const overlay = useOverlay();

  const openOne = async (n: AppNotification) => {
    try {
      if (!n.is_read) await api.post(`/notifications/${n.id}/read/`);
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['unread'] });
    } catch (e) {
      overlay.error(e);
      return;
    }
    if (n.ref_type === 'transfer' && n.ref_id) navigate(`/transfers/${n.ref_id}`);
    else if (n.ref_type === 'request' && n.ref_id) navigate(`/requests/${n.ref_id}`);
    else if (n.ref_type === 'level') navigate(n.title.startsWith('Out') ? '/alerts?state=out' : '/alerts?state=low');
    else if (n.ref_type === 'receipt') navigate('/stores');
  };

  if (list.isPending) return <LoadingList />;
  if (list.isError) return <ErrorView error={list.error} onRetry={() => list.refetch()} />;
  if (list.data.length === 0) return <EmptyState icon={BellOff} title="No alerts yet" message="Transfers, approvals, deliveries and low stock show up here." />;

  return (
    <div className="list">
      {list.data.map((n) => {
        const out = n.kind === 'low_stock' && n.title.startsWith('Out');
        const c = out ? colors.danger : tints[n.kind] ?? colors.slate;
        const Icon = out ? PackageX : icons[n.kind as keyof typeof icons] ?? Bell;
        return (
          <Card key={n.id} onClick={() => openOne(n)} style={{ background: n.is_read ? undefined : alpha(c, 0.06) }}>
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <IconBox icon={Icon} color={c} />
              <div className="col grow">
                <span style={{ fontWeight: n.is_read ? 600 : 800 }}>{n.title}</span>
                {n.body && <span style={{ fontSize: 13 }}>{n.body}</span>}
                <div className="row" style={{ gap: 8, marginTop: 4 }}>
                  <span className="tiny muted">{ago(n.created_at)}</span>
                  {n.needs_action && !n.is_read && <Pill text="Action needed" color={colors.danger} />}
                </div>
              </div>
              {!n.is_read && <span style={{ width: 9, height: 9, borderRadius: '50%', background: c, marginTop: 6, flex: 'none' }} />}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

/** Every SMS / WhatsApp command received and reply sent, so the owner can see what staff did by message. */
function MessageLog() {
  const log = useMessageLog(true);
  if (log.isPending) return <LoadingList />;
  if (log.isError) return <ErrorView error={log.error} onRetry={() => log.refetch()} />;
  if (log.data.length === 0) {
    return <EmptyState icon={MessagesSquare} title="No messages yet" message="Commands sent by staff by SMS or WhatsApp, and the replies, appear here." />;
  }
  return (
    <div className="list">
      {(log.data as Json[]).map((m) => {
        const incoming = m.direction === 'in';
        const failed = String(m.status).startsWith('failed') || m.status === 'error' || m.status === 'rejected';
        return (
          <div key={m.id} className={`msg ${incoming ? 'in' : 'out'}`}>
            <div className="row tiny" style={{ gap: 6, marginBottom: 4 }}>
              {m.channel === 'whatsapp' ? <MessageCircle size={13} /> : <MessageSquareText size={13} />}
              <span className="bold">{incoming ? m.user ?? `+${m.phone}` : `To ${m.user ?? `+${m.phone}`}`}</span>
              <span className="muted">· {ago(m.created_at)}</span>
              {failed && <Pill text={m.status} color={colors.danger} />}
            </div>
            <div style={{ whiteSpace: 'pre-line' }}>{m.body}</div>
            {m.result && incoming && <div className="tiny muted" style={{ marginTop: 4 }}>→ {m.result}</div>}
          </div>
        );
      })}
    </div>
  );
}
