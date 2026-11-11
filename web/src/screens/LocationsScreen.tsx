import { useNavigate } from 'react-router-dom';
import { ChevronRight, MapPin, Plus, Store, Warehouse } from 'lucide-react';

import { useMe } from '../lib/auth';
import { moneyShort } from '../lib/format';
import { hasPoint, isGodown, kindLabel, type Location } from '../lib/models';
import { useLocations } from '../lib/queries';
import { darken, fromHex } from '../lib/theme';
import { EmptyState, ErrorView, LoadingList, SectionTitle, TopBar } from '../ui/common';
import { useStoreForm } from '../ui/StoreForm';

/** Every shop and godown of the business (admins) or the ones this person works in, with live stock figures. */
export function LocationsScreen() {
  const me = useMe();
  const locations = useLocations();
  const storeForm = useStoreForm();
  const navigate = useNavigate();
  const all = (locations.data ?? []).filter((l) => l.is_active !== false);
  const shops = all.filter((l) => !isGodown(l));
  const godowns = all.filter(isGodown);

  const add = async () => {
    const l = await storeForm();
    if (l) navigate(`/stores/${l.id}`);
  };

  return (
    <main className="page">
      <TopBar title="Stores">
        {me.is_admin && (
          <button className="btn small tonal" onClick={add}>
            <Plus size={18} /> Add
          </button>
        )}
      </TopBar>
      {locations.isPending ? (
        <LoadingList count={3} />
      ) : locations.isError ? (
        <ErrorView error={locations.error} onRetry={() => locations.refetch()} />
      ) : all.length === 0 ? (
        <EmptyState
          icon={Store}
          title="No stores yet"
          message={me.is_admin ? 'Add your shops and godowns.' : 'Ask the owner to add you to a store.'}
          action={me.is_admin ? 'Add a store' : undefined}
          onAction={add}
        />
      ) : (
        <>
          <p className="small muted" style={{ margin: '0 4px' }}>
            {me.is_admin
              ? `${shops.length} shop(s) and ${godowns.length} godown(s) in ${me.business?.name ?? 'your business'}.`
              : 'The stores you work in.'}
          </p>
          {shops.length > 0 && <SectionTitle>Shops</SectionTitle>}
          <div className="stack">
            {shops.map((l) => (
              <StoreCard key={l.id} location={l} />
            ))}
          </div>
          {godowns.length > 0 && <SectionTitle>Godowns &amp; stores</SectionTitle>}
          <div className="stack">
            {godowns.map((l) => (
              <StoreCard key={l.id} location={l} />
            ))}
          </div>
        </>
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
          <span style={{ opacity: 0.8, fontWeight: 600 }}>
            {location.code} · {kindLabel(location)}
            {isGodown(location) && location.can_sell ? ' · sells' : ''}
            {!isGodown(location) && !location.can_sell ? ' · selling off' : ''}
          </span>
          {location.address && (
            <span className="tiny" style={{ opacity: 0.8, display: 'flex', alignItems: 'center', gap: 4 }}>
              <MapPin size={12} /> {location.address}{hasPoint(location) ? '' : ' (no map pin)'}
            </span>
          )}
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
