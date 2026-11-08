import { History } from 'lucide-react';

import { dateTime, qty, toD } from '../lib/format';
import type { Movement } from '../lib/models';
import { useMovements } from '../lib/queries';
import { colors } from '../lib/theme';
import { Card, EmptyState, ErrorView, LoadingList, SectionTitle, TopBar } from '../ui/common';

/** Stock card: every movement of one item at one store, newest first. */
export function ItemHistoryScreen({ locationId, variantId }: { locationId: number; variantId: number }) {
  const moves = useMovements(locationId, variantId);
  const list = moves.data ?? [];
  const first = list[0];
  return (
    <main className="page">
      <TopBar title="Item history" back />
      {moves.isPending ? (
        <LoadingList />
      ) : moves.isError ? (
        <ErrorView error={moves.error} onRetry={() => moves.refetch()} />
      ) : !first ? (
        <EmptyState icon={History} title="No movements yet" />
      ) : (
        <>
          <Card>
            <div className="row">
              <div className="col grow">
                <span className="heavy" style={{ fontSize: 17 }}>{first.variant_label}</span>
                <span className="muted" style={{ marginTop: 4 }}>{[first.sku, first.location_code].filter(Boolean).join(' · ')}</span>
              </div>
              <div className="col right">
                <span style={{ fontSize: 26, fontWeight: 800 }}>{qty(first.balance_after)}</span>
                <span className="tiny">on hand</span>
              </div>
            </div>
          </Card>
          <SectionTitle>Movements</SectionTitle>
          {list.map((m, i) => (
            <TimelineRow key={m.id} m={m} last={i === list.length - 1} />
          ))}
        </>
      )}
    </main>
  );
}

function TimelineRow({ m, last }: { m: Movement; last: boolean }) {
  const inbound = toD(m.quantity) > 0;
  const c = inbound ? colors.success : colors.danger;
  return (
    <div className="timeline-row">
      <div className="timeline-rail">
        <span style={{ width: 14, height: 14, borderRadius: '50%', background: c, marginTop: 4 }} />
        {!last && <span className="line" style={{ background: 'var(--border)' }} />}
      </div>
      <div className="col grow" style={{ paddingBottom: 18 }}>
        <div className="row">
          <span className="heavy grow">{m.kind_label}</span>
          <span className="heavy" style={{ color: c, fontSize: 16 }}>{inbound ? '+' : ''}{qty(m.quantity)}</span>
        </div>
        <span className="small muted">{m.reference} · balance {qty(m.balance_after)}</span>
        {m.note && <span className="small muted">{m.note}</span>}
        <span className="tiny muted">{[m.user_name, dateTime(m.created_at)].filter(Boolean).join(' · ')}</span>
      </div>
    </div>
  );
}
