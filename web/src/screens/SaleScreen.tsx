import { useEffect, useState } from 'react';
import { Banknote, CircleCheck, Clock, Smartphone } from 'lucide-react';

import { api } from '../lib/api';
import { money, numericInput, qty, toD, uuid } from '../lib/format';
import { newLine, type Json, type LineDraft, type Location } from '../lib/models';
import { useLocations, useRefreshEverything } from '../lib/queries';
import { colors } from '../lib/theme';
import { BottomActions, Field, SectionTitle, Segmented, Spinner, TopBar } from '../ui/common';
import { LinesEditor, linesPayload } from '../ui/LinesEditor';
import { Dialog, useOverlay } from '../ui/overlay';
import { LocationField, usePickLocation, usePickVariant } from '../ui/pickers';

type Payment = 'cash' | 'mpesa' | 'credit';

/** Point of sale for the main shop (and any shop that can sell). */
export function SaleScreen({ locationId }: { locationId: number | null }) {
  const overlay = useOverlay();
  const refresh = useRefreshEverything();
  const pickVariant = usePickVariant();
  const pickLocation = usePickLocation();
  const shops = (useLocations().data ?? []).filter((l) => l.can_sell);
  const [clientUuid, setClientUuid] = useState(uuid);
  const [shop, setShop] = useState<Location | null>(null);
  const [cart, setCart] = useState<LineDraft[]>([]);
  const [payment, setPayment] = useState<Payment>('cash');
  const [mpesaCode, setMpesaCode] = useState('');
  const [customer, setCustomer] = useState('');
  const [phone, setPhone] = useState('');
  const [discount, setDiscount] = useState('0');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (shop || shops.length === 0) return;
    setShop(shops.find((l) => l.id === locationId) ?? shops.find((l) => l.is_main) ?? shops[0]);
  }, [shops, shop, locationId]);

  const subtotal = cart.reduce((s, l) => s + l.quantity * l.price, 0);
  const total = Math.max(0, subtotal - toD(discount));

  const add = async () => {
    if (!shop) return;
    const picked = await pickVariant({ locationId: shop.id, inStockOnly: true });
    if (!picked) return;
    const existing = cart.find((l) => l.variant.id === picked.variant.id);
    setCart(existing ? cart.map((l) => (l === existing ? { ...l, quantity: l.quantity + 1 } : l)) : [...cart, newLine(picked.variant, picked.available)]);
  };

  const checkout = async () => {
    const over = cart.find((l) => l.available != null && l.quantity > l.available);
    if (over) {
      overlay.error(`${over.variant.label}: only ${qty(over.available)} in stock.`);
      return;
    }
    setBusy(true);
    try {
      const r = await api.post<Json>('/sales/', {
        client_uuid: clientUuid,
        location: shop!.id,
        customer_name: customer.trim(),
        customer_phone: phone.trim(),
        payment_method: payment,
        payment_reference: mpesaCode.trim(),
        discount: toD(discount).toFixed(2),
        lines: linesPayload(cart, 'unit_price'),
      });
      refresh();
      await overlay.open((close) => (
        <Dialog onClose={() => close()} title={`Sale ${r.code} recorded`} actions={<button className="btn small" autoFocus onClick={() => close()}>New sale</button>}>
          <div style={{ textAlign: 'center' }}>
            <CircleCheck size={48} color={colors.success} />
            <p style={{ margin: '8px 0 0' }}>Total {money(r.total)} · {payment.toUpperCase()}</p>
          </div>
        </Dialog>
      ));
      setCart([]);
      setCustomer('');
      setPhone('');
      setMpesaCode('');
      setDiscount('0');
      setClientUuid(uuid());
    } catch (e) {
      overlay.error(e);
    } finally {
      setBusy(false);
    }
  };

  const blocked = busy || cart.length === 0 || !shop || (payment === 'credit' && !customer.trim());

  return (
    <main className="page with-actions">
      <TopBar title="Sell" back />
      <LocationField
        label="Selling from"
        value={shop}
        onClick={async () => {
          const l = await pickLocation(shops, 'Which shop?');
          if (l) {
            setShop(l);
            setCart([]);
          }
        }}
      />
      <SectionTitle>Cart</SectionTitle>
      <LinesEditor lines={cart} onChange={setCart} onAdd={add} priceMode="sell" checkAvailable addLabel="Add item" />
      <SectionTitle>Payment</SectionTitle>
      <div className="stack">
        <Segmented<Payment>
          value={payment}
          onChange={setPayment}
          options={[
            { value: 'cash', label: 'Cash', icon: Banknote },
            { value: 'mpesa', label: 'M-Pesa', icon: Smartphone },
            { value: 'credit', label: 'Credit', icon: Clock },
          ]}
        />
        {payment === 'mpesa' && (
          <Field label="M-Pesa code">
            <input className="input" autoCapitalize="characters" value={mpesaCode} onChange={(e) => setMpesaCode(e.target.value.toUpperCase())} />
          </Field>
        )}
        <div className="grid-2">
          <Field label={payment === 'credit' ? 'Customer name (required)' : 'Customer (optional)'}>
            <input className="input" value={customer} onChange={(e) => setCustomer(e.target.value)} />
          </Field>
          <Field label="Phone">
            <input className="input" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
        </div>
        <Field label="Discount (KES)">
          <input className="input" inputMode="decimal" value={discount} onFocus={(e) => e.target.select()} onChange={(e) => setDiscount(numericInput(e.target.value))} />
        </Field>
      </div>
      <BottomActions>
        <button className="btn success" style={{ minHeight: 56, fontSize: 17 }} disabled={blocked} onClick={checkout}>
          {busy ? <Spinner /> : `Charge ${money(total)}`}
        </button>
      </BottomActions>
    </main>
  );
}
