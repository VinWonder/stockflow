import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { api, tokens } from '../lib/api';
import { useAuth, useMe } from '../lib/auth';
import type { Business } from '../lib/models';
import { Card, Field, SectionTitle, Spinner, Switch, TopBar } from '../ui/common';
import { useOverlay } from '../ui/overlay';
import { PasswordInput } from './LoginScreen';

/** My account (name, email, phone, alerts, password) and, for the owner, the business details. */
export function SettingsScreen() {
  const me = useMe();
  const { refreshMe } = useAuth();
  const overlay = useOverlay();
  const [first, setFirst] = useState(me.first_name);
  const [last, setLast] = useState(me.last_name);
  const [email, setEmail] = useState(me.email);
  const [phone, setPhone] = useState(me.phone ? `0${me.phone.slice(3)}` : '');
  const [busy, setBusy] = useState('');
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const biz = useQuery({ queryKey: ['business'], queryFn: () => api.get<Business>('/business/'), enabled: me.is_admin });
  const [b, setB] = useState<Business | null>(null);
  const [smsAlerts, setSmsAlerts] = useState(false);

  useEffect(() => {
    if (biz.data && !b) setB(biz.data);
  }, [biz.data, b]);

  useEffect(() => {
    api.get<{ sms_alerts: boolean }>('/auth/me/').then((m) => setSmsAlerts(!!m.sms_alerts), () => {});
  }, []);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      overlay.error(e);
    } finally {
      setBusy('');
    }
  };

  return (
    <main className="page">
      <TopBar title="Settings" back />
      <SectionTitle>My account</SectionTitle>
      <Card className="stack">
        <div className="grid-2">
          <Field label="First name"><input className="input" value={first} onChange={(e) => setFirst(e.target.value)} /></Field>
          <Field label="Last name"><input className="input" value={last} onChange={(e) => setLast(e.target.value)} /></Field>
        </div>
        <Field label="Email (for password reset codes)"><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Phone (SMS / WhatsApp commands come from this number)"><input className="input" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
        <Switch checked={smsAlerts} onChange={setSmsAlerts} title="Important alerts by SMS too" />
        <button
          className="btn block"
          disabled={busy === 'me'}
          onClick={() => run('me', async () => {
            await api.patch('/auth/me/', { first_name: first.trim(), last_name: last.trim(), email: email.trim(), phone: phone.trim() || null, sms_alerts: smsAlerts });
            await refreshMe();
            overlay.success('Saved');
          })}
        >
          {busy === 'me' ? <Spinner /> : 'Save my details'}
        </button>
      </Card>

      <SectionTitle>Change password</SectionTitle>
      <Card className="stack">
        <PasswordInput value={oldPw} onChange={setOldPw} placeholder="Current password" />
        <PasswordInput value={newPw} onChange={setNewPw} placeholder="New password (8+ characters)" autoComplete="new-password" />
        <button
          className="btn outline block"
          disabled={busy === 'pw' || !oldPw || newPw.length < 8}
          onClick={() => run('pw', async () => {
            const r = await api.post<{ access: string; refresh: string }>('/auth/password/change/', { old_password: oldPw, new_password: newPw });
            tokens.set(r.access, r.refresh);
            setOldPw('');
            setNewPw('');
            overlay.success('Password changed');
          })}
        >
          {busy === 'pw' ? <Spinner /> : 'Change password'}
        </button>
      </Card>

      {me.is_admin && b && (
        <>
          <SectionTitle>Business</SectionTitle>
          <Card className="stack">
            <Field label="Business name"><input className="input" value={b.name} onChange={(e) => setB({ ...b, name: e.target.value })} /></Field>
            <div className="grid-2">
              <Field label="Phone"><input className="input" type="tel" value={b.phone} onChange={(e) => setB({ ...b, phone: e.target.value })} /></Field>
              <Field label="KRA PIN"><input className="input" autoCapitalize="characters" value={b.kra_pin} onChange={(e) => setB({ ...b, kra_pin: e.target.value.toUpperCase() })} /></Field>
            </div>
            <Field label="Email"><input className="input" type="email" value={b.email} onChange={(e) => setB({ ...b, email: e.target.value })} /></Field>
            <Field label="Address"><input className="input" value={b.address} onChange={(e) => setB({ ...b, address: e.target.value })} /></Field>
            <button
              className="btn block"
              disabled={busy === 'biz' || !b.name.trim()}
              onClick={() => run('biz', async () => {
                await api.patch('/business/', { name: b.name.trim(), phone: b.phone.trim(), email: b.email.trim(), address: b.address.trim(), kra_pin: b.kra_pin.trim() });
                await refreshMe();
                overlay.success('Business details saved');
              })}
            >
              {busy === 'biz' ? <Spinner /> : 'Save business details'}
            </button>
          </Card>
        </>
      )}
    </main>
  );
}
