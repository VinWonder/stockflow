import { Phone, Plus, Truck } from 'lucide-react';

import { money } from '../lib/format';
import { useSuppliers } from '../lib/queries';
import { BottomActions, Card, EmptyState, ErrorView, LoadingList, TopBar } from '../ui/common';
import { useOverlay } from '../ui/overlay';
import { useAddSupplier } from '../ui/pickers';

export function SuppliersScreen() {
  const list = useSuppliers();
  const overlay = useOverlay();
  const addSupplier = useAddSupplier();

  return (
    <main className="page with-actions">
      <TopBar title="Suppliers" back />
      {list.isPending ? (
        <LoadingList />
      ) : list.isError ? (
        <ErrorView error={list.error} onRetry={() => list.refetch()} />
      ) : list.data.length === 0 ? (
        <EmptyState icon={Truck} title="No suppliers yet" />
      ) : (
        <div className="list">
          {list.data.map((s) => (
            <Card key={s.id}>
              <div className="row">
                <span className="avatar">{s.name[0]?.toUpperCase()}</span>
                <div className="col grow">
                  <span className="heavy">{s.name}</span>
                  {(s.contact_person || s.phone) && <span className="small">{[s.contact_person, s.phone].filter(Boolean).join(' · ')}</span>}
                  <span className="small muted">{s.deliveries} deliveries · {money(s.total_supplied)} supplied{s.product_count ? ` · ${s.product_count} products` : ''}</span>
                  {Number(s.owed ?? 0) > 0 && <span className="small bold" style={{ color: '#C2410C' }}>You owe {money(s.owed)}</span>}
                </div>
                {s.phone && (
                  <a className="icon-btn" href={`tel:${s.phone}`} aria-label={`Call ${s.name}`}>
                    <Phone size={20} />
                  </a>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
      <BottomActions>
        <button
          className="btn"
          onClick={async () => {
            const s = await addSupplier();
            if (s) overlay.success(`${s.name} added`);
          }}
        >
          <Plus size={20} /> Supplier
        </button>
      </BottomActions>
    </main>
  );
}
