import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowLeftRight, Bell, BellOff, CheckCheck, ClipboardCheck, ListChecks, TriangleAlert } from 'lucide-react';

import { api } from '../lib/api';
import { useMe } from '../lib/auth';
import { ago } from '../lib/format';
import type { AppNotification } from '../lib/models';
import { useNotifications } from '../lib/queries';
import { alpha, colors } from '../lib/theme';
import { Card, EmptyState, ErrorView, IconBox, LoadingList, Pill, TopBar } from '../ui/common';
import { useOverlay } from '../ui/overlay';
import { RequestList } from './RequestScreens';
import { TransferList } from './TransferScreens';

type Tab = 'alerts' | 'todo' | 'transfers' | 'requests';

function readTab(): Tab {
  try {
    const t = sessionStorage.getItem('inbox-tab');
    return t === 'todo' || t === 'transfers' || t === 'requests' ? t : 'alerts';
  } catch {
    return 'alerts';
  }
}

export function InboxScreen() {
  const me = useMe();
  const qc = useQueryClient();
  const overlay = useOverlay();
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

  const tabs: { id: Tab; label: string }[] = [
    { id: 'alerts', label: 'Alerts' },
    { id: 'todo', label: me.is_admin ? 'To approve' : 'To do' },
    { id: 'transfers', label: 'Transfers' },
    { id: 'requests', label: 'All requests' },
  ];

  return (
    <main className="page">
      <TopBar title="Inbox">
        <button className="icon-btn" onClick={markAll} aria-label="Mark all read" title="Mark all read">
          <CheckCheck size={22} />
        </button>
      </TopBar>
      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div style={{ paddingTop: 16 }}>
        {tab === 'alerts' && <Notifications />}
        {tab === 'todo' && <RequestList status={me.is_admin ? 'confirmed' : 'pending'} />}
        {tab === 'transfers' && <TransferList status="" />}
        {tab === 'requests' && <RequestList status="" />}
      </div>
    </main>
  );
}

const icons = { transfer: ArrowLeftRight, request: ClipboardCheck, low_stock: TriangleAlert, receipt: ArrowDownLeft, count: ListChecks };
const tints: Record<string, string> = { low_stock: colors.amber, request: colors.info, transfer: colors.violet, receipt: colors.success };

function Notifications() {
  const list = useNotifications();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const openOne = (n: AppNotification) => {
    api.post(`/notifications/${n.id}/read/`).then(() => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['unread'] });
    }, () => {});
    if (n.ref_id == null) return;
    if (n.ref_type === 'transfer') navigate(`/transfers/${n.ref_id}`);
    if (n.ref_type === 'request') navigate(`/requests/${n.ref_id}`);
    if (n.ref_type === 'level') navigate('/stores');
  };

  if (list.isPending) return <LoadingList />;
  if (list.isError) return <ErrorView error={list.error} onRetry={() => list.refetch()} />;
  if (list.data.length === 0) return <EmptyState icon={BellOff} title="No alerts yet" />;

  return (
    <div className="list">
      {list.data.map((n) => {
        const c = tints[n.kind] ?? colors.slate;
        const Icon = icons[n.kind as keyof typeof icons] ?? Bell;
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
