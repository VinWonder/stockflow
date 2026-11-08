import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowDownLeft, ArrowLeftRight, ChevronRight, ExternalLink, LogOut, MessageSquareText, Moon, PackageMinus, Server,
  ShoppingCart, Truck, type LucideIcon,
} from 'lucide-react';

import { getBaseUrl } from '../lib/api';
import { useAuth, useMe } from '../lib/auth';
import { displayName, initials, roleLabel } from '../lib/models';
import { applyThemeMode, colors, getThemeMode, type ThemeMode } from '../lib/theme';
import { Card, SectionTitle, TopBar } from '../ui/common';
import { InstallBanner } from '../ui/install';
import { useConfirm } from '../ui/overlay';

export function MoreScreen() {
  const me = useMe();
  const { logout } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [mode, setMode] = useState<ThemeMode>(getThemeMode);

  const work: { icon: LucideIcon; label: string; to: string }[] = [
    { icon: ArrowDownLeft, label: 'Receive supplier delivery', to: '/receive' },
    { icon: ArrowLeftRight, label: 'New transfer', to: '/transfers/new' },
    { icon: ShoppingCart, label: 'Sell', to: '/sell' },
    { icon: PackageMinus, label: 'Remove / add stock', to: '/requests/new' },
    { icon: MessageSquareText, label: 'Send a command by WhatsApp / SMS', to: '/compose' },
    { icon: Truck, label: 'Suppliers', to: '/suppliers' },
  ];

  // The admin panel lives on the API server, next to /api.
  const adminUrl = new URL(getBaseUrl().replace(/\/api\/?$/, '') + '/admin/', window.location.origin).toString();

  return (
    <main className="page">
      <TopBar title="More" />
      <Card>
        <div className="row" style={{ gap: 14 }}>
          <span className="avatar" style={{ width: 56, height: 56, background: colors.steel, color: '#fff', fontSize: 18 }}>
            {initials(displayName(me))}
          </span>
          <div className="col grow">
            <span className="heavy" style={{ fontSize: 17 }}>{displayName(me)}</span>
            <span>{roleLabel(me)}</span>
            <span className="small" style={{ color: me.phone ? 'var(--muted)' : colors.danger }}>
              {me.phone ? `+${me.phone}` : 'No phone registered for SMS/WhatsApp'}
            </span>
          </div>
        </div>
      </Card>
      <InstallBanner />

      <SectionTitle>Work</SectionTitle>
      <Card className="group">
        {work.map((w) => (
          <button key={w.to} className="tile" onClick={() => navigate(w.to)}>
            <w.icon size={22} color="var(--primary)" />
            <span className="grow" style={{ fontWeight: 600 }}>{w.label}</span>
            <ChevronRight size={20} />
          </button>
        ))}
      </Card>

      <SectionTitle>App</SectionTitle>
      <Card className="group">
        <label className="tile" style={{ cursor: 'default' }}>
          <Moon size={22} />
          <span className="grow">Appearance</span>
          <select
            className="input"
            style={{ width: 'auto', minHeight: 40, padding: '6px 36px 6px 12px', backgroundPosition: 'calc(100% - 18px) 17px, calc(100% - 13px) 17px' }}
            value={mode}
            onChange={(e) => {
              const m = e.target.value as ThemeMode;
              setMode(m);
              applyThemeMode(m);
            }}
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
        <div className="tile" style={{ cursor: 'default' }}>
          <Server size={22} />
          <div className="col grow">
            <span>Server</span>
            <span className="small muted">{getBaseUrl()}</span>
          </div>
        </div>
        {me.is_admin && (
          <a className="tile" href={adminUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={22} />
            <div className="col grow">
              <span>Admin panel</span>
              <span className="small muted">Products, prices, stores and staff accounts</span>
            </div>
          </a>
        )}
        <button
          className="tile"
          onClick={async () => {
            if (await confirm({ title: 'Sign out?', message: 'You will need your password to sign in again.', confirm: 'Sign out', danger: true })) logout();
          }}
        >
          <LogOut size={22} color={colors.danger} />
          <span className="bold" style={{ color: colors.danger }}>Sign out</span>
        </button>
      </Card>
    </main>
  );
}
