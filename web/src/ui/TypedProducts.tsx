import { PencilLine, X } from 'lucide-react';

import { money, numericInput, toD } from '../lib/format';
import { CATEGORY_PRESETS } from '../lib/presets';
import { Card, Field } from './common';

export interface TypedProduct {
  key: number;
  name: string;
  size: string;
  colour: string;
  unit: string;
  category: string;
  quantity: string;
  cost: string;
  price: string;
}

const UNITS: [string, string][] = [
  ['pcs', 'pieces'], ['bag', 'bags'], ['kg', 'kg'], ['m', 'metres'], ['ft', 'feet'], ['l', 'litres'], ['box', 'boxes'],
  ['roll', 'rolls'], ['sheet', 'sheets'], ['set', 'sets'], ['pair', 'pairs'], ['tin', 'tins'],
];

let nextKey = 1;
export const blankTyped = (): TypedProduct => ({ key: nextKey++, name: '', size: '', colour: '', unit: 'pcs', category: '', quantity: '1', cost: '', price: '' });

export const typedTotal = (rows: TypedProduct[]) => rows.reduce((s, r) => s + toD(r.quantity) * toD(r.cost), 0);

export function typedProblem(rows: TypedProduct[]): string | null {
  for (const r of rows) {
    if (!r.name.trim()) return 'Type the name of every new product.';
    if (toD(r.quantity) <= 0) return `Enter how many ${r.name} came.`;
    if (toD(r.cost) <= 0) return `Enter the buying price of ${r.name}.`;
  }
  return null;
}

export const typedPayload = (rows: TypedProduct[]) =>
  rows.map((r) => ({
    name: r.name.trim(), size: r.size.trim(), colour: r.colour.trim(), unit: r.unit, category: r.category.trim(),
    quantity: r.quantity, unit_cost: toD(r.cost).toFixed(2), selling_price: toD(r.price).toFixed(2),
  }));

/** Products typed in while receiving (not yet in the catalogue). They are saved for easy picking next time. */
export function TypedProducts({ rows, onChange }: { rows: TypedProduct[]; onChange: (rows: TypedProduct[]) => void }) {
  const set = (key: number, patch: Partial<TypedProduct>) => onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  return (
    <>
      {rows.map((r) => (
        <Card key={r.key} style={{ marginBottom: 10, padding: 12, borderStyle: 'dashed' }}>
          <div className="row" style={{ gap: 8 }}>
            <PencilLine size={18} color="var(--primary)" />
            <span className="tiny bold muted grow">NEW PRODUCT · saved to your list</span>
            <button className="icon-btn" aria-label="Remove" onClick={() => onChange(rows.filter((x) => x.key !== r.key))}>
              <X size={20} />
            </button>
          </div>
          <input className="input" style={{ marginTop: 6 }} autoFocus autoCapitalize="words" placeholder="Product name, e.g. Gate valve" value={r.name} onChange={(e) => set(r.key, { name: e.target.value })} />
          <div className="grid-2" style={{ marginTop: 8 }}>
            <input className="input" list="preset-sizes" placeholder='Size, e.g. 1/2"' value={r.size} onChange={(e) => set(r.key, { size: e.target.value })} />
            <input className="input" list="preset-colours" autoCapitalize="words" placeholder="Colour (optional)" value={r.colour} onChange={(e) => set(r.key, { colour: e.target.value })} />
          </div>
          <div className="grid-2" style={{ marginTop: 8 }}>
            <input className="input" list="typed-categories" autoCapitalize="words" placeholder="Category, e.g. Taps" value={r.category} onChange={(e) => set(r.key, { category: e.target.value })} />
            <select className="input" value={r.unit} onChange={(e) => set(r.key, { unit: e.target.value })} aria-label="Counted in">
              {UNITS.map(([v, l]) => <option key={v} value={v}>Counted in {l}</option>)}
            </select>
          </div>
          <div className="row" style={{ marginTop: 8, gap: 8 }}>
            <Field label="Quantity" style={{ flex: 1 }}>
              <input className="input" inputMode="decimal" value={r.quantity} onFocus={(e) => e.target.select()} onChange={(e) => set(r.key, { quantity: numericInput(e.target.value) })} />
            </Field>
            <Field label="Buying price" style={{ flex: 1 }}>
              <input className="input" inputMode="decimal" placeholder="0" value={r.cost} onChange={(e) => set(r.key, { cost: numericInput(e.target.value) })} />
            </Field>
            <Field label="Selling price" style={{ flex: 1 }}>
              <input className="input" inputMode="decimal" placeholder="0" value={r.price} onChange={(e) => set(r.key, { price: numericInput(e.target.value) })} />
            </Field>
          </div>
          <div className="tiny muted" style={{ marginTop: 6 }}>Line total: {money(toD(r.quantity) * toD(r.cost))}</div>
        </Card>
      ))}
      <datalist id="typed-categories">{CATEGORY_PRESETS.map((c) => <option key={c} value={c} />)}</datalist>
    </>
  );
}
