import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Banknote, ClipboardCheck, Clock, HandCoins, MessageSquareText, Package,
  PackageMinus, PackageX, RefreshCw, Route, ShoppingCart, Smartphone, TrendingDown, TrendingUp, Truck, TriangleAlert,
  type LucideIcon,
} from 'lucide-react';

import { useMe } from '../lib/auth';
import { ago, money, moneyShort, qty, toD } from '../lib/format';
import { displayName, initials, isGodown, isManager, type Json, type Location, type Me, type Movement, type StockLevel } from '../lib/models';
import { useDashboard, useLocations, useRefreshEverything, useStockAlerts } from '../lib/queries';
import { alpha, colors, fromHex } from '../lib/theme';
import { Card, ErrorView, IconBox, KpiTile, LoadingList, Pill, SectionTitle, TopBar } from '../ui/common';

const STORE_KEY = 'dashboard-store';

function readStore(): number | null {
  try {
    const v = localStorage.getItem(STORE_KEY);
    return v && /^\d+$/.test(v) ? Number(v) : null;
  } catch {
    return null;
  }
}

export function DashboardScreen() {
  const me = useMe();
  const navigate = useNavigate();
  const refresh = useRefreshEverything();
  const stores = useLocations().data ?? [];
  const [storeId, setStoreIdState] = useState<number | null>(readStore);
  const selected = stores.find((s) => s.id === storeId) ?? null;
  const effective = selected ? selected.id : null; // a remembered store that no longer exists falls back to "all"
  const dash = useDashboard(effective);
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  const setStore = (id: number | null) => {
    setStoreIdState(id);
    try {
      if (id == null) localStorage.removeItem(STORE_KEY);
      else localStorage.setItem(STORE_KEY, String(id));
    } catch {
      // private mode
    }
  };

  return (
    <main className="page">
      <TopBar
        title={
          <span className="col">
            <span className="tiny muted" style={{ fontWeight: 600 }}>{greeting}, {displayName(me).split(' ')[0]}</span>
            <span className="ellipsis">{me.business?.name ?? 'StockFlow'}</span>
          </span>
        }
      >
        <button className="icon-btn" onClick={() => refresh()} aria-label="Refresh" title="Refresh">
          <RefreshCw size={20} className={dash.isFetching ? 'spinning' : undefined} />
        </button>
        <button className="icon-btn" onClick={() => navigate('/compose')} aria-label="Message command" title="Message command">
          <MessageSquareText size={20} />
        </button>
        <button className="avatar" style={{ border: 0, cursor: 'pointer' }} onClick={() => navigate('/settings')} aria-label="My account">
          {initials(displayName(me))}
        </button>
      </TopBar>

      {stores.length > 1 && <StoreChips stores={stores} value={effective} onChange={setStore} />}

      {dash.isPending ? (
        <LoadingList count={5} />
      ) : dash.isError ? (
        <ErrorView error={dash.error} onRetry={() => dash.refetch()} />
      ) : (
        <DashboardBody me={me} d={dash.data} store={selected} />
      )}
    </main>
  );
}

function StoreChips({ stores, value, onChange }: { stores: Location[]; value: number | null; onChange: (id: number | null) => void }) {
  return (
    <div className="chip-row" role="radiogroup" aria-label="Show figures for">
      <button role="radio" aria-checked={value == null} className={`choice${value == null ? ' on' : ''}`} onClick={() => onChange(null)}>
        All stores
      </button>
      {stores.map((s) => (
        <button key={s.id} role="radio" aria-checked={value === s.id} className={`choice${value === s.id ? ' on' : ''}`} onClick={() => onChange(s.id)}>
          <span className="dot" style={{ background: fromHex(s.color) }} />
          {s.name}
          {isGodown(s) && <span className="tiny muted">godown</span>}
        </button>
      ))}
    </div>
  );
}

function Delta({ now, before }: { now: unknown; before: unknown }) {
  const a = toD(now);
  const b = toD(before);
  if (b <= 0 && a <= 0) return null;
  if (b <= 0) return <span className="delta up"><TrendingUp size={14} /> new today</span>;
  const pct = Math.round(((a - b) / b) * 100);
  const up = pct >= 0;
  return (
    <span className={`delta ${up ? 'up' : 'down'}`} title={`Yesterday by this time: ${money(b)}`}>
      {up ? <TrendingUp size={14} /> : <TrendingDown size={14} />} {up ? '+' : ''}{pct}% vs yesterday
    </span>
  );
}

function DashboardBody({ me, d, store }: { me: Me; d: Json; store: Location | null }) {
  const navigate = useNavigate();
  const alerts = useStockAlerts(store?.id ?? null).data;
  const t = d.totals ?? {};
  const a = d.action_needed ?? {};
  const low = alerts?.low ?? t.low_stock ?? 0;
  const out = alerts?.out ?? t.out_of_stock ?? 0;
  const where = store ? `location=${store.id}&` : '';
  const actions: { label: string; count: number; icon: LucideIcon; color: string; to: string }[] = [
    ...(me.is_admin ? [{ label: 'Stock changes to approve', count: a.requests_waiting_approval, icon: ClipboardCheck, color: colors.info, to: '/inbox' }] : []),
    ...(isManager(me) ? [{ label: 'Removals / additions waiting for you', count: a.requests_waiting_manager, icon: PackageMinus, color: colors.amber, to: '/inbox' }] : []),
    ...(me.is_admin ? [{ label: 'Transfers to approve', count: a.transfers_to_approve, icon: ArrowLeftRight, color: colors.amber, to: '/transfers' }] : []),
    { label: 'Transfers to dispatch', count: a.transfers_to_dispatch, icon: Truck, color: colors.info, to: '/transfers' },
    { label: 'Goods on the way (live map)', count: a.transfers_in_transit, icon: Route, color: colors.violet, to: '/transfers' },
  ].filter((x) => (x.count ?? 0) > 0);

  const lowItems = (d.low_stock_items ?? []) as StockLevel[];
  const outItems = (d.out_of_stock_items ?? []) as StockLevel[];
  const top = (d.top_moving_30d ?? []) as Json[];
  const recent = (d.recent_movements ?? []) as Movement[];
  const best = (d.best_sellers_today ?? []) as Json[];
  const byStore = (d.today_by_store ?? []) as Json[];
  const collected = (t.collected_today ?? {}) as Record<string, string>;
  const potential = toD(t.retail_value) - toD(t.stock_value);
  const canSellHere = !store || store.can_sell;

  return (
    <>
      <div className="hero">
        <div className="row">
          <div className="col grow">
            <span style={{ opacity: 0.8, fontWeight: 600 }}>Stock value at cost · {store ? store.name : 'all stores'}</span>
            <span style={{ fontSize: 30, fontWeight: 800, letterSpacing: -1, margin: '6px 0 4px' }}>{money(t.stock_value)}</span>
            <span style={{ opacity: 0.8, fontSize: 12.5 }}>
              {t.items_in_stock ?? 0} items · sells for {moneyShort(t.retail_value)}
              {me.is_admin && potential > 0 ? ` (≈${moneyShort(potential)} profit)` : ''}
            </span>
          </div>
          <span className="icon-box" style={{ width: 54, height: 54, borderRadius: 16, background: 'rgba(255,255,255,.12)', color: colors.amber }}>
            <Package size={30} />
          </span>
        </div>
        <div className="row tiny" style={{ marginTop: 12, opacity: 0.85, gap: 6 }}>
          <span className="live-dot on" /> Live · updated {ago(d.generated_at) || 'just now'}
        </div>
      </div>

      <div className="grid-2" style={{ marginTop: 12 }}>
        <KpiTile
          label="Running low"
          value={`${low}`}
          icon={TriangleAlert}
          color={colors.amber}
          onClick={() => navigate(`/alerts?${where}state=low`)}
        />
        <KpiTile label="Out of stock" value={`${out}`} icon={PackageX} color={colors.danger} onClick={() => navigate(`/alerts?${where}state=out`)} />
      </div>

      <SectionTitle action={canSellHere ? 'Sell' : undefined} onAction={() => navigate(store ? `/sell?location=${store.id}` : '/sell')}>
        Today{store ? ` at ${store.name}` : ''}
      </SectionTitle>
      <Card>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div className="col grow">
            <span className="small muted">Sales ({t.sales_count_today ?? 0})</span>
            <span style={{ fontSize: 28, fontWeight: 800, letterSpacing: -0.5 }}>{money(t.sales_today)}</span>
            <Delta now={t.sales_today} before={t.sales_yesterday_same_time} />
          </div>
          {me.is_admin && (
            <div className="col right">
              <span className="small muted">Profit</span>
              <span style={{ fontSize: 22, fontWeight: 800, color: toD(t.profit_today) < 0 ? colors.danger : colors.success }}>{money(t.profit_today)}</span>
              <span className="tiny muted">{t.margin_today != null ? `${t.margin_today}% margin` : 'no sales yet'}</span>
            </div>
          )}
        </div>
        <div className="mini-stats">
          <div><b>{money(t.average_sale_today)}</b><span>average sale</span></div>
          <div><b>{qty(t.items_sold_today)}</b><span>units sold</span></div>
          <div><b>{money(t.collected_today_total)}</b><span>money in</span></div>
        </div>
        <div className="wrap" style={{ marginTop: 12 }}>
          <Pill text={`Cash ${money(collected.cash ?? 0)}`} color={colors.success} icon={Banknote} />
          <Pill text={`M-Pesa ${money(collected.mpesa ?? 0)}`} color={colors.success} icon={Smartphone} />
          {toD(collected.bank) + toD(collected.card) > 0 && <Pill text={`Bank/card ${money(toD(collected.bank) + toD(collected.card))}`} color={colors.info} />}
          {toD(t.credit_given_today) > 0 && <Pill text={`On credit ${money(t.credit_given_today)}`} color={colors.amber} icon={Clock} />}
        </div>
        {toD(t.credit_owed) > 0 && (
          <button className="owed-row" onClick={() => navigate('/customers')}>
            <HandCoins size={18} />
            <span className="grow">Customers owe <b>{money(t.credit_owed)}</b></span>
            {toD(t.credit_overdue) > 0 && <Pill text={`${money(t.credit_overdue)} overdue`} color={colors.danger} />}
          </button>
        )}
      </Card>

      {actions.length > 0 && (
        <>
          <SectionTitle>Needs your attention</SectionTitle>
          <div className="list">
            {actions.map((x) => (
              <Card key={x.label} onClick={() => navigate(x.to)} style={{ padding: '12px 14px' }}>
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
        <Quick icon={ShoppingCart} label="Sell" onClick={() => navigate(store?.can_sell ? `/sell?location=${store.id}` : '/sell')} />
        <Quick icon={ArrowDownLeft} label="Receive delivery" onClick={() => navigate(store ? `/receive?location=${store.id}` : '/receive')} />
        <Quick icon={ArrowLeftRight} label="Transfer" onClick={() => navigate(store ? `/transfers/new?from=${store.id}` : '/transfers/new')} />
        <Quick icon={PackageMinus} label="Remove / add" onClick={() => navigate(store ? `/requests/new?location=${store.id}&kind=remove` : '/requests/new?kind=remove')} />
      </div>

      {!store && byStore.length > 1 && (
        <>
          <SectionTitle>Today by store</SectionTitle>
          <Card style={{ padding: '6px 0' }}>
            {byStore.map((r) => (
              <div key={r.location} className="row" style={{ padding: '8px 16px' }}>
                <span className="bold grow">{r.name}</span>
                <span className="small muted">{r.count} sale(s)</span>
                <span className="heavy" style={{ minWidth: 96, textAlign: 'right' }}>{moneyShort(r.revenue)}</span>
              </div>
            ))}
          </Card>
        </>
      )}

      {best.length > 0 && (
        <>
          <SectionTitle>Best sellers today</SectionTitle>
          <Card style={{ padding: '6px 0' }}>
            {best.map((b, i) => (
              <div key={b.variant} className="row" style={{ padding: '8px 16px' }}>
                <span className="avatar" style={{ width: 28, height: 28, fontSize: 12 }}>{i + 1}</span>
                <div className="col grow">
                  <span className="bold ellipsis">{b.name}</span>
                  <span className="small muted">{qty(b.quantity)} {b.unit}</span>
                </div>
                <span className="heavy">{moneyShort(b.revenue)}</span>
              </div>
            ))}
          </Card>
        </>
      )}

      {(outItems.length > 0 || lowItems.length > 0) && (
        <>
          <SectionTitle action="See all" onAction={() => navigate(`/alerts?${where}state=alert`)}>Restock</SectionTitle>
          <div className="list">
            {[...outItems.slice(0, 4), ...lowItems.slice(0, 6)].map((level) => (
              <LowRow key={level.id} level={level} />
            ))}
          </div>
        </>
      )}

      <SectionTitle>Stock in &amp; out, 14 days</SectionTitle>
      <Card>
        <InOutChart rows={(d.movement_14d ?? []) as Json[]} />
      </Card>

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
        {recent.length === 0 && <p className="muted small">No stock movements yet. Start by receiving a supplier delivery.</p>}
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

export function LowRow({ level, showStore = true }: { level: StockLevel; showStore?: boolean }) {
  const navigate = useNavigate();
  const out = toD(level.quantity) <= 0;
  const c = out ? colors.danger : colors.amber;
  return (
    <Card style={{ padding: '10px 6px 10px 14px', background: alpha(c, 0.04) }}>
      <div className="row" style={{ gap: 10 }}>
        <button className="row grow plain" style={{ gap: 10 }} onClick={() => navigate(`/item/${level.location}/${level.variant.id}`)}>
          {showStore && <Pill text={level.location_code} color={colors.steel} />}
          <div className="col grow" style={{ textAlign: 'left' }}>
            <span className="bold ellipsis">{level.variant.product_name}</span>
            <span className="tiny muted">{[level.variant.options, `reorder at ${qty(level.reorder_at)}`].filter(Boolean).join(' · ')}</span>
          </div>
          <span className="heavy" style={{ color: c, minWidth: 40, textAlign: 'right' }}>{out ? 'Out' : qty(level.quantity)}</span>
        </button>
        <button
          className="icon-btn tonal"
          title="Bring stock here"
          aria-label={`Transfer ${level.variant.label} to ${level.location_code}`}
          onClick={() => navigate(`/transfers/new?to=${level.location}&variant=${level.variant.id}`)}
        >
          <ArrowLeftRight size={18} />
        </button>
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
