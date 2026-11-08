import { Navigate, Route, Routes, useParams, useSearchParams } from 'react-router-dom';

import { useAuth } from './lib/auth';
import { Spinner } from './ui/common';
import { Shell } from './screens/Shell';
import { LoginScreen } from './screens/LoginScreen';
import { DashboardScreen } from './screens/DashboardScreen';
import { LocationsScreen } from './screens/LocationsScreen';
import { LocationScreen } from './screens/LocationScreen';
import { InboxScreen } from './screens/InboxScreen';
import { MoreScreen } from './screens/MoreScreen';
import { ItemHistoryScreen } from './screens/ItemHistoryScreen';
import { ReceiveScreen } from './screens/ReceiveScreen';
import { SaleScreen } from './screens/SaleScreen';
import { NewTransferScreen, TransferDetailScreen } from './screens/TransferScreens';
import { NewRequestScreen, RequestDetailScreen } from './screens/RequestScreens';
import { ComposeScreen } from './screens/ComposeScreen';
import { SuppliersScreen } from './screens/SuppliersScreen';

const num = (v: string | null | undefined) => (v && /^\d+$/.test(v) ? Number(v) : null);

/** Wraps a screen so it gets numeric route/query params and remounts when they change. */
function WithParams({ render }: { render: (p: { id: (k: string) => number; q: (k: string) => number | null; s: URLSearchParams }) => JSX.Element }) {
  const params = useParams();
  const [search] = useSearchParams();
  return render({ id: (k) => num(params[k]) ?? 0, q: (k) => num(search.get(k)), s: search });
}

export function App() {
  const { status } = useAuth();

  if (status === 'unknown') {
    return (
      <div className="splash">
        <Spinner />
      </div>
    );
  }
  // Signed out: show sign-in at whatever address was opened, then carry on to it.
  if (status === 'signedOut') return <LoginScreen />;

  return (
    <Routes>
      <Route element={<Shell />}>
        <Route path="/" element={<DashboardScreen />} />
        <Route path="/stores" element={<LocationsScreen />} />
        <Route path="/stores/:id" element={<WithParams render={({ id }) => <LocationScreen key={id('id')} locationId={id('id')} />} />} />
        <Route path="/inbox" element={<InboxScreen />} />
        <Route path="/more" element={<MoreScreen />} />
      </Route>
      <Route
        path="/item/:location/:variant"
        element={<WithParams render={({ id }) => <ItemHistoryScreen locationId={id('location')} variantId={id('variant')} />} />}
      />
      <Route path="/receive" element={<WithParams render={({ q }) => <ReceiveScreen key={q('location')} locationId={q('location')} />} />} />
      <Route path="/sell" element={<WithParams render={({ q }) => <SaleScreen key={q('location')} locationId={q('location')} />} />} />
      <Route path="/transfers/new" element={<WithParams render={({ q }) => <NewTransferScreen key={q('from')} sourceId={q('from')} />} />} />
      <Route path="/transfers/:id" element={<WithParams render={({ id }) => <TransferDetailScreen key={id('id')} id={id('id')} />} />} />
      <Route
        path="/requests/new"
        element={
          <WithParams
            render={({ q, s }) => {
              const kind = s.get('kind') === 'add' ? 'add' : 'remove';
              return <NewRequestScreen key={`${q('location')}-${kind}`} locationId={q('location')} kind={kind} />;
            }}
          />
        }
      />
      <Route path="/requests/:id" element={<WithParams render={({ id }) => <RequestDetailScreen key={id('id')} id={id('id')} />} />} />
      <Route path="/compose" element={<WithParams render={({ q }) => <ComposeScreen key={q('location')} locationId={q('location')} />} />} />
      <Route path="/suppliers" element={<SuppliersScreen />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
