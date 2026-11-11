import { useEffect, useRef, useState } from 'react';

import type { Point } from '../lib/models';
import { useConfig } from '../lib/queries';
import { toD } from '../lib/format';

export interface Marker extends Point {
  label: string;
  color: string;
}

const n = (v: unknown) => toD(v);

/** Google Maps links work on every phone, with or without an API key. */
export const mapsLink = (p: Point) => `https://www.google.com/maps/search/?api=1&query=${n(p.lat)},${n(p.lng)}`;
export const directionsLink = (to: Point, from?: Point | null) =>
  `https://www.google.com/maps/dir/?api=1${from ? `&origin=${n(from.lat)},${n(from.lng)}` : ''}&destination=${n(to.lat)},${n(to.lng)}&travelmode=driving`;

/** Pull a position out of a pasted Google Maps link or "lat, lng" text. */
export function parsePosition(text: string): { lat: number; lng: number } | null {
  const t = decodeURIComponent(text.trim());
  const patterns = [/@(-?\d+\.\d+),\s*(-?\d+\.\d+)/, /[?&](?:q|query|ll|destination)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/, /^(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)$/, /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      const lat = parseFloat(m[1]);
      const lng = parseFloat(m[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
    }
  }
  return null;
}

let loader: Promise<any> | null = null;

function loadGoogle(key: string): Promise<any> {
  const w = window as any;
  if (w.google?.maps?.Map) return Promise.resolve(w.google);
  loader ??= new Promise((resolve, reject) => {
    w.__stockflowMapsReady = () => resolve(w.google);
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&callback=__stockflowMapsReady`;
    s.async = true;
    s.onerror = () => {
      loader = null;
      reject(new Error('Google Maps could not load'));
    };
    document.head.appendChild(s);
  });
  return loader;
}

/**
 * Map with markers and an optional travelled route. Uses Google Maps when GOOGLE_MAPS_API_KEY is set on the server;
 * otherwise shows an OpenStreetMap view (no key needed) so tracking still works.
 */
export function MapView({ markers, path = [], height = 260, onPick, follow }: {
  markers: Marker[];
  path?: Point[];
  height?: number;
  /** Tap the map to choose a position (store setup). */
  onPick?: (lat: number, lng: number) => void;
  /** Keep this point centred (the moving vehicle). */
  follow?: Point | null;
}) {
  const key = useConfig().data?.google_maps_key ?? '';
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<any>(null);
  const layers = useRef<any[]>([]);
  const fitted = useRef(false);
  const [failed, setFailed] = useState(false);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  useEffect(() => {
    if (!key || failed) return;
    let cancelled = false;
    loadGoogle(key)
      .then((google) => {
        if (cancelled || !el.current || map.current) return;
        const first = markers[0] ?? follow ?? { lat: -1.2864, lng: 36.8172 }; // Nairobi
        map.current = new google.maps.Map(el.current, {
          center: { lat: n(first.lat), lng: n(first.lng) },
          zoom: 14,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: true,
          gestureHandling: 'cooperative',
        });
        map.current.addListener('click', (e: any) => pickRef.current?.(e.latLng.lat(), e.latLng.lng()));
        draw(google);
      })
      .catch(() => setFailed(true));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, failed]);

  const draw = (google: any) => {
    if (!map.current) return;
    layers.current.forEach((l) => l.setMap(null));
    layers.current = [];
    const bounds = new google.maps.LatLngBounds();
    if (path.length > 1) {
      const line = new google.maps.Polyline({
        path: path.map((p) => ({ lat: n(p.lat), lng: n(p.lng) })),
        strokeColor: '#7C3AED',
        strokeOpacity: 0.85,
        strokeWeight: 5,
        map: map.current,
      });
      layers.current.push(line);
      path.forEach((p) => bounds.extend({ lat: n(p.lat), lng: n(p.lng) }));
    }
    for (const m of markers) {
      const pos = { lat: n(m.lat), lng: n(m.lng) };
      const marker = new google.maps.Marker({
        position: pos,
        map: map.current,
        title: m.name ?? m.label,
        label: { text: m.label, color: '#fff', fontWeight: '800', fontSize: '12px' },
        icon: { path: google.maps.SymbolPath.CIRCLE, scale: 14, fillColor: m.color, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 },
      });
      layers.current.push(marker);
      bounds.extend(pos);
    }
    if (follow && fitted.current) {
      map.current.panTo({ lat: n(follow.lat), lng: n(follow.lng) });
    } else if (markers.length + path.length > 1) {
      map.current.fitBounds(bounds, 48);
      fitted.current = true;
    } else if (markers[0]) {
      map.current.setCenter({ lat: n(markers[0].lat), lng: n(markers[0].lng) });
    }
  };

  useEffect(() => {
    const google = (window as any).google;
    if (google?.maps && map.current) draw(google);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(markers), path.length, follow?.lat, follow?.lng]);

  if (key && !failed) {
    return <div ref={el} className="map" style={{ height }} />;
  }

  // No key: OpenStreetMap embed around the points, centred on the most important marker.
  const all = [...markers, ...path];
  if (all.length === 0) {
    return (
      <div className="map map-empty" style={{ height: Math.min(height, 140) }}>
        <span className="small muted">No map position yet</span>
      </div>
    );
  }
  const lats = all.map((p) => n(p.lat));
  const lngs = all.map((p) => n(p.lng));
  const pad = 0.004;
  const bbox = [Math.min(...lngs) - pad, Math.min(...lats) - pad, Math.max(...lngs) + pad, Math.max(...lats) + pad].map((x) => x.toFixed(5)).join(',');
  const focus = follow ?? markers[0];
  const src = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${n(focus.lat)},${n(focus.lng)}`;
  return (
    <div className="map" style={{ height }}>
      <iframe title="Map" src={src} style={{ border: 0, width: '100%', height: '100%' }} loading="lazy" />
    </div>
  );
}
