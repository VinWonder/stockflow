import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';

import { api } from '../lib/api';
import { money, numericInput, qtyOut, toD } from '../lib/format';
import type { Product, Supplier, Variant } from '../lib/models';
import { CATEGORY_PRESETS } from '../lib/presets';
import { useCategories, useSuppliers } from '../lib/queries';
import { Field, Spinner, Switch } from './common';
import { Sheet, useOverlay } from './overlay';

const UNITS: [string, string][] = [
  ['pcs', 'Pieces'], ['bag', 'Bags'], ['kg', 'Kilograms'], ['m', 'Metres'], ['ft', 'Feet'], ['l', 'Litres'], ['box', 'Boxes'],
  ['roll', 'Rolls'], ['sheet', 'Sheets'], ['set', 'Sets'], ['pair', 'Pairs'], ['tin', 'Tins'],
];

interface Row {
  id?: number;
  size: string;
  colour: string;
  price: string;
  cost: string;
}

const blankRow = (): Row => ({ size: '', colour: '', price: '', cost: '' });

/**
 * Create or edit a product with its sizes / colours and prices.
 * Hardware items are found by name, size and colour (no barcodes), so those fields matter.
 */
export function ProductSheet({ product, supplier, close }: { product?: Product; supplier?: Supplier | null; close: (p?: Product) => void }) {
  const overlay = useOverlay();
  const qc = useQueryClient();
  const categories = useCategories().data ?? [];
  const suppliers = useSuppliers().data ?? [];
  const [name, setName] = useState(product?.name ?? '');
  const [code, setCode] = useState(product?.code ?? '');
  const [brand, setBrand] = useState(product?.brand ?? '');
  const [category, setCategory] = useState(product?.category_name ?? '');
  const [unit, setUnit] = useState(product?.unit ?? 'pcs');
  const [fractions, setFractions] = useState(product?.allow_fractions ?? false);
  const [reorder, setReorder] = useState(product ? qtyOut(toD(product.reorder_level)) : '5');
  const [linked, setLinked] = useState<number[]>(product?.suppliers ?? (supplier ? [supplier.id] : []));
  const [rows, setRows] = useState<Row[]>(
    product?.variants.length
      ? product.variants.map((v) => ({ id: v.id, size: v.size, colour: v.colour, price: qtyOut(toD(v.selling_price)), cost: qtyOut(toD(v.cost_price)) }))
      : [blankRow()],
  );
  const [busy, setBusy] = useState(false);

  const setRow = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const save = async () => {
    if (!name.trim()) {
      overlay.error('Enter the product name.');
      return;
    }
    const keys = rows.map((r) => `${r.size.trim().toLowerCase()}|${r.colour.trim().toLowerCase()}`);
    if (new Set(keys).size !== keys.length) {
      overlay.error('Two rows have the same size and colour.');
      return;
    }
    setBusy(true);
    try {
      const body = {
        name: name.trim(),
        code: code.trim().toUpperCase(),
        brand: brand.trim(),
        ...(category.trim() ? { new_category: category.trim() } : { category: null }),
        unit,
        allow_fractions: fractions,
        reorder_level: reorder || '0',
        suppliers: linked,
        new_variants: rows
          .filter((r) => !r.id)
          .map((r) => ({ size: r.size.trim(), colour: r.colour.trim(), selling_price: toD(r.price).toFixed(2), cost_price: toD(r.cost).toFixed(2) })),
      };
      let saved = product ? await api.patch<Product>(`/products/${product.id}/`, body) : await api.post<Product>('/products/', body);
      // Existing sizes: update prices that changed.
      for (const r of rows.filter((x) => x.id)) {
        const old = product!.variants.find((v) => v.id === r.id)!;
        if (toD(old.selling_price) !== toD(r.price) || old.size !== r.size.trim() || old.colour !== r.colour.trim()) {
          await api.patch<Variant>(`/variants/${r.id}/`, { selling_price: toD(r.price).toFixed(2), size: r.size.trim(), colour: r.colour.trim() });
        }
      }
      if (product) saved = await api.get<Product>(`/products/${product.id}/`);
      qc.invalidateQueries({ queryKey: ['products'] });
      qc.invalidateQueries({ queryKey: ['categories'] });
      overlay.success(product ? `${saved.name} saved` : `${saved.name} added to your catalogue`);
      close(saved);
    } catch (e) {
      overlay.error(e);
    } finally {
      setBusy(false);
    }
  };

  const removeRow = async (i: number) => {
    const r = rows[i];
    if (r.id) {
      try {
        await api.del(`/variants/${r.id}/`);
      } catch (e) {
        overlay.error(e);
        return;
      }
    }
    setRows(rows.filter((_, j) => j !== i));
  };

  return (
    <Sheet onClose={() => close()} title={product ? `Edit ${product.name}` : 'New product'} tall>
      <div className="sheet-body stack" style={{ flex: 1 }}>
        <Field label="Product name">
          <input className="input" autoFocus={!product} autoCapitalize="words" placeholder="e.g. Iron sheet, Gate valve, Cement" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="grid-2">
          <Field label="Short code (for SMS)">
            <input className="input" placeholder="Auto" autoCapitalize="characters" maxLength={20} value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/\s/g, ''))} />
          </Field>
          <Field label="Brand (optional)">
            <input className="input" value={brand} onChange={(e) => setBrand(e.target.value)} />
          </Field>
        </div>
        <div className="grid-2">
          <Field label="Category (pick or type)">
            <input className="input" list="product-categories" autoCapitalize="words" placeholder="e.g. Taps, Tanks" value={category} onChange={(e) => setCategory(e.target.value)} />
            <datalist id="product-categories">
              {[...new Set([...categories.map((c) => c.name), ...CATEGORY_PRESETS])].map((c) => <option key={c} value={c} />)}
            </datalist>
          </Field>
          <Field label="Sold in">
            <select className="input" value={unit} onChange={(e) => {
              setUnit(e.target.value);
              setFractions(['kg', 'm', 'ft', 'l'].includes(e.target.value));
            }}>
              {UNITS.map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </Field>
        </div>
        <div className="grid-2">
          <Field label="Warn me when stock falls to">
            <input className="input" inputMode="decimal" value={reorder} onChange={(e) => setReorder(numericInput(e.target.value))} />
          </Field>
          <Switch checked={fractions} onChange={setFractions} title="Part quantities" subtitle="e.g. 2.5 kg, 3.5 m" />
        </div>

        <div className="section-title" style={{ padding: '8px 4px 0' }}>
          <h2>Sizes, colours and prices</h2>
        </div>
        <p className="small muted" style={{ margin: '0 4px' }}>One row per size/colour you stock. Leave size and colour empty if there's only one kind.</p>
        {rows.map((r, i) => (
          <div key={r.id ?? `n${i}`} className="card" style={{ padding: 12 }}>
            <div className="grid-2">
              <input className="input" list="preset-sizes" placeholder='Size: pick or type, e.g. 1/2"' value={r.size} onChange={(e) => setRow(i, { size: e.target.value })} />
              <input className="input" list="preset-colours" placeholder="Colour (optional)" autoCapitalize="words" value={r.colour} onChange={(e) => setRow(i, { colour: e.target.value })} />
            </div>
            <div className="row" style={{ marginTop: 8, gap: 8 }}>
              <Field label="Selling price" style={{ flex: 1 }}>
                <input className="input" inputMode="decimal" placeholder="0" value={r.price} onChange={(e) => setRow(i, { price: numericInput(e.target.value) })} />
              </Field>
              {!r.id && (
                <Field label="Buying price" style={{ flex: 1 }}>
                  <input className="input" inputMode="decimal" placeholder="0" value={r.cost} onChange={(e) => setRow(i, { cost: numericInput(e.target.value) })} />
                </Field>
              )}
              {r.id && <span className="small muted" style={{ flex: 1, alignSelf: 'end', paddingBottom: 14 }}>Avg cost {money(r.cost)}</span>}
              <button className="icon-btn" style={{ alignSelf: 'end', marginBottom: 4 }} aria-label="Remove size" disabled={rows.length === 1} onClick={() => removeRow(i)}>
                <Trash2 size={20} />
              </button>
            </div>
          </div>
        ))}
        <button className="btn outline block" onClick={() => setRows([...rows, blankRow()])}>
          <Plus size={20} /> Another size / colour
        </button>

        {suppliers.length > 0 && (
          <>
            <div className="section-title" style={{ padding: '8px 4px 0' }}>
              <h2>Who supplies it</h2>
            </div>
            <div className="wrap">
              {suppliers.map((s) => {
                const on = linked.includes(s.id);
                return (
                  <button key={s.id} className={`choice${on ? ' on' : ''}`} onClick={() => setLinked(on ? linked.filter((x) => x !== s.id) : [...linked, s.id])}>
                    {s.name}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
      <div style={{ padding: '8px 12px 12px' }}>
        <button className="btn block" disabled={busy} onClick={save}>
          {busy ? <Spinner /> : product ? 'Save product' : 'Add product'}
        </button>
      </div>
    </Sheet>
  );
}

export function useProductForm() {
  const { open } = useOverlay();
  return (opts: { product?: Product; supplier?: Supplier | null } = {}) =>
    open<Product>((close) => <ProductSheet product={opts.product} supplier={opts.supplier} close={close} />);
}
