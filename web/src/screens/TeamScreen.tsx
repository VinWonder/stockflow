import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Phone, Plus, ShieldCheck, Store, UserRound, Users, Warehouse } from 'lucide-react';

import { api } from '../lib/api';
import { useMe } from '../lib/auth';
import { ago } from '../lib/format';
import { initials, isGodown, type Location, type TeamMember } from '../lib/models';
import { useLocations, useTeam } from '../lib/queries';
import { colors } from '../lib/theme';
import { BottomActions, Card, EmptyState, ErrorView, Field, LoadingList, Pill, Segmented, Spinner, Switch, TopBar } from '../ui/common';
import { Sheet, useOverlay } from '../ui/overlay';
import { PasswordInput } from './LoginScreen';

type Role = 'admin' | 'manager' | 'staff';
const ROLE_HELP: Record<Role, string> = {
  admin: 'Sees every store, approves transfers and stock changes, sets prices and staff.',
  manager: 'Receives deliveries, dispatches transfers and confirms removals at their stores.',
  staff: 'Sells and receives transfers at their stores, asks for removals.',
};

/** The owner's team: add managers and shop staff and choose which shops / godowns each one works in. */
export function TeamScreen() {
  const me = useMe();
  const overlay = useOverlay();
  const team = useTeam();
  const stores = useLocations().data ?? [];
  const names = new Map(stores.map((s) => [s.id, s.name]));

  const edit = (member?: TeamMember) => overlay.open<boolean>((close) => <MemberSheet member={member} stores={stores} close={close} />);

  return (
    <main className="page with-actions">
      <TopBar title="Team" back />
      {team.isPending ? (
        <LoadingList />
      ) : team.isError ? (
        <ErrorView error={team.error} onRetry={() => team.refetch()} />
      ) : team.data.length <= 1 ? (
        <EmptyState icon={Users} title="Just you so far" message="Add your stock managers and shop staff so they can sign in on their own phones." action="Add a person" onAction={() => edit()} />
      ) : null}
      <div className="list" style={{ marginTop: 8 }}>
        {(team.data ?? []).map((u) => (
          <Card key={u.id} onClick={u.id === me.id ? undefined : () => edit(u)} style={{ opacity: u.is_active ? 1 : 0.55 }}>
            <div className="row">
              <span className="avatar">{initials(u.full_name)}</span>
              <div className="col grow">
                <span className="heavy">{u.full_name}{u.id === me.id ? ' (you)' : ''}</span>
                <span className="small muted">
                  @{u.username}{u.phone ? ` · +${u.phone}` : ''}{u.last_login ? ` · seen ${ago(u.last_login)}` : ' · never signed in'}
                </span>
                <div className="wrap" style={{ gap: 6, marginTop: 4 }}>
                  <Pill text={u.role === 'admin' ? 'Owner / admin' : u.role_label} color={u.role === 'admin' ? colors.violet : u.role === 'manager' ? colors.info : colors.steel} icon={u.role === 'admin' ? ShieldCheck : undefined} />
                  {u.role !== 'admin' && u.locations.map((l) => <Pill key={l} text={names.get(l) ?? `#${l}`} color={colors.slate} />)}
                  {u.role !== 'admin' && u.locations.length === 0 && <Pill text="No store yet" color={colors.danger} />}
                  {!u.is_active && <Pill text="Deactivated" color={colors.danger} />}
                </div>
              </div>
              {u.phone && (
                <a className="icon-btn" href={`tel:+${u.phone}`} onClick={(e) => e.stopPropagation()} aria-label={`Call ${u.full_name}`}>
                  <Phone size={20} />
                </a>
              )}
            </div>
          </Card>
        ))}
      </div>
      <BottomActions>
        <button className="btn" onClick={() => edit()}>
          <Plus size={20} /> Add a person
        </button>
      </BottomActions>
    </main>
  );
}

function MemberSheet({ member, stores, close }: { member?: TeamMember; stores: Location[]; close: (v?: boolean) => void }) {
  const overlay = useOverlay();
  const qc = useQueryClient();
  const [first, setFirst] = useState(member?.first_name ?? '');
  const [last, setLast] = useState(member?.last_name ?? '');
  const [username, setUsername] = useState(member?.username ?? '');
  const [phone, setPhone] = useState(member?.phone ? `0${member.phone.slice(3)}` : '');
  const [email, setEmail] = useState(member?.email ?? '');
  const [role, setRole] = useState<Role>((member?.role as Role) ?? 'staff');
  const [locations, setLocations] = useState<number[]>(member?.locations ?? []);
  const [password, setPassword] = useState('');
  const [active, setActive] = useState(member?.is_active ?? true);
  const [sms, setSms] = useState(member?.sms_alerts ?? false);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!first.trim()) return overlay.error('Enter their first name.');
    if (!username.trim()) return overlay.error('Choose a username they will sign in with.');
    if (!member && password.length < 8) return overlay.error('Give them a password of at least 8 characters.');
    if (role !== 'admin' && locations.length === 0) return overlay.error('Choose at least one store they work in.');
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        first_name: first.trim(), last_name: last.trim(), username: username.trim().toLowerCase(), phone: phone.trim() || null,
        email: email.trim(), role, locations: role === 'admin' ? [] : locations, is_active: active, sms_alerts: sms,
      };
      if (password) body.password = password;
      if (member) await api.patch(`/users/${member.id}/`, body);
      else await api.post('/users/', body);
      qc.invalidateQueries({ queryKey: ['team'] });
      overlay.success(member ? 'Saved' : `${first.trim()} can now sign in as "${username.trim().toLowerCase()}"`);
      close(true);
    } catch (e) {
      overlay.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet onClose={() => close()} title={member ? `Edit ${member.full_name}` : 'Add a person'} tall>
      <div className="sheet-body stack" style={{ flex: 1 }}>
        <div className="grid-2">
          <Field label="First name"><input className="input" autoFocus={!member} autoCapitalize="words" value={first} onChange={(e) => setFirst(e.target.value)} /></Field>
          <Field label="Last name"><input className="input" autoCapitalize="words" value={last} onChange={(e) => setLast(e.target.value)} /></Field>
        </div>
        <div className="grid-2">
          <Field label="Username (to sign in)"><input className="input" autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value.replace(/\s/g, ''))} /></Field>
          <Field label="Phone (for SMS commands)"><input className="input" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
        </div>
        <Field label="Email (optional, for password reset)"><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Role">
          <Segmented<Role>
            value={role}
            onChange={setRole}
            options={[
              { value: 'staff', label: 'Shop staff', icon: UserRound },
              { value: 'manager', label: 'Manager', icon: Warehouse },
              { value: 'admin', label: 'Admin', icon: ShieldCheck },
            ]}
          />
          <span className="tiny muted" style={{ display: 'block', margin: '6px 4px 0' }}>{ROLE_HELP[role]}</span>
        </Field>
        {role !== 'admin' && (
          <Field label="Works at">
            <div className="wrap">
              {stores.map((s) => {
                const on = locations.includes(s.id);
                const Icon = isGodown(s) ? Warehouse : Store;
                return (
                  <button key={s.id} type="button" className={`choice${on ? ' on' : ''}`} onClick={() => setLocations(on ? locations.filter((x) => x !== s.id) : [...locations, s.id])}>
                    <Icon size={16} /> {s.name}
                  </button>
                );
              })}
            </div>
          </Field>
        )}
        <Field label={member ? 'New password (leave empty to keep)' : 'Password'}>
          <PasswordInput value={password} onChange={setPassword} placeholder="8+ characters" autoComplete="new-password" />
        </Field>
        <Switch checked={sms} onChange={setSms} title="Important alerts by SMS too" subtitle="Approvals, arrivals, low stock" />
        {member && <Switch checked={active} onChange={setActive} title="Can sign in" subtitle="Switch off when someone leaves. Their history is kept." />}
      </div>
      <div style={{ padding: '8px 12px 12px' }}>
        <button className="btn block" disabled={busy} onClick={save}>{busy ? <Spinner /> : member ? 'Save' : 'Add person'}</button>
      </div>
    </Sheet>
  );
}
