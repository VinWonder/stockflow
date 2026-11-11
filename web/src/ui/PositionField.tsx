import { useState } from 'react';
import { Crosshair, Link2, MapPin, X } from 'lucide-react';

import { colors } from '../lib/theme';
import { Spinner } from './common';
import { MapView, parsePosition } from './MapView';
import { useAskText, useOverlay } from './overlay';

export interface Position {
  lat: number;
  lng: number;
}

/** Ask the browser for the phone's GPS position. */
export function currentPosition(): Promise<Position> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('This device has no location service.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      (e) =>
        reject(new Error(e.code === 1
          ? 'Location permission was refused. Allow location for this site in the browser settings.'
          : "Couldn't get your location. Go outside or near a window and try again.")),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 10000 },
    );
  });
}

/**
 * Where a shop or godown is on the map, so transfers can be tracked to the door.
 * Stand at the store and tap "I'm at this store", paste a Google Maps link, or tap the map.
 */
export function PositionField({ value, onChange, label = 'Map position' }: { value: Position | null; onChange: (p: Position | null) => void; label?: string }) {
  const overlay = useOverlay();
  const askText = useAskText();
  const [busy, setBusy] = useState(false);

  const here = async () => {
    setBusy(true);
    try {
      onChange(await currentPosition());
      overlay.success('Position saved from your phone');
    } catch (e) {
      overlay.error(e);
    } finally {
      setBusy(false);
    }
  };

  const paste = async () => {
    const text = await askText({ title: 'Paste a Google Maps link', hint: 'Share → Copy link in Google Maps, or "-1.2864, 36.8172"', confirm: 'Use it' });
    if (!text) return;
    const p = parsePosition(text);
    if (p) onChange(p);
    else overlay.error('No position found in that text. Short links (maps.app.goo.gl) must be opened first, then copy the full address.');
  };

  return (
    <div className="card" style={{ padding: 12 }}>
      <div className="row" style={{ gap: 8 }}>
        <MapPin size={20} color={value ? colors.success : 'var(--muted)'} />
        <div className="col grow">
          <span className="bold">{label}</span>
          <span className="tiny muted">{value ? `${value.lat.toFixed(5)}, ${value.lng.toFixed(5)}` : 'Not set: needed to track deliveries to the door'}</span>
        </div>
        {value && (
          <button className="icon-btn" aria-label="Clear position" onClick={() => onChange(null)}>
            <X size={18} />
          </button>
        )}
      </div>
      <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <button type="button" className="btn tonal small" style={{ flex: 1 }} disabled={busy} onClick={here}>
          {busy ? <Spinner /> : <Crosshair size={18} />} I'm at this store
        </button>
        <button type="button" className="btn outline small" style={{ flex: 1 }} onClick={paste}>
          <Link2 size={18} /> Paste link
        </button>
      </div>
      {value && (
        <div style={{ marginTop: 10 }}>
          <MapView height={180} markers={[{ ...value, label: '●', color: colors.info }]} onPick={(lat, lng) => onChange({ lat, lng })} />
        </div>
      )}
    </div>
  );
}
