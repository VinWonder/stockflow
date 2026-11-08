import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronsUpDown, Package, Plus, ScanLine, Search, Store, Truck } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';

import { api } from '../lib/api';
import { qty, toD } from '../lib/format';
import { isGodown, kindLabel, type Location, type StockLevel, type Supplier, type Variant } from '../lib/models';
import { useSuppliers } from '../lib/queries';
import { colors, fromHex } from '../lib/theme';
import { Card, EmptyState, ErrorView, LoadingList, Progress, StoreAvatar } from './common';
import { Dialog, Sheet, useOverlay } from './overlay';
import { useScanner } from './Scanner';

export type Picked = { variant: Variant; available: number | null };

function VariantSheet({ locationId, inStockOnly, close }: { locationId?: number | null; inStockOnly: boolean; close: (v?: Picked) => void }) {
  const overlay = useOverlay();
  const scan = useScanner();
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
          : await api.list<StockLevel>('/stock/', { location: locationId, search, in_stock: inStockOnly ? 1 : undefined });
        let rows: Picked[];
        if (inStockOnly) {
          rows = stock.map((s) => ({ variant: s.variant, available: toD(s.quantity) }));
        } else {
          const byId = new Map(stock.map((s) => [s.variant.id, toD(s.quantity)]));
          const variants = await api.list<Variant>('/variants/', { search, is_active: true });
          rows = variants.map((v) => ({ variant: v, available: locationId == null ? null : (byId.get(v.id) ?? 0) }));
        }
        if (mine === seq.current) setResults(rows);
      } catch (e) {
        if (mine === seq.current) setError(e);
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [locationId, inStockOnly],
  );

  useEffect(() => {
    if (term.length >= 2 || term.length === 0) {
      const t = window.setTimeout(() => load(term.trim()), term ? 250 : 0);
      return () => window.clearTimeout(t);
    }
  }, [term, load]);

  const onScan = async () => {
    const code = await scan();
    if (!code) return;
    try {
      const v = await api.get<Variant>(`/variants/barcode/${encodeURIComponent(code)}/`);
      let available: number | null = null;
      if (locationId != null) {
        const s = await api.list<StockLevel>('/stock/', { location: locationId, variant: v.id });
        available = s.length ? toD(s[0].quantity) : 0;
      }
      close({ variant: v, available });
    } catch (e) {
      overlay.error(e);
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
            placeholder="Name, code, size, colour or SKU"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load(term.trim())}
          />
        </div>
        <button className="icon-btn tonal" onClick={onScan} aria-label="Scan barcode">
          <ScanLine size={20} />
        </button>
      </div>
      {loading ? <Progress /> : <div style={{ height: 2 }} />}
      <div className="sheet-body" style={{ flex: 1, paddingTop: 4 }}>
        {error ? (
          <ErrorView error={error} onRetry={() => load(term.trim())} />
        ) : results.length === 0 && !loading ? (
          <EmptyState icon={Package} title="No matching products" />
        ) : (
          <div className="list">
            {results.map((r) => {
              const empty = r.available != null && r.available <= 0;
              return (
                <Card key={r.variant.id} onClick={() => close(r)} style={{ padding: '12px 16px' }}>
                  <div className="row">
                    <div className="col grow">
                      <span className="bold">{r.variant.product_name}</span>
                      <span className="small muted">{[r.variant.options, r.variant.sku].filter(Boolean).join(' · ')}</span>
                    </div>
                    {r.available != null && (
                      <div className="col right">
                        <span className="heavy" style={{ color: empty ? colors.danger : undefined }}>{qty(r.available)}</span>
                        <span className="tiny muted">{r.variant.unit}</span>
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

/** Search products (and see stock at locationId); resolves with the chosen variant and what's available. */
export function usePickVariant() {
  const { open } = useOverlay();
  return (opts: { locationId?: number | null; inStockOnly?: boolean } = {}) =>
    open<Picked>((close) => <VariantSheet locationId={opts.locationId} inStockOnly={opts.inStockOnly ?? false} close={close} />);
}

export function usePickLocation() {
  const { open } = useOverlay();
  return (options: Location[], title = 'Choose a store') =>
    open<Location>((close) => (
      <Sheet onClose={() => close()} title={title}>
        <div className="sheet-body">
          {options.length === 0 && <EmptyState icon={Store} title="No stores to choose from" />}
          {options.map((l) => (
            <button key={l.id} className="tile" onClick={() => close(l)}>
              <StoreAvatar color={fromHex(l.color)} godown={isGodown(l)} size={40} />
              <div className="col grow">
                <span className="bold">{l.name}</span>
                <span className="small muted">{l.code} · {kindLabel(l)}</span>
              </div>
            </button>
          ))}
        </div>
      </Sheet>
    ));
}

/** A tappable field that shows the chosen store. */
export function LocationField({ label, value, onClick }: { label: string; value: Location | null; onClick: () => void }) {
  return (
    <Card onClick={onClick} style={{ padding: '12px 14px' }}>
      <div className="row">
        {value ? <StoreAvatar color={fromHex(value.color)} godown={isGodown(value)} size={40} /> : <span className="avatar"><Store size={20} /></span>}
        <div className="col grow">
          <span className="tiny muted">{label}</span>
          <span className="bold" style={{ fontSize: 15 }}>{value?.name ?? 'Tap to choose'}</span>
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
    <Sheet onClose={() => close()} tall>
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
                {s.phone && <span className="small muted">{s.phone}</span>}
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
