import { useEffect, useState } from 'react';
import { Boxes, Plus, Search } from 'lucide-react';

import { useMe } from '../lib/auth';
import { money, qty, toD } from '../lib/format';
import { useProducts } from '../lib/queries';
import { colors } from '../lib/theme';
import { BottomActions, Card, EmptyState, ErrorView, LoadingList, Pill, Progress, TopBar } from '../ui/common';
import { useProductForm } from '../ui/ProductForm';

/** The catalogue: every product with its sizes / colours, prices and total stock. */
export function ProductsScreen() {
  const me = useMe();
  const productForm = useProductForm();
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const list = useProducts(term);

  useEffect(() => {
    const t = window.setTimeout(() => setTerm(search.trim()), 300);
    return () => window.clearTimeout(t);
  }, [search]);

  return (
    <main className={`page${me.is_admin ? ' with-actions' : ''}`}>
      <TopBar title="Products & prices" back />
      <div className="input-wrap">
        <Search size={20} />
        <input className="input" type="search" placeholder="Name, size, colour or code" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {list.isFetching && <Progress />}
      {list.isPending ? (
        <LoadingList />
      ) : list.isError ? (
        <ErrorView error={list.error} onRetry={() => list.refetch()} />
      ) : list.data.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title={term ? 'Nothing matches' : 'No products yet'}
          message={term ? undefined : 'Add the products you sell with their sizes, colours and prices, or add them while receiving a delivery.'}
          action={me.is_admin && !term ? 'Add a product' : undefined}
          onAction={() => productForm()}
        />
      ) : (
        <div className="list" style={{ marginTop: 12 }}>
          {list.data.map((p) => (
            <Card key={p.id} onClick={me.is_admin ? () => productForm({ product: p }) : undefined}>
              <div className="row">
                <div className="col grow">
                  <span className="heavy">{p.name}</span>
                  <span className="small muted">{[p.code, p.category_name, p.brand, p.unit].filter(Boolean).join(' · ')}</span>
                </div>
                <div className="col right">
                  <span className="heavy">{qty(p.total_stock ?? 0)}</span>
                  <span className="tiny muted">{p.unit} in stock</span>
                </div>
              </div>
              <div style={{ marginTop: 8 }}>
                {p.variants.filter((v) => v.is_active !== false).map((v) => {
                  const margin = toD(v.selling_price) - toD(v.cost_price);
                  return (
                    <div key={v.id} className="row small" style={{ padding: '3px 0' }}>
                      <span className="grow">{v.options || 'Standard'}</span>
                      {me.is_admin && <span className="muted">cost {money(v.cost_price)}</span>}
                      <span className="bold" style={{ minWidth: 90, textAlign: 'right' }}>{money(v.selling_price)}</span>
                      {me.is_admin && toD(v.cost_price) > 0 && margin <= 0 && <Pill text="No profit" color={colors.danger} />}
                    </div>
                  );
                })}
              </div>
              {p.supplier_names.length > 0 && <div className="tiny muted" style={{ marginTop: 6 }}>Supplied by {p.supplier_names.join(', ')}</div>}
            </Card>
          ))}
        </div>
      )}
      {me.is_admin && (
        <BottomActions>
          <button className="btn" onClick={() => productForm()}>
            <Plus size={20} /> Add product
          </button>
        </BottomActions>
      )}
    </main>
  );
}
