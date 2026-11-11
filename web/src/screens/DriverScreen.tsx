import { useEffect, useRef, useState } from 'react';
import { CircleCheck, MapPin, Navigation, Package, Phone, Radio, TriangleAlert } from 'lucide-react';

import { api } from '../lib/api';
import { ago } from '../lib/format';
import type { Json } from '../lib/models';
import { colors } from '../lib/theme';
import { Card, ErrorView, LoadingList, Spinner } from '../ui/common';
import { directionsLink } from '../ui/MapView';

const SEND_EVERY_MS = 10000;

/**
 * Opened by the driver from the link sent by SMS (no account needed). While it's open it sends the phone's
 * GPS position, so the shop can watch the goods move to the destination in real time.
 */
export function DriverScreen({ token }: { token: string }) {
  const [trip, setTrip] = useState<Json | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [sharing, setSharing] = useState(false);
  const [lastSent, setLastSent] = useState<Date | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const watch = useRef<number | null>(null);
  const lastPost = useRef(0);
  const wake = useRef<any>(null);

  const load = () =>
    api.get<Json>(`/track/${token}/`).then(setTrip, (e) => setError(e));

  useEffect(() => {
    load();
    return () => stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const stop = () => {
    if (watch.current != null) navigator.geolocation.clearWatch(watch.current);
    watch.current = null;
    wake.current?.release?.().catch(() => {});
    wake.current = null;
    setSharing(false);
  };

  const start = async () => {
    if (!navigator.geolocation) {
      setGpsError('This phone has no GPS available in the browser.');
      return;
    }
    setGpsError(null);
    try {
      wake.current = await (navigator as any).wakeLock?.request('screen'); // keep the screen on while driving
    } catch {
      // not supported: fine
    }
    setSharing(true);
    lastPost.current = 0;
    watch.current = navigator.geolocation.watchPosition(
      async (pos) => {
        const now = Date.now();
        if (now - lastPost.current < SEND_EVERY_MS) return;
        lastPost.current = now;
        try {
          const r = await api.post<Json>(`/track/${token}/`, {
            lat: pos.coords.latitude.toFixed(6),
            lng: pos.coords.longitude.toFixed(6),
            accuracy: pos.coords.accuracy,
            speed: pos.coords.speed,
            heading: pos.coords.heading,
          });
          setTrip(r);
          setLastSent(new Date());
        } catch (e: any) {
          if (e?.status === 409) {
            stop();
            load();
          }
        }
      },
      (e) => setGpsError(e.code === 1 ? 'Location permission was refused. Allow location for this site, then tap Start again.' : 'Waiting for GPS signal…'),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 },
    );
  };

  if (error) {
    return (
      <main className="page" style={{ paddingTop: 40 }}>
        <ErrorView error={error} onRetry={load} />
      </main>
    );
  }
  if (!trip) {
    return (
      <main className="page" style={{ paddingTop: 40 }}>
        <LoadingList count={3} />
      </main>
    );
  }

  const active = trip.status === 'in_transit';
  const km = trip.distance_left_m != null ? (trip.distance_left_m / 1000).toFixed(trip.distance_left_m < 10000 ? 1 : 0) : null;
  const dest = trip.destination;

  return (
    <main className="page" style={{ paddingTop: 'calc(env(safe-area-inset-top) + 16px)' }}>
      <div className="hero">
        <div className="row">
          <Package size={28} />
          <div className="col grow">
            <span style={{ opacity: 0.75, fontWeight: 600 }}>{trip.code} · {trip.items} item(s)</span>
            <span style={{ fontSize: 20, fontWeight: 800 }}>{trip.from} → {trip.to}</span>
          </div>
        </div>
        <div style={{ marginTop: 10, opacity: 0.8 }}>{[trip.driver_name, trip.vehicle, trip.vehicle_reg].filter(Boolean).join(' · ')}</div>
      </div>

      {!active ? (
        <Card style={{ marginTop: 16, textAlign: 'center', padding: 28 }}>
          <CircleCheck size={48} color={colors.success} />
          <h2 style={{ margin: '8px 0 4px' }}>{trip.status === 'received' ? 'Delivered. Thank you!' : trip.status_label}</h2>
          <p className="muted" style={{ margin: 0 }}>You can close this page.</p>
        </Card>
      ) : (
        <>
          <Card style={{ marginTop: 16 }}>
            <div className="row">
              <span className={`live-dot${sharing ? ' on' : ''}`} />
              <div className="col grow">
                <span className="heavy" style={{ fontSize: 17 }}>{sharing ? 'Sharing your location' : 'Location not shared yet'}</span>
                <span className="small muted">
                  {sharing ? (lastSent ? `Last sent ${ago(lastSent)}. Keep this page open until you arrive.` : 'Getting GPS…') : `Tap Start so ${trip.to} can see you coming.`}
                </span>
              </div>
            </div>
            {gpsError && (
              <div className="row small" style={{ marginTop: 10, color: colors.danger }}>
                <TriangleAlert size={18} /> {gpsError}
              </div>
            )}
            <button className={`btn block ${sharing ? 'outline' : 'success'}`} style={{ marginTop: 14, minHeight: 58, fontSize: 17 }} onClick={sharing ? stop : start}>
              {sharing ? 'Pause sharing' : <><Radio size={22} /> Start trip & share location</>}
            </button>
          </Card>

          {km != null && (
            <div className="grid-2" style={{ marginTop: 12 }}>
              <Card>
                <div className="tiny muted">Distance left</div>
                <div className="kpi-value" style={{ marginTop: 4 }}>{km} km</div>
              </Card>
              <Card>
                <div className="tiny muted">Arriving in about</div>
                <div className="kpi-value" style={{ marginTop: 4 }}>{trip.eta_minutes} min</div>
              </Card>
            </div>
          )}

          <Card style={{ marginTop: 12 }}>
            <div className="row">
              <MapPin size={22} color={colors.danger} />
              <div className="col grow">
                <span className="bold">Deliver to {trip.to}</span>
                {trip.to_address && <span className="small muted">{trip.to_address}</span>}
              </div>
              {trip.to_phone && (
                <a className="icon-btn tonal" href={`tel:${trip.to_phone}`} aria-label="Call the shop">
                  <Phone size={20} />
                </a>
              )}
            </div>
            {dest && (
              <a className="btn tonal block" style={{ marginTop: 12 }} href={directionsLink(dest, trip.last)} target="_blank" rel="noreferrer">
                <Navigation size={20} /> Directions in Google Maps
              </a>
            )}
          </Card>
          {sharing && !lastSent && !gpsError && (
            <p className="small muted" style={{ textAlign: 'center', marginTop: 12 }}><Spinner /> Waiting for the first GPS fix…</p>
          )}
        </>
      )}
    </main>
  );
}
