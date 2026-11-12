import { useEffect, useState } from 'react';
import { Minus, Plus, X } from 'lucide-react';

import { money, numericInput, qty, qtyOut } from '../lib/format';
import type { LineDraft } from '../lib/models';
import { alpha, colors } from '../lib/theme';
import { Card } from './common';

export type PriceMode = 'none' | 'cost' | 'sell';

/** Editable list of products with quantity steppers and optional price, used by every form. */
export function LinesEditor({ lines, onChange, onAdd, priceMode = 'none', checkAvailable = false, showCost = false, addLabel = 'Add product' }: {
  lines: LineDraft[];
  onChange: (lines: LineDraft[]) => void;
  onAdd: () => void;
  priceMode?: PriceMode;
  checkAvailable?: boolean;
  showCost?: boolean;
  addLabel?: string;
}) {
  const update = (i: number, patch: Partial<LineDraft>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <div>
      {lines.map((line, i) => (
        <LineTile
          key={line.variant.id}
          line={line}
          priceMode={priceMode}
          checkAvailable={checkAvailable}
          showCost={showCost}
          onChange={(patch) => update(i, patch)}
          onRemove={() => onChange(lines.filter((_, j) => j !== i))}
        />
      ))}
      <button className="btn outline block" style={{ marginTop: 6 }} onClick={onAdd}>
        <Plus size={20} /> {addLabel}
      </button>
    </div>
  );
}

function LineTile({ line, priceMode, checkAvailable, showCost, onChange, onRemove }: {
  line: LineDraft;
  priceMode: PriceMode;
  checkAvailable: boolean;
  showCost: boolean;
  onChange: (patch: Partial<LineDraft>) => void;
  onRemove: () => void;
}) {
  const v = line.variant;
  const [qtyText, setQtyText] = useState(qtyOut(line.quantity));
  const [priceText, setPriceText] = useState(qtyOut(line.price));
  const [costText, setCostText] = useState(qtyOut(line.cost));

  // Keep the box in sync when the quantity changes from outside (e.g. the same product added again).
  useEffect(() => {
    if (parseFloat(qtyText) !== line.quantity && !(qtyText === '' && line.quantity === 0)) setQtyText(qtyOut(line.quantity));
  }, [line.quantity]);

  const step = (delta: number) => {
    const next = Math.max(0, v.allow_fractions ? line.quantity + delta : Math.round(line.quantity + delta));
    setQtyText(qtyOut(next));
    onChange({ quantity: next });
  };

  const over = checkAvailable && line.available != null && line.quantity > line.available;

  return (
    <Card style={{ marginBottom: 10, padding: '10px 6px 12px 14px', background: over ? alpha(colors.danger, 0.06) : undefined }}>
      <div className="row">
        <div className="col grow">
          <span className="heavy">{v.product_name}</span>
          <span className="tiny muted">{[v.options, v.sku].filter(Boolean).join(' · ')}</span>
        </div>
        <button className="icon-btn" onClick={onRemove} aria-label="Remove line" title="Remove line">
          <X size={20} />
        </button>
      </div>
      <div className="row" style={{ marginTop: 8, gap: 6, flexWrap: 'wrap' }}>
        <button className="icon-btn tonal" onClick={() => step(-1)} aria-label="Less">
          <Minus size={20} />
        </button>
        <input
          className="input qty-input"
          inputMode={v.allow_fractions ? 'decimal' : 'numeric'}
          value={qtyText}
          aria-label="Quantity"
          onFocus={(e) => e.target.select()}
          onChange={(e) => {
            const t = numericInput(e.target.value, v.allow_fractions);
            setQtyText(t);
            onChange({ quantity: parseFloat(t) || 0 });
          }}
        />
        <button className="icon-btn tonal" onClick={() => step(1)} aria-label="More">
          <Plus size={20} />
        </button>
        <span className="muted">{v.unit}</span>
        <span className="grow" />
        {priceMode !== 'none' && (
          <label className="field" style={{ width: 120, marginRight: 8 }}>
            <span style={{ margin: '0 0 2px 4px' }}>{priceMode === 'cost' ? 'Cost each' : 'Price each'}</span>
            <input
              className="input"
              style={{ minHeight: 40, padding: '8px 10px' }}
              inputMode="decimal"
              value={priceText}
              onFocus={(e) => e.target.select()}
              onChange={(e) => {
                const t = numericInput(e.target.value);
                setPriceText(t);
                onChange({ price: parseFloat(t) || 0 });
              }}
            />
          </label>
        )}
      </div>
      {line.available != null && (
        <div className="tiny" style={{ marginTop: 6, color: over ? colors.danger : 'var(--muted)', fontWeight: over ? 700 : undefined }}>
          {over ? `Only ${qty(line.available)} available` : `${qty(line.available)} ${v.unit} in this store`}
        </div>
      )}
      {showCost && (
        <label className="field" style={{ maxWidth: 180, marginTop: 8 }}>
          <span style={{ margin: '0 0 2px 4px' }}>Buying cost each (optional)</span>
          <input
            className="input"
            style={{ minHeight: 40, padding: '8px 10px' }}
            inputMode="decimal"
            value={costText}
            onFocus={(e) => e.target.select()}
            onChange={(e) => {
              const t = numericInput(e.target.value);
              setCostText(t);
              onChange({ cost: parseFloat(t) || 0 });
            }}
          />
        </label>
      )}
      {priceMode !== 'none' && <div className="tiny muted" style={{ marginTop: 4 }}>Line total: {money(line.quantity * line.price)}</div>}
      {showCost && <div className="tiny muted" style={{ marginTop: 4 }}>Defaults to the current buying cost. An adjustment affects this sale only.</div>}
    </Card>
  );
}

/** Lines in the format the API expects. */
export const linesPayload = (lines: LineDraft[], priceField?: 'unit_cost' | 'unit_price', includeSaleCost = false) =>
  lines
    .filter((l) => l.quantity > 0)
    .map((l) => ({
      variant: l.variant.id,
      quantity: qtyOut(l.quantity),
      ...(priceField ? { [priceField]: l.price.toFixed(2) } : {}),
      ...(includeSaleCost ? { unit_cost: l.cost.toFixed(2) } : {}),
    }));
