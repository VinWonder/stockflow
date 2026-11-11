import { useState } from 'react';
import { CircleCheck } from 'lucide-react';

import { ago } from '../lib/format';
import type { StockLevel } from '../lib/models';
import { useAlertItems, useLocations } from '../lib/queries';
import { fromHex } from '../lib/theme';
import { EmptyState, ErrorView, LoadingList, Progress, TopBar } from '../ui/common';
import { LowRow } from './DashboardScreen';

type State = 'alert' | 'low' | 'out';

/** Live list of items running low or out of stock, across all stores or one. Refreshes itself every few seconds. */
export function AlertsScreen({ initialState, locationId }: { initialState: State; locationId: number | null }) {
  const stores = useLocations().data ?? [];
  const [state, setState] = useState<State>(initialState);
  const [store, setStore] = useState<number | null>(locationId);
  const list = useAlertItems(state, store);
  const rows = list.data ?? [];
  const groups = new Map<number, StockLevel[]>();
  for (const r of rows) groups.set(r.location, [...(groups.get(r.location) ?? []), r]);

  const tabs: { id: State; label: string }[] = [
    { id: 'out', label: 'Out of stock' },
    { id: 'low', label: 'Running low' },
    { id: 'alert', label: 'Both' },
  ];

  return (
    <main className="page">
      <TopBar title="Restock" back>
        <span className="row tiny muted" style={{ gap: 6, paddingRight: 8 }}>
          <span className="live-dot on" /> Live
        </span>
      </TopBar>
      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={state === t.id} className={state === t.id ? 'on' : ''} onClick={() => setState(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {stores.length > 1 && (
        <div className="chip-row" style={{ marginTop: 12 }}>
          <button className={`choice${store == null ? ' on' : ''}`} onClick={() => setStore(null)}>All stores</button>
          {stores.map((s) => (
            <button key={s.id} className={`choice${store === s.id ? ' on' : ''}`} onClick={() => setStore(s.id)}>
              <span className="dot" style={{ background: fromHex(s.color) }} />
              {s.name}
            </button>
          ))}
        </div>
      )}
      {list.isFetching && <Progress />}
      {list.isPending ? (
        <LoadingList />
      ) : list.isError ? (
        <ErrorView error={list.error} onRetry={() => list.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState icon={CircleCheck} title={state === 'out' ? 'Nothing is out of stock' : 'Nothing is running low'} message="This list updates by itself as stock moves." />
      ) : (
        <>
          <p className="small muted" style={{ margin: '12px 4px 0' }}>
            {rows.length} item(s) · checked {ago(new Date(list.dataUpdatedAt))}. Tap ⇄ to bring stock from another store.
          </p>
          {[...groups.entries()].map(([loc, items]) => (
            <section key={loc}>
              <div className="section-title">
                <h2>{items[0].location_name ?? items[0].location_code}</h2>
                <span className="small muted">{items.length}</span>
              </div>
              <div className="list">
                {items.map((level) => (
                  <LowRow key={level.id} level={level} showStore={false} />
                ))}
              </div>
            </section>
          ))}
        </>
      )}
    </main>
  );
}
