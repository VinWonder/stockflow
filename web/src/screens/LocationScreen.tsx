import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowDownLeft, ArrowLeft, ArrowLeftRight, MapPin, MessageSquareText, Package, PackageMinus, PackagePlus, PackageX,
  Search, Settings, ShoppingCart, TriangleAlert, type LucideIcon,
} from 'lucide-react';

import { useMe } from '../lib/auth';
import { moneyShort, qty, toD } from '../lib/format';
import { canManage, hasPoint, type StockLevel } from '../lib/models';
import { useLocations, useStock } from '../lib/queries';
import { alpha, colors, darken, fromHex } from '../lib/theme';
import { Card, EmptyState, ErrorView, Pill, Progress, useBack } from '../ui/common';
import { mapsLink } from '../ui/MapView';
import { useStoreForm } from '../ui/StoreForm';
import { Stat } from './LocationsScreen';

type Filter = '' | 'low' | 'out';

/** One page per store: summary header, searchable live stock list, and actions for this store. */
export function LocationScreen({ locationId }: { locationId: number }) {
  const me = useMe();
  const navigate = useNavigate();
  const back = useBack();
  const storeForm = useStoreForm();
  const loc = useLocations().data?.find((l) => l.id === locationId);
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [filter, setFilter] = useState<Filter>('');
  const stock = useStock(locationId, term, filter);
  const color = fromHex(loc?.color);
  const manage = canManage(me, locationId);
  const s = loc?.summary;

  useEffect(() => {
    const t = window.setTimeout(() => setTerm(search.trim()), 350);
    return () => window.clearTimeout(t);
  }, [search]);

  const go = (path: string) => () => navigate(path);
  const actions: { icon: LucideIcon; label: string; to: string; show?: boolean }[] = [
    { icon: ShoppingCart, label: 'Sell', to: `/sell?location=${locationId}`, show: loc?.can_sell ?? false },
    { icon: ArrowDownLeft, label: 'Receive', to: `/receive?location=${locationId}`, show: manage },
    { icon: ArrowLeftRight, label: 'Transfer out', to: `/transfers/new?from=${locationId}` },
    { icon: PackageMinus, label: 'Remove', to: `/requests/new?location=${locationId}&kind=remove` },
    { icon: PackagePlus, label: 'Add', to: `/requests/new?location=${locationId}&kind=add` },
    { icon: MessageSquareText, label: 'By message', to: `/compose?location=${locationId}` },
  ];

  const rows = stock.data ?? [];
  const filtering = term !== '' || filter !== '';

  return (
    <main className="page">
      <div className="store-header" style={{ background: `linear-gradient(135deg, ${color}, ${darken(color, 0.4)})` }}>
        <div className="row" style={{ gap: 8, minHeight: 44 }}>
          <button className="icon-btn" onClick={back} aria-label="Back">
            <ArrowLeft size={22} />
          </button>
          <div className="col grow">
            <h1 className="ellipsis" style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>{loc?.name ?? 'Store'}</h1>
            {loc?.address && <span className="tiny" style={{ opacity: 0.8 }}>{loc.address}</span>}
          </div>
          {loc && hasPoint(loc) && (
            <a className="icon-btn" href={mapsLink({ lat: loc.latitude!, lng: loc.longitude! })} target="_blank" rel="noreferrer" aria-label="Open in Google Maps">
              <MapPin size={22} />
            </a>
          )}
          {me.is_admin && loc && (
            <button className="icon-btn" aria-label="Store settings" onClick={() => storeForm(loc)}>
              <Settings size={22} />
            </button>
          )}
        </div>
        {s && (
          <div className="row" style={{ marginTop: 24, padding: '0 4px' }}>
            <Stat label="Stock value" value={moneyShort(s.value)} wide />
            <Stat label="Items" value={`${s.items}`} />
            <Stat label="Low" value={`${s.low}`} warn={s.low > 0} />
            <Stat label="Out" value={`${s.out}`} warn={s.out > 0} />
          </div>
        )}
      </div>

      <div className="hscroll">
        {actions.filter((a) => a.show !== false).map((a) => (
          <Card key={a.label} onClick={go(a.to)} className="action-tile">
            <a.icon size={22} />
            {a.label}
          </Card>
        ))}
      </div>

      <div className="sticky-search" style={{ display: 'grid', gap: 8 }}>
        <div className="input-wrap">
          <Search size={20} />
          <input className="input" type="search" placeholder="Search by name, size or colour" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className={`choice${filter === '' ? ' on' : ''}`} onClick={() => setFilter('')}>All</button>
          <button className={`choice${filter === 'low' ? ' on' : ''}`} onClick={() => setFilter('low')}>
            <TriangleAlert size={16} /> Low {s ? `(${s.low})` : ''}
          </button>
          <button className={`choice${filter === 'out' ? ' on' : ''}`} onClick={() => setFilter('out')}>
            <PackageX size={16} /> Out {s ? `(${s.out})` : ''}
          </button>
        </div>
      </div>

      {stock.isFetching && <Progress />}
      {stock.isError ? (
        <ErrorView error={stock.error} onRetry={() => stock.refetch()} />
      ) : stock.isPending ? null : rows.length === 0 ? (
        <EmptyState
          icon={Package}
          title={filtering ? 'Nothing here' : 'No stock here yet'}
          message={filtering ? undefined : 'Receive a supplier delivery or transfer goods in.'}
          action={manage && !filtering ? 'Receive delivery' : undefined}
          onAction={go(`/receive?location=${locationId}`)}
        />
      ) : (
        <div className="list" style={{ paddingTop: 4 }}>
          {rows.map((level) => (
            <StockTile key={level.id} level={level} />
          ))}
        </div>
      )}
    </main>
  );
}

function StockTile({ level }: { level: StockLevel }) {
  const navigate = useNavigate();
  const q = toD(level.quantity);
  const reorder = toD(level.reorder_at);
  const out = q <= 0;
  const c = out ? colors.danger : level.is_low ? colors.amber : colors.success;
  const ratio = reorder <= 0 ? 1 : Math.min(1, Math.max(0, q / (reorder * 3)));
  const v = level.variant;
  return (
    <Card onClick={() => navigate(`/item/${level.location}/${v.id}`)} style={{ padding: '12px 14px' }}>
      <div className="row">
        <span className="icon-box" style={{ width: 44, height: 44, background: 'var(--primary-soft)', color: 'var(--primary)', fontWeight: 800, fontSize: 18 }}>
          {v.product_name[0] ?? '?'}
        </span>
        <div className="col grow">
          <span className="heavy">{v.product_name}</span>
          <div className="wrap" style={{ gap: 6, marginTop: 2 }}>
            {v.size && <Pill text={v.size} color={colors.steel} />}
            {v.colour && <Pill text={v.colour} color={colors.violet} />}
            {level.bin_location && <Pill text={level.bin_location} icon={MapPin} color={colors.slate} />}
            {out ? <Pill text="Out" color={colors.danger} /> : level.is_low ? <Pill text="Low" color={colors.amber} /> : null}
          </div>
          <div className="bar" style={{ marginTop: 8, background: alpha(c, 0.12) }}>
            <div style={{ width: `${ratio * 100}%`, background: c }} />
          </div>
        </div>
        <div className="col right" style={{ marginLeft: 2 }}>
          <span style={{ fontSize: 20, fontWeight: 800, color: out ? colors.danger : undefined }}>{qty(q)}</span>
          <span className="tiny muted">{v.unit}</span>
        </div>
      </div>
    </Card>
  );
}
