import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowDownLeft, ArrowLeftRight, Boxes, Building2, ChevronRight, HandCoins, LogOut, MessageSquareText, Moon, PackageMinus,
  ShoppingCart, Store, Truck, TriangleAlert, UserCog, Users, type LucideIcon,
} from 'lucide-react';

import { useAuth, useMe } from '../lib/auth';
import { displayName, initials, isManager, roleLabel } from '../lib/models';
import { applyThemeMode, colors, getThemeMode, type ThemeMode } from '../lib/theme';
import { Card, SectionTitle, TopBar } from '../ui/common';
import { InstallBanner } from '../ui/install';
import { useConfirm } from '../ui/overlay';

type Item = { icon: LucideIcon; label: string; to: string; hint?: string; show?: boolean };

export function MoreScreen() {
  const me = useMe();
  const { logout } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [mode, setMode] = useState<ThemeMode>(getThemeMode);

  const work: Item[] = [
    { icon: ShoppingCart, label: 'Sell', to: '/sell' },
    { icon: ArrowDownLeft, label: 'Receive supplier delivery', to: '/receive', show: isManager(me) },
    { icon: ArrowLeftRight, label: 'Transfers & live tracking', to: '/transfers' },
    { icon: PackageMinus, label: 'Remove / add stock', to: '/requests/new' },
    { icon: TriangleAlert, label: 'Restock: low & out of stock', to: '/alerts?state=alert' },
    { icon: HandCoins, label: 'Customers & credit', to: '/customers' },
    { icon: Truck, label: 'Suppliers', to: '/suppliers' },
    { icon: MessageSquareText, label: 'Commands by WhatsApp / SMS', to: '/compose' },
  ];
  const manage: Item[] = [
    { icon: Boxes, label: 'Products & prices', to: '/products', hint: 'Sizes, colours, buying and selling prices' },
    { icon: Store, label: 'Shops & godowns', to: '/stores', hint: 'Add stores, map positions, who can sell' },
    { icon: Users, label: 'Team', to: '/team', hint: 'Managers and shop staff, and their stores' },
    { icon: Building2, label: 'Business details', to: '/settings' },
  ];

  const Group = ({ items }: { items: Item[] }) => (
    <Card className="group">
      {items.filter((w) => w.show !== false).map((w) => (
        <button key={w.to} className="tile" onClick={() => navigate(w.to)}>
          <w.icon size={22} color="var(--primary)" />
          <div className="col grow">
            <span style={{ fontWeight: 600 }}>{w.label}</span>
            {w.hint && <span className="small muted">{w.hint}</span>}
          </div>
          <ChevronRight size={20} />
        </button>
      ))}
    </Card>
  );

  return (
    <main className="page">
      <TopBar title="More" />
      <Card onClick={() => navigate('/settings')}>
        <div className="row" style={{ gap: 14 }}>
          <span className="avatar" style={{ width: 56, height: 56, background: colors.steel, color: '#fff', fontSize: 18 }}>
            {initials(displayName(me))}
          </span>
          <div className="col grow">
            <span className="heavy" style={{ fontSize: 17 }}>{displayName(me)}</span>
            <span>{roleLabel(me)}{me.business ? ` · ${me.business.name}` : ''}</span>
            <span className="small" style={{ color: me.phone ? 'var(--muted)' : colors.danger }}>
              {me.phone ? `+${me.phone}` : 'Add your phone to use SMS/WhatsApp commands'}
            </span>
          </div>
          <UserCog size={22} />
        </div>
      </Card>
      <InstallBanner />

      <SectionTitle>Work</SectionTitle>
      <Group items={work} />

      {me.is_admin && (
        <>
          <SectionTitle>Manage your business</SectionTitle>
          <Group items={manage} />
        </>
      )}

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
