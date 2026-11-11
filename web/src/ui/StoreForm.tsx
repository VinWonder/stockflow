import { useState } from 'react';
import { Store, Warehouse } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';

import { api } from '../lib/api';
import { toD } from '../lib/format';
import { hasPoint, type Location } from '../lib/models';
import { Field, Segmented, Spinner, Switch } from './common';
import { Sheet, useConfirm, useOverlay } from './overlay';
import { PositionField, type Position } from './PositionField';

const PALETTE = ['#2563EB', '#7C3AED', '#059669', '#D97706', '#DC2626', '#0891B2', '#DB2777', '#4F46E5', '#334155'];

/** Add or edit a shop / godown: name, type, whether it sells, address and map position (for live tracking). */
function StoreSheet({ store, close }: { store?: Location; close: (l?: Location) => void }) {
  const overlay = useOverlay();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [name, setName] = useState(store?.name ?? '');
  const [kind, setKind] = useState<'shop' | 'godown'>((store?.kind as 'shop' | 'godown') ?? 'shop');
  const [code, setCode] = useState(store?.code ?? '');
  const [address, setAddress] = useState(store?.address ?? '');
  const [phone, setPhone] = useState(store?.phone ?? '');
  const [canSell, setCanSell] = useState(store?.can_sell ?? true);
  const [isMain, setIsMain] = useState(store?.is_main ?? false);
  const [color, setColor] = useState(store?.color ?? PALETTE[0]);
  const [pos, setPos] = useState<Position | null>(hasPoint(store) ? { lat: toD(store!.latitude), lng: toD(store!.longitude) } : null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!name.trim()) {
      overlay.error('Give the store a name.');
      return;
    }
    setBusy(true);
    try {
      const body = {
        name: name.trim(), kind, code: code.trim().toUpperCase(), address: address.trim(), phone: phone.trim(),
        can_sell: canSell, is_main: kind === 'shop' && isMain, color,
        latitude: pos ? pos.lat.toFixed(6) : null, longitude: pos ? pos.lng.toFixed(6) : null,
      };
      const saved = store ? await api.patch<Location>(`/locations/${store.id}/`, body) : await api.post<Location>('/locations/', body);
      qc.invalidateQueries({ queryKey: ['locations'] });
      qc.invalidateQueries({ queryKey: ['directory'] });
      overlay.success(store ? `${saved.name} saved` : `${saved.name} added`);
      close(saved);
    } catch (e) {
      overlay.error(e);
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    if (!store) return;
    const ok = await confirm({
      title: `Close ${store.name}?`,
      message: 'It disappears from lists. Its history is kept. Move or sell its stock first.',
      confirm: 'Close store',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/locations/${store.id}/`);
      qc.invalidateQueries();
      close();
    } catch (e) {
      overlay.error(e);
    }
  };

  return (
    <Sheet onClose={() => close()} title={store ? `Edit ${store.name}` : 'New shop or godown'} tall>
      <div className="sheet-body stack" style={{ flex: 1 }}>
        <Segmented<'shop' | 'godown'>
          value={kind}
          onChange={(k) => {
            setKind(k);
            if (!store) setCanSell(k === 'shop');
          }}
          options={[
            { value: 'shop', label: 'Shop', icon: Store },
            { value: 'godown', label: 'Godown / store', icon: Warehouse },
          ]}
        />
        <Field label="Name">
          <input className="input" autoFocus={!store} autoCapitalize="words" placeholder={kind === 'shop' ? 'e.g. Ruiru Shop' : 'e.g. Home Godown'} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="grid-2">
          <Field label="Short code (SMS)">
            <input className="input" placeholder="Auto" maxLength={10} autoCapitalize="characters" value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/\s/g, ''))} />
          </Field>
          <Field label="Store phone">
            <input className="input" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
        </div>
        <Field label="Address / landmark">
          <input className="input" value={address} onChange={(e) => setAddress(e.target.value)} />
        </Field>
        <PositionField value={pos} onChange={setPos} />
        <Switch checked={canSell} onChange={setCanSell} title="Sell from here" subtitle={kind === 'godown' ? 'Allow selling straight from this godown (e.g. bulk buyers).' : 'Record sales at this shop.'} />
        {kind === 'shop' && <Switch checked={isMain} onChange={setIsMain} title="Main shop" subtitle="The head office. Only one store can be the main shop." />}
        <Field label="Card colour">
          <div className="wrap">
            {PALETTE.map((c) => (
              <button key={c} type="button" aria-label={c} onClick={() => setColor(c)} className="swatch" style={{ background: c, outline: c === color ? '3px solid var(--text)' : 'none' }} />
            ))}
          </div>
        </Field>
        {store && (
          <button className="btn text" style={{ color: 'var(--danger)' }} onClick={archive}>Close this store</button>
        )}
      </div>
      <div style={{ padding: '8px 12px 12px' }}>
        <button className="btn block" disabled={busy} onClick={save}>{busy ? <Spinner /> : store ? 'Save' : 'Add store'}</button>
      </div>
    </Sheet>
  );
}

export function useStoreForm() {
  const { open } = useOverlay();
  return (store?: Location) => open<Location>((close) => <StoreSheet store={store} close={close} />);
}
