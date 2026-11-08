import { useNavigate } from 'react-router-dom';
import {
  ArrowDownLeft, ArrowLeftRight, ArrowUpRight, CalendarDays, ClipboardCheck, MessageSquareText, Package, PackageMinus,
  RefreshCw, Route, ShoppingCart, TrendingUp, Truck, TriangleAlert, type LucideIcon,
} from 'lucide-react';

import { useMe } from '../lib/auth';
import { ago, money, moneyShort, qty, toD } from '../lib/format';
import { displayName, initials, isManager, type Json, type Me, type Movement, type StockLevel } from '../lib/models';
import { useDashboard, useRefreshEverything } from '../lib/queries';
import { colors } from '../lib/theme';
import { Card, ErrorView, IconBox, KpiTile, LoadingList, Pill, SectionTitle, TopBar } from '../ui/common';

export function DashboardScreen() {
  const me = useMe();
  const dash = useDashboard();
  const refresh = useRefreshEverything();
  const navigate = useNavigate();
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <main className="page">
      <TopBar
        title={
          <span className="col">
            <span className="tiny muted" style={{ fontWeight: 600 }}>{greeting},</span>
            <span>{displayName(me).split(' ')[0]}</span>
          </span>
        }
      >
        <button className="icon-btn" onClick={() => refresh()} aria-label="Refresh" title="Refresh">
          <RefreshCw size={20} className={dash.isFetching ? 'spinning' : undefined} />
        </button>
        <button className="icon-btn" onClick={() => navigate('/compose')} aria-label="Message command" title="Message command">
          <MessageSquareText size={20} />
        </button>
        <span className="avatar">{initials(displayName(me))}</span>
      </TopBar>
      {dash.isPending ? (
        <LoadingList count={5} />
      ) : dash.isError ? (
        <ErrorView error={dash.error} onRetry={() => dash.refetch()} />
      ) : (
        <DashboardBody me={me} d={dash.data} />
      )}
    </main>
  );
}

function DashboardBody({ me, d }: { me: Me; d: Json }) {
  const navigate = useNavigate();
  const t = d.totals ?? {};
  const a = d.action_needed ?? {};
  const actions: { label: string; count: number; icon: LucideIcon; color: string }[] = [
    ...(me.is_admin ? [{ label: 'Stock changes to approve', count: a.requests_waiting_approval, icon: ClipboardCheck, color: colors.info }] : []),
    ...(isManager(me) ? [{ label: 'Removals waiting for you', count: a.requests_waiting_manager, icon: PackageMinus, color: colors.amber }] : []),
    ...(me.is_admin ? [{ label: 'Transfers to approve', count: a.transfers_to_approve, icon: ArrowLeftRight, color: colors.amber }] : []),
    { label: 'Transfers to dispatch', count: a.transfers_to_dispatch, icon: Truck, color: colors.info },
    { label: 'Goods on the way', count: a.transfers_in_transit, icon: Route, color: colors.violet },
  ].filter((x) => (x.count ?? 0) > 0);

  const lowItems = (d.low_stock_items ?? []) as StockLevel[];
  const top = (d.top_moving_30d ?? []) as Json[];
  const recent = (d.recent_movements ?? []) as Movement[];

  return (
    <>
      <div className="hero row">
        <div className="col grow">
          <span style={{ opacity: 0.75, fontWeight: 600 }}>Stock value (at cost)</span>
          <span style={{ fontSize: 30, fontWeight: 800, letterSpacing: -1, margin: '6px 0 4px' }}>{money(t.stock_value)}</span>
          <span style={{ opacity: 0.75, fontSize: 12.5 }}>{t.items_in_stock ?? 0} items in stock across your stores</span>
        </div>
        <span className="icon-box" style={{ width: 54, height: 54, borderRadius: 16, background: 'rgba(255,255,255,.12)', color: colors.amber }}>
          <Package size={30} />
        </span>
      </div>

      <div className="grid-2 grid-4" style={{ marginTop: 12 }}>
        <KpiTile label={`Today's sales (${t.sales_count_today ?? 0})`} value={moneyShort(t.sales_today)} icon={ShoppingCart} color={colors.success} />
        {me.is_admin ? (
          <KpiTile label="Today's profit" value={moneyShort(t.profit_today)} icon={TrendingUp} color={colors.info} />
        ) : (
          <KpiTile label="Sales, 30 days" value={moneyShort(t.sales_30d)} icon={CalendarDays} color={colors.info} />
        )}
        <KpiTile label="Running low" value={`${t.low_stock ?? 0}`} icon={TriangleAlert} color={colors.amber} onClick={() => navigate('/stores')} />
        <KpiTile label="Out of stock" value={`${t.out_of_stock ?? 0}`} icon={PackageMinus} color={colors.danger} onClick={() => navigate('/stores')} />
      </div>

      {actions.length > 0 && (
        <>
          <SectionTitle>Needs your attention</SectionTitle>
          <div className="list">
            {actions.map((x) => (
              <Card key={x.label} onClick={() => navigate('/inbox')} style={{ padding: '12px 14px' }}>
                <div className="row">
                  <x.icon size={22} color={x.color} />
                  <span className="bold grow">{x.label}</span>
                  <span className="chip" style={{ background: x.color, color: '#fff', fontWeight: 800 }}>{x.count}</span>
                </div>
              </Card>
            ))}
          </div>
        </>
      )}

      <SectionTitle>Quick actions</SectionTitle>
      <div className="grid-2 grid-4">
        <Quick icon={ArrowDownLeft} label="Receive delivery" onClick={() => navigate('/receive')} />
        <Quick icon={ArrowLeftRight} label="Transfer" onClick={() => navigate('/transfers/new')} />
        <Quick icon={ShoppingCart} label="Sell" onClick={() => navigate('/sell')} />
        <Quick icon={PackageMinus} label="Remove stock" onClick={() => navigate('/requests/new?kind=remove')} />
      </div>

      <SectionTitle>Stock in &amp; out, 14 days</SectionTitle>
      <Card>
        <InOutChart rows={(d.movement_14d ?? []) as Json[]} />
      </Card>

      {lowItems.length > 0 && (
        <>
          <SectionTitle action="Stores" onAction={() => navigate('/stores')}>Running low</SectionTitle>
          <div className="list">
            {lowItems.slice(0, 6).map((level) => (
              <LowRow key={level.id} level={level} />
            ))}
          </div>
        </>
      )}

      {top.length > 0 && (
        <>
          <SectionTitle>Fastest moving, 30 days</SectionTitle>
          <Card style={{ padding: '6px 0' }}>
            {top.map((raw, i) => (
              <div key={`${raw.sku}-${i}`} className="row" style={{ padding: '8px 16px' }}>
                <span className="avatar" style={{ width: 28, height: 28, fontSize: 12 }}>{i + 1}</span>
                <div className="col grow">
                  <span className="bold">{raw.name}</span>
                  <span className="small muted">{raw.sku}</span>
                </div>
                <span className="heavy">{qty(raw.quantity)}</span>
              </div>
            ))}
          </Card>
        </>
      )}

      <SectionTitle>Latest activity</SectionTitle>
      <div className="list">
        {recent.slice(0, 8).map((m) => (
          <MoveRow key={m.id} m={m} />
        ))}
        {recent.length === 0 && <p className="muted small">No stock movements yet.</p>}
      </div>
    </>
  );
}

function Quick({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <Card onClick={onClick} style={{ padding: 14 }}>
      <div className="row" style={{ gap: 10 }}>
        <Icon size={22} color="var(--primary)" />
        <span className="bold">{label}</span>
      </div>
    </Card>
  );
}

function LowRow({ level }: { level: StockLevel }) {
  const navigate = useNavigate();
  const out = toD(level.quantity) <= 0;
  return (
    <Card onClick={() => navigate(`/item/${level.location}/${level.variant.id}`)} style={{ padding: '10px 14px' }}>
      <div className="row" style={{ gap: 10 }}>
        <Pill text={level.location_code} color={colors.steel} />
        <div className="col grow">
          <span className="bold">{level.variant.product_name}</span>
          {level.variant.options && <span className="tiny">{level.variant.options}</span>}
        </div>
        <span className="heavy" style={{ color: out ? colors.danger : colors.amber }}>{out ? 'Out' : qty(level.quantity)}</span>
      </div>
    </Card>
  );
}

function MoveRow({ m }: { m: Movement }) {
  const inbound = toD(m.quantity) > 0;
  const c = inbound ? colors.success : colors.danger;
  return (
    <div className="row">
      <IconBox icon={inbound ? ArrowDownLeft : ArrowUpRight} color={c} size={18} box={36} />
      <div className="col grow">
        <span className="bold ellipsis">{m.variant_label}</span>
        <span className="tiny muted ellipsis">{[m.kind_label, m.location_code, m.reference, ago(m.created_at)].filter(Boolean).join(' · ')}</span>
      </div>
      <span className="heavy" style={{ color: c }}>{inbound ? '+' : ''}{qty(m.quantity)}</span>
    </div>
  );
}

/** Paired bars per day: green in, red out. Plain SVG, so there's no chart package to keep up to date. */
function InOutChart({ rows }: { rows: Json[] }) {
  if (rows.length === 0) return <p className="muted" style={{ textAlign: 'center' }}>No stock movements in the last 14 days.</p>;
  const W = 700;
  const H = 150;
  const max = Math.max(1, ...rows.flatMap((r) => [toD(r.in), toD(r.out)]));
  const slot = W / rows.length;
  const barW = Math.min(14, slot / 3);
  const h = (v: unknown) => (toD(v) / max) * (H - 4);
  const label = (r: Json) => (r.day ? new Date(r.day).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '');
  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="150" preserveAspectRatio="none" role="img" aria-label="Stock in and out per day">
        <line x1="0" y1={H / 2} x2={W} y2={H / 2} stroke="var(--border)" />
        <line x1="0" y1={H - 0.5} x2={W} y2={H - 0.5} stroke="var(--border)" />
        {rows.map((r, i) => {
          const x = slot * i + slot / 2;
          return (
            <g key={i}>
              <title>{`${label(r)}: in ${qty(r.in)}, out ${qty(r.out)}`}</title>
              <rect x={x - barW - 1} y={H - h(r.in)} width={barW} height={h(r.in)} rx={Math.min(3, barW / 2)} fill={colors.success} />
              <rect x={x + 1} y={H - h(r.out)} width={barW} height={h(r.out)} rx={Math.min(3, barW / 2)} fill={colors.danger} />
            </g>
          );
        })}
      </svg>
      <div className="row" style={{ justifyContent: 'center', gap: 16, marginTop: 8 }}>
        <Legend color={colors.success} label="In" />
        <Legend color={colors.danger} label="Out" />
      </div>
    </>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="row tiny" style={{ gap: 6 }}>
      <span style={{ width: 10, height: 10, borderRadius: 3, background: color, display: 'inline-block' }} />
      {label}
    </span>
  );
}

