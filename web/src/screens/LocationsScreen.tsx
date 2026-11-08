import { useNavigate } from 'react-router-dom';
import { ChevronRight, Store, Warehouse } from 'lucide-react';

import { moneyShort } from '../lib/format';
import { isGodown, kindLabel, type Location } from '../lib/models';
import { useLocations } from '../lib/queries';
import { darken, fromHex } from '../lib/theme';
import { EmptyState, ErrorView, LoadingList, TopBar } from '../ui/common';

export function LocationsScreen() {
  const locations = useLocations();
  return (
    <main className="page">
      <TopBar title="Stores" />
      {locations.isPending ? (
        <LoadingList count={3} />
      ) : locations.isError ? (
        <ErrorView error={locations.error} onRetry={() => locations.refetch()} />
      ) : locations.data.length === 0 ? (
        <EmptyState icon={Store} title="No stores yet" message="An admin can add the godown and shops in the admin panel." />
      ) : (
        <div className="stack" style={{ paddingTop: 4 }}>
          {locations.data.map((l) => (
            <StoreCard key={l.id} location={l} />
          ))}
        </div>
      )}
    </main>
  );
}

function StoreCard({ location }: { location: Location }) {
  const navigate = useNavigate();
  const c = fromHex(location.color);
  const s = location.summary;
  const Icon = isGodown(location) ? Warehouse : Store;
  return (
    <a
      href={`/stores/${location.id}`}
      className="store-card"
      onClick={(e) => {
        e.preventDefault();
        navigate(`/stores/${location.id}`);
      }}
      style={{ background: `linear-gradient(135deg, ${c}, ${darken(c, 0.35)})`, boxShadow: `0 8px 18px ${c}59` }}
    >
      <div className="row">
        <span className="icon-box" style={{ background: 'rgba(255,255,255,.18)', borderRadius: 14, width: 44, height: 44 }}>
          <Icon size={22} />
        </span>
        <div className="col grow">
          <span style={{ fontSize: 18, fontWeight: 800 }}>{location.name}</span>
          <span style={{ opacity: 0.75, fontWeight: 600 }}>{location.code} · {kindLabel(location)}</span>
        </div>
        <ChevronRight size={22} />
      </div>
      <div className="row" style={{ marginTop: 18 }}>
        <Stat label="Value" value={s ? moneyShort(s.value) : '—'} wide />
        <Stat label="Items" value={s ? `${s.items}` : '—'} />
        <Stat label="Low" value={s ? `${s.low}` : '—'} warn={(s?.low ?? 0) > 0} />
        <Stat label="Out" value={s ? `${s.out}` : '—'} warn={(s?.out ?? 0) > 0} />
      </div>
    </a>
  );
}

export function Stat({ label, value, warn, wide }: { label: string; value: string; warn?: boolean; wide?: boolean }) {
  return (
    <div className="col grow" style={wide ? { flex: 1.6 } : undefined}>
      <span className="stat-value" style={{ color: warn ? '#FFD166' : undefined }}>{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}
