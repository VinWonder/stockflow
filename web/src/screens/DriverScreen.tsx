import { useEffect, useRef, useState } from 'react';
import { CircleCheck, MapPin, Navigation, Package, Phone, Radio, TriangleAlert } from 'lucide-react';

import { api } from '../lib/api';
import { ago } from '../lib/format';
import type { Json } from '../lib/models';
import { colors } from '../lib/theme';
import { Card, ErrorView, LoadingList, Spinner } from '../ui/common';
import { directionsLink } from '../ui/MapView';

const SEND_EVERY_MS = 10000;
const NEAR_M = 200;
const memoryKey = (token: string) => `drive-sharing-${token}`;
const remember = (token: string, on: boolean) => {
  try {
    if (on) localStorage.setItem(memoryKey(token), '1');
    else localStorage.removeItem(memoryKey(token));
  } catch {
    // private mode
  }
};
const remembered = (token: string) => {
  try {
    return localStorage.getItem(memoryKey(token)) === '1';
  } catch {
    return false;
  }
};

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
  const [arriving, setArriving] = useState(false);
  const watch = useRef<number | null>(null);
  const lastPost = useRef(0);
  const wake = useRef<any>(null);

  const load = () =>
    api.get<Json>(`/track/${token}/`).then(
      (t) => {
        setTrip(t);
        if (t.status !== 'in_transit' || t.driver_arrived_at) remember(token, false);
      },
      (e) => setError(e),
    );

  useEffect(() => {
    load().then(() => {
      // Reopened the link (or the browser reloaded it): carry on sharing without asking again.
      if (remembered(token)) start();
    });
    return () => stopWatch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Phones pause web pages in the background: when the driver comes back, send the position at once.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || watch.current == null) return;
      lastPost.current = 0;
      navigator.geolocation.getCurrentPosition((pos) => sendPosition(pos), () => {}, { enableHighAccuracy: true, timeout: 20000 });
      (navigator as any).wakeLock?.request('screen').then((l: any) => (wake.current = l), () => {});
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendPosition = async (pos: GeolocationPosition) => {
    lastPost.current = Date.now();
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
      setGpsError(null);
    } catch (e: any) {
      if (e?.status === 409) {
        stop();
        load();
      }
    }
  };

  const stopWatch = () => {
    if (watch.current != null) navigator.geolocation.clearWatch(watch.current);
    watch.current = null;
    wake.current?.release?.().catch(() => {});
    wake.current = null;
  };

  const stop = () => {
    remember(token, false);
    stopWatch();
    setSharing(false);
  };

  const reportArrival = async () => {
    setArriving(true);
    try {
      const result = await api.post<Json>(`/track/${token}/`, { arrived: true });
      setTrip(result);
      setGpsError(null);
      stop();
    } catch (e: any) {
      setGpsError(e?.message ?? 'Could not report arrival. Please try again.');
    } finally {
      setArriving(false);
    }
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
    if (watch.current != null) return;
    setSharing(true);
    remember(token, true);
    lastPost.current = 0;
    watch.current = navigator.geolocation.watchPosition(
      (pos) => {
        if (Date.now() - lastPost.current >= SEND_EVERY_MS) sendPosition(pos);
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

  const active = trip.status === 'in_transit' && !trip.driver_arrived_at;
  const km = trip.distance_left_m != null ? (trip.distance_left_m / 1000).toFixed(trip.distance_left_m < 10000 ? 1 : 0) : null;
  const dest = trip.destination;
  const near = !!trip.arrived_near_at || (trip.distance_left_m != null && trip.distance_left_m <= NEAR_M) || !dest;

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
          <h2 style={{ margin: '8px 0 4px' }}>
            {trip.driver_arrived_at ? 'Arrival reported' : trip.status === 'received' ? 'Delivered. Thank you!' : trip.status_label}
          </h2>
          <p className="muted" style={{ margin: 0 }}>
            {trip.driver_arrived_at ? 'The shop has been asked to confirm and count the goods.' : 'You can close this page.'}
          </p>
        </Card>
      ) : (
        <>
          <Card style={{ marginTop: 16 }}>
            <div className="row">
              <span className={`live-dot${sharing ? ' on' : ''}`} />
              <div className="col grow">
                <span className="heavy" style={{ fontSize: 17 }}>{sharing ? 'Sharing your location' : 'Location not shared yet'}</span>
                <span className="small muted">
                  {sharing
                    ? lastSent ? `Last sent ${ago(lastSent)}. Keep this page open until you arrive.` : 'Getting GPS…'
                    : `Tap Start so ${trip.to} can see you coming.`}
                </span>
              </div>
            </div>
            {gpsError && (
              <div className="row small" style={{ marginTop: 10, color: colors.danger }}>
                <TriangleAlert size={18} /> {gpsError}
              </div>
            )}
            {!sharing ? (
              <button className="btn block success" style={{ marginTop: 14, minHeight: 58, fontSize: 17 }} onClick={start}>
                <Radio size={22} /> Start trip & share location
              </button>
            ) : sharing && near ? (
              <button className="btn block success" style={{ marginTop: 14 }} disabled={arriving} onClick={reportArrival}>
                {arriving ? <Spinner /> : <MapPin size={20} />} I've arrived — notify the shop
              </button>
            ) : null}
            {sharing && (
              <p className="tiny muted" style={{ margin: '10px 0 0' }}>
                You can use other apps, but the phone may pause sharing until you come back to this page; it then carries on by
                itself. For the best tracking, leave this page open on the screen.
              </p>
            )}
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
