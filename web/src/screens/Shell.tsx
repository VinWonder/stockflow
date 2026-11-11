import { NavLink, Outlet } from 'react-router-dom';
import { Inbox, LayoutDashboard, LayoutGrid, ShoppingCart, Store } from 'lucide-react';

import { useUnread } from '../lib/queries';

const tabs = [
  { to: '/', label: 'Home', icon: LayoutDashboard, end: true },
  { to: '/stores', label: 'Stores', icon: Store },
  { to: '/sell', label: 'Sell', icon: ShoppingCart },
  { to: '/inbox', label: 'Inbox', icon: Inbox, badge: true },
  { to: '/more', label: 'More', icon: LayoutGrid },
];

export function Shell() {
  const count = useUnread().data?.action ?? 0;
  return (
    <div className="shell">
      <Outlet />
      <nav className="nav" aria-label="Main">
        <img className="nav-brand" src="/pwa-64x64.png" width={44} height={44} alt="StockFlow" />
        {tabs.map(({ to, label, icon: Icon, end, badge }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="nav-icon">
              <Icon size={22} />
              {badge && count > 0 && <span className="badge">{count > 99 ? '99+' : count}</span>}
            </span>
            {label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
