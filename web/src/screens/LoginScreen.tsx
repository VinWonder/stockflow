import { useState, type FormEvent } from 'react';
import { Eye, EyeOff, Lock, Package, Server, User } from 'lucide-react';

import { getBaseUrl, setBaseUrl } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Card, Spinner } from '../ui/common';
import { Dialog, useOverlay } from '../ui/overlay';
import { InstallBanner } from '../ui/install';

function ServerDialog({ close }: { close: (v?: string) => void }) {
  const [url, setUrl] = useState(getBaseUrl());
  return (
    <Dialog
      onClose={() => close()}
      title="Server address"
      actions={
        <>
          <button className="btn text" onClick={() => close()}>Cancel</button>
          <button className="btn small" onClick={() => close(url.trim())}>Save</button>
        </>
      }
    >
      <input className="input" type="url" autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="/api" />
      <p className="tiny muted" style={{ marginTop: 10, whiteSpace: 'pre-line' }}>
        {'Leave as /api when the app is opened from the server itself.\nOther server: https://your-domain/api'}
      </p>
    </Dialog>
  );
}

export function LoginScreen() {
  const { login } = useAuth();
  const overlay = useOverlay();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [hide, setHide] = useState(true);
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState(getBaseUrl());

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      overlay.error('Enter your username and password.');
      return;
    }
    setBusy(true);
    try {
      await login(username, password);
    } catch (err) {
      overlay.error(err);
    } finally {
      setBusy(false);
    }
  };

  const changeServer = async () => {
    const value = await overlay.open<string>((close) => <ServerDialog close={close} />);
    if (!value) return;
    setBaseUrl(value);
    setServer(getBaseUrl());
    overlay.success(`Server set to ${getBaseUrl()}`);
  };

  return (
    <div style={{ position: 'relative', minHeight: '100dvh' }}>
      <div className="login-bg" />
      <div className="login">
        <div className="row">
          <span className="icon-box" style={{ width: 54, height: 54, borderRadius: 16, background: 'var(--amber)', color: '#1F1300' }}>
            <Package size={30} />
          </span>
          <span className="grow" />
          <button className="icon-btn" onClick={changeServer} aria-label="Server address" title="Server address" style={{ color: 'rgba(255,255,255,.7)' }}>
            <Server size={22} />
          </button>
        </div>
        <h1 style={{ color: '#fff', fontSize: 34, fontWeight: 800, letterSpacing: -1, margin: '28px 0 6px' }}>StockFlow</h1>
        <p style={{ color: 'rgba(255,255,255,.7)', fontSize: 16, margin: '0 0 40px' }}>Godown and shop stock, in your pocket.</p>
        <Card style={{ padding: 20 }}>
          <form className="stack" onSubmit={submit}>
            <div className="heavy" style={{ fontSize: 20 }}>Sign in</div>
            <div className="input-wrap">
              <User size={20} />
              <input className="input" autoComplete="username" placeholder="Username" autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} />
            </div>
            <div className="input-wrap has-trail">
              <Lock size={20} />
              <input
                className="input"
                type={hide ? 'password' : 'text'}
                autoComplete="current-password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button type="button" className="icon-btn trail" onClick={() => setHide(!hide)} aria-label={hide ? 'Show password' : 'Hide password'}>
                {hide ? <Eye size={20} /> : <EyeOff size={20} />}
              </button>
            </div>
            <button className="btn block" type="submit" disabled={busy} style={{ marginTop: 20 }}>
              {busy ? <Spinner /> : 'Sign in'}
            </button>
          </form>
        </Card>
        <InstallBanner />
        <p className="tiny muted" style={{ textAlign: 'center', marginTop: 16 }}>Server: {server}</p>
      </div>
    </div>
  );
}
