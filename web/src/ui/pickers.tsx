import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronsUpDown, Package, PackagePlus, Plus, Search, Store, Truck } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';

import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { money, qty, toD } from '../lib/format';
import { isGodown, kindLabel, type Location, type StockLevel, type Supplier, type Variant } from '../lib/models';
import { useSuppliers } from '../lib/queries';
import { colors, fromHex } from '../lib/theme';
import { Card, EmptyState, ErrorView, LoadingList, Pill, Progress, StoreAvatar } from './common';
import { Dialog, Sheet, useOverlay } from './overlay';
import { useProductForm } from './ProductForm';

export type Picked = { variant: Variant; available: number | null };

interface PickOptions {
  locationId?: number | null;
  inStockOnly?: boolean;
  /** Receiving from a supplier: list their products first. */
  supplier?: Supplier | null;
  /** Show "New product" (admins only). */
  allowCreate?: boolean;
  /** Show cost instead of selling price. */
  showCost?: boolean;
}

function VariantSheet({ opts, close }: { opts: PickOptions; close: (v?: Picked) => void }) {
  const { locationId, inStockOnly = false, supplier, allowCreate = false, showCost = false } = opts;
  const productForm = useProductForm();
  const [tab, setTab] = useState<'supplier' | 'all'>(supplier ? 'supplier' : 'all');
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<Picked[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const seq = useRef(0);

  const load = useCallback(
    async (search: string) => {
      const mine = ++seq.current;
      setLoading(true);
      setError(null);
      try {
        const stock = locationId == null
          ? []
          : await api.list<StockLevel>('/stock/', { location: locationId, search, in_stock: inStockOnly ? 1 : undefined, page_size: 300 });
        let rows: Picked[];
        if (inStockOnly) {
          rows = stock.map((s) => ({ variant: s.variant, available: toD(s.quantity) }));
        } else {
          const byId = new Map(stock.map((s) => [s.variant.id, toD(s.quantity)]));
          const variants = await api.list<Variant>('/variants/', {
            search,
            is_active: true,
            supplier: tab === 'supplier' && supplier ? supplier.id : undefined,
          });
          rows = variants.map((v) => ({ variant: v, available: locationId == null ? null : (byId.get(v.id) ?? 0) }));
        }
        if (mine === seq.current) setResults(rows);
      } catch (e) {
        if (mine === seq.current) setError(e);
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [locationId, inStockOnly, tab, supplier],
  );

  useEffect(() => {
    const t = window.setTimeout(() => load(term.trim()), term ? 250 : 0);
    return () => window.clearTimeout(t);
  }, [term, load]);

  const create = async () => {
    const p = await productForm({ supplier });
    if (!p) return;
    const active = p.variants.filter((v) => v.is_active !== false);
    if (active.length === 1) {
      close({ variant: active[0], available: locationId == null ? null : 0 });
    } else {
      setTab('all');
      setTerm(p.name);
    }
  };

  return (
    <Sheet onClose={() => close()} tall>
      <div className="row" style={{ padding: '0 16px 8px', gap: 8 }}>
        <div className="input-wrap grow">
          <Search size={20} />
          <input
            className="input"
            autoFocus
            type="search"
            enterKeyHint="search"
            placeholder="Name, size, colour or code"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load(term.trim())}
          />
        </div>
      </div>
      {supplier && !inStockOnly && (
        <div className="tabs" style={{ position: 'static', margin: '0 16px' }} role="tablist">
          <button role="tab" aria-selected={tab === 'supplier'} className={tab === 'supplier' ? 'on' : ''} onClick={() => setTab('supplier')}>
            From {supplier.name.split(' ')[0]}
          </button>
          <button role="tab" aria-selected={tab === 'all'} className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>
            All products
          </button>
        </div>
      )}
      {loading ? <Progress /> : <div style={{ height: 2 }} />}
      <div className="sheet-body" style={{ flex: 1, paddingTop: 8 }}>
        {allowCreate && (
          <button className="tile" onClick={create} style={{ marginBottom: 6 }}>
            <span className="avatar"><PackagePlus size={20} /></span>
            <div className="col grow">
              <span className="bold">New product</span>
              <span className="small muted">Not in the list? Add it with its sizes, colours and prices</span>
            </div>
          </button>
        )}
        {error ? (
          <ErrorView error={error} onRetry={() => load(term.trim())} />
        ) : results.length === 0 && !loading ? (
          <EmptyState
            icon={Package}
            title={tab === 'supplier' ? `Nothing from ${supplier?.name} yet` : inStockOnly ? 'Nothing in stock matches' : 'No matching products'}
            message={tab === 'supplier' ? 'Products appear here after their first delivery. Look in "All products".' : undefined}
            action={tab === 'supplier' ? 'All products' : undefined}
            onAction={() => setTab('all')}
          />
        ) : (
          <div className="list">
            {results.map((r) => {
              const empty = r.available != null && r.available <= 0;
              const v = r.variant;
              return (
                <Card key={v.id} onClick={() => close(r)} style={{ padding: '12px 16px' }}>
                  <div className="row">
                    <div className="col grow">
                      <span className="bold">{v.product_name}</span>
                      <div className="wrap" style={{ gap: 6, marginTop: 3 }}>
                        {v.size && <Pill text={v.size} color={colors.steel} />}
                        {v.colour && <Pill text={v.colour} color={colors.violet} />}
                        <span className="tiny muted">{showCost ? `cost ${money(v.cost_price)}` : money(v.selling_price)}</span>
                      </div>
                    </div>
                    {r.available != null && (
                      <div className="col right">
                        <span className="heavy" style={{ color: empty ? colors.danger : undefined }}>{empty ? 'None' : qty(r.available)}</span>
                        <span className="tiny muted">{v.unit} here</span>
                      </div>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </Sheet>
  );
}

/** Search products by name / size / colour (and see stock at locationId); resolves with the chosen item. */
export function usePickVariant() {
  const { open } = useOverlay();
  const { me } = useAuth();
  return (opts: PickOptions = {}) =>
    open<Picked>((close) => <VariantSheet opts={{ ...opts, allowCreate: (opts.allowCreate ?? false) && !!me?.is_admin }} close={close} />);
}

export interface PickLocationOptions {
  title?: string;
  /** Short note under a store's name, e.g. "Selling switched off". */
  note?: (l: Location) => string | null;
  disabled?: (l: Location) => boolean;
}

export function usePickLocation() {
  const { open } = useOverlay();
  return (options: Location[], titleOrOpts: string | PickLocationOptions = 'Choose a store') => {
    const o: PickLocationOptions = typeof titleOrOpts === 'string' ? { title: titleOrOpts } : titleOrOpts;
    const shops = options.filter((l) => !isGodown(l));
    const godowns = options.filter(isGodown);
    const row = (l: Location, close: (l?: Location) => void) => {
      const off = o.disabled?.(l) ?? false;
      const note = o.note?.(l);
      return (
        <button key={l.id} className="tile" disabled={off} style={off ? { opacity: 0.5, cursor: 'default' } : undefined} onClick={() => !off && close(l)}>
          <StoreAvatar color={fromHex(l.color)} godown={isGodown(l)} size={40} />
          <div className="col grow">
            <span className="bold">{l.name}</span>
            <span className="small muted">{[l.code, kindLabel(l), note].filter(Boolean).join(' · ')}</span>
          </div>
        </button>
      );
    };
    return open<Location>((close) => (
      <Sheet onClose={() => close()} title={o.title ?? 'Choose a store'}>
        <div className="sheet-body">
          {options.length === 0 && <EmptyState icon={Store} title="No stores to choose from" />}
          {shops.length > 0 && godowns.length > 0 && <div className="tiny muted bold" style={{ padding: '4px 16px' }}>SHOPS</div>}
          {shops.map((l) => row(l, close))}
          {shops.length > 0 && godowns.length > 0 && <div className="tiny muted bold" style={{ padding: '12px 16px 4px' }}>GODOWNS / STORES</div>}
          {godowns.map((l) => row(l, close))}
        </div>
      </Sheet>
    ));
  };
}

/** A tappable field that shows the chosen store. */
export function LocationField({ label, value, onClick, hint }: { label: string; value: Location | null; onClick: () => void; hint?: string }) {
  return (
    <Card onClick={onClick} style={{ padding: '12px 14px' }}>
      <div className="row">
        {value ? <StoreAvatar color={fromHex(value.color)} godown={isGodown(value)} size={40} /> : <span className="avatar"><Store size={20} /></span>}
        <div className="col grow">
          <span className="tiny muted">{label}</span>
          <span className="bold" style={{ fontSize: 15 }}>{value?.name ?? 'Tap to choose'}</span>
          {(hint || value) && <span className="tiny muted">{hint ?? kindLabel(value!)}</span>}
        </div>
        <ChevronsUpDown size={20} />
      </div>
    </Card>
  );
}

function SupplierDialog({ close }: { close: (v?: { name: string; contact: string; phone: string }) => void }) {
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [phone, setPhone] = useState('');
  return (
    <Dialog
      onClose={() => close()}
      title="New supplier"
      actions={
        <>
          <button className="btn text" onClick={() => close()}>Cancel</button>
          <button className="btn small" onClick={() => close({ name, contact, phone })}>Save</button>
        </>
      }
    >
      <div className="stack">
        <input className="input" autoFocus placeholder="Business name" autoCapitalize="words" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="input" placeholder="Contact person" autoCapitalize="words" value={contact} onChange={(e) => setContact(e.target.value)} />
        <input className="input" placeholder="Phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </div>
    </Dialog>
  );
}

export function useAddSupplier() {
  const overlay = useOverlay();
  const qc = useQueryClient();
  return async (): Promise<Supplier | undefined> => {
    const v = await overlay.open<{ name: string; contact: string; phone: string }>((close) => <SupplierDialog close={close} />);
    if (!v || !v.name.trim()) return undefined;
    try {
      const s = await api.post<Supplier>('/suppliers/', { name: v.name.trim(), contact_person: v.contact.trim(), phone: v.phone.trim() });
      qc.invalidateQueries({ queryKey: ['suppliers'] });
      return s;
    } catch (e) {
      overlay.error(e);
      return undefined;
    }
  };
}

function SupplierSheet({ close }: { close: (s?: Supplier) => void }) {
  const list = useSuppliers();
  const addSupplier = useAddSupplier();
  return (
    <Sheet onClose={() => close()} tall title="Supplier">
      <div className="sheet-body">
        <button
          className="tile"
          onClick={async () => {
            const s = await addSupplier();
            if (s) close(s);
          }}
        >
          <span className="avatar"><Plus size={20} /></span>
          <span className="bold">Add a new supplier</span>
        </button>
        {list.isPending ? (
          <LoadingList count={4} />
        ) : list.isError ? (
          <ErrorView error={list.error} onRetry={() => list.refetch()} />
        ) : (
          list.data.map((s) => (
            <button key={s.id} className="tile" onClick={() => close(s)}>
              <span className="avatar">{s.name[0]?.toUpperCase() ?? <Truck size={20} />}</span>
              <div className="col grow">
                <span className="bold">{s.name}</span>
                <span className="small muted">
                  {[s.phone, s.product_count ? `${s.product_count} products` : null].filter(Boolean).join(' · ') || 'No products linked yet'}
                </span>
              </div>
            </button>
          ))
        )}
      </div>
    </Sheet>
  );
}

/** Bottom sheet to pick a supplier, with "add new" at the top. */
export function usePickSupplier() {
  const { open } = useOverlay();
  return () => open<Supplier>((close) => <SupplierSheet close={close} />);
}
