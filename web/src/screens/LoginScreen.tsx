import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, Eye, EyeOff, KeyRound, Lock, Mail, Package, User } from 'lucide-react';

import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Card, Spinner } from '../ui/common';
import { useOverlay } from '../ui/overlay';
import { InstallBanner } from '../ui/install';

export function PasswordInput({ value, onChange, placeholder = 'Password', autoComplete = 'current-password' }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoComplete?: string;
}) {
  const [hide, setHide] = useState(true);
  return (
    <div className="input-wrap has-trail">
      <Lock size={20} />
      <input className="input" type={hide ? 'password' : 'text'} autoComplete={autoComplete} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
      <button type="button" className="icon-btn trail" onClick={() => setHide(!hide)} aria-label={hide ? 'Show password' : 'Hide password'}>
        {hide ? <Eye size={20} /> : <EyeOff size={20} />}
      </button>
    </div>
  );
}

/** Dark header with the logo, shared by sign-in, sign-up and reset. */
export function AuthFrame({ title, subtitle, children, onBack }: { title: string; subtitle: string; children: React.ReactNode; onBack?: () => void }) {
  return (
    <div style={{ position: 'relative', minHeight: '100dvh' }}>
      <div className="login-bg" />
      <div className="login">
        <div className="row" style={{ minHeight: 54 }}>
          {onBack ? (
            <button className="icon-btn" onClick={onBack} aria-label="Back" style={{ color: '#fff' }}>
              <ArrowLeft size={22} />
            </button>
          ) : (
            <span className="icon-box" style={{ width: 54, height: 54, borderRadius: 16, background: 'var(--amber)', color: '#1F1300' }}>
              <Package size={30} />
            </span>
          )}
        </div>
        <h1 style={{ color: '#fff', fontSize: 32, fontWeight: 800, letterSpacing: -1, margin: '24px 0 6px' }}>{title}</h1>
        <p style={{ color: 'rgba(255,255,255,.75)', fontSize: 15.5, margin: '0 0 32px' }}>{subtitle}</p>
        {children}
      </div>
    </div>
  );
}

export function LoginScreen() {
  const { login } = useAuth();
  const overlay = useOverlay();
  const navigate = useNavigate();
  const arrived = (useLocation().state ?? {}) as { signedUp?: boolean; login?: string };
  const [mode, setMode] = useState<'login' | 'forgot'>('login');
  const [notice, setNotice] = useState(arrived.signedUp ? 'Your account is ready. Sign in with your email and password.' : '');
  const [username, setUsername] = useState(arrived.login ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      overlay.error('Enter your username or email, and your password.');
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

  if (mode === 'forgot') {
    return (
      <ForgotPassword
        initialEmail={username.includes('@') ? username : ''}
        onBack={() => setMode('login')}
        onDone={(login) => {
          setUsername(login);
          setPassword('');
          setNotice('Password changed. Sign in with your new password.');
          setMode('login');
        }}
      />
    );
  }

  return (
    <AuthFrame title="StockFlow" subtitle="Shops and godowns, in your pocket.">
      <Card style={{ padding: 20 }}>
        <form className="stack" onSubmit={submit}>
          <div className="heavy" style={{ fontSize: 20 }}>Sign in</div>
          {notice && <div className="notice">{notice}</div>}
          <div className="input-wrap">
            <User size={20} />
            <input className="input" autoComplete="username" placeholder="Username or email" autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <PasswordInput value={password} onChange={setPassword} />
          <div style={{ textAlign: 'right', marginTop: 4 }}>
            <button type="button" className="btn text" onClick={() => setMode('forgot')}>Forgot password?</button>
          </div>
          <button className="btn block" type="submit" disabled={busy}>
            {busy ? <Spinner /> : 'Sign in'}
          </button>
        </form>
      </Card>
      <Card style={{ padding: 16, marginTop: 12 }}>
        <div className="row">
          <div className="col grow">
            <span className="bold">New to StockFlow?</span>
            <span className="small muted">Open an account for your shop and godowns.</span>
          </div>
          <button className="btn tonal small" onClick={() => navigate('/signup')}>Create account</button>
        </div>
      </Card>
      <InstallBanner />
    </AuthFrame>
  );
}

/** Forgot password: email → confirm the 6-digit code → new password → back to sign in. */
function ForgotPassword({ initialEmail, onBack, onDone }: { initialEmail: string; onBack: () => void; onDone: (login: string) => void }) {
  const overlay = useOverlay();
  const [step, setStep] = useState<'email' | 'code' | 'password'>('email');
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      overlay.error(err);
    } finally {
      setBusy(false);
    }
  };

  const sendCode = (e?: FormEvent) => {
    e?.preventDefault();
    if (!email.trim()) return overlay.error('Enter the email on your account.');
    return run(async () => {
      await api.post('/auth/password/forgot/', { email: email.trim() });
      setStep('code');
      overlay.success('If the account exists, a code is on its way. Check your inbox (and spam).');
    });
  };

  const confirmCode = (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) return overlay.error('Enter the 6-digit code from the email.');
    return run(async () => {
      await api.post('/auth/password/verify/', { email: email.trim(), code });
      setStep('password');
    });
  };

  const reset = (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 8) return overlay.error('The new password needs at least 8 characters.');
    if (password !== password2) return overlay.error("The two passwords don't match.");
    return run(async () => {
      await api.post('/auth/password/reset/', { email: email.trim(), code, new_password: password });
      onDone(email.trim());
    });
  };

  const titles = { email: "We'll email you a 6-digit code.", code: 'Enter the code from the email.', password: 'Choose a new password.' };

  return (
    <AuthFrame title="Reset password" subtitle={titles[step]} onBack={step === 'email' ? onBack : () => setStep(step === 'password' ? 'code' : 'email')}>
      <Card style={{ padding: 20 }}>
        {step === 'email' && (
          <form className="stack" onSubmit={sendCode}>
            <div className="input-wrap">
              <Mail size={20} />
              <input className="input" type="email" autoFocus autoComplete="email" placeholder="Email on your account" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <button className="btn block" type="submit" disabled={busy}>{busy ? <Spinner /> : 'Send code'}</button>
          </form>
        )}
        {step === 'code' && (
          <form className="stack" onSubmit={confirmCode}>
            <p className="small" style={{ margin: 0 }}>We sent a code to <b>{email}</b>. It works for 15 minutes.</p>
            <div className="input-wrap">
              <KeyRound size={20} />
              <input
                className="input"
                autoFocus
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="6-digit code"
                maxLength={6}
                style={{ letterSpacing: 6, fontWeight: 800, fontSize: 18 }}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
            </div>
            <button className="btn block" type="submit" disabled={busy}>{busy ? <Spinner /> : 'Confirm code'}</button>
            <button type="button" className="btn text block" disabled={busy} onClick={() => sendCode()}>Send a new code</button>
          </form>
        )}
        {step === 'password' && (
          <form className="stack" onSubmit={reset}>
            <PasswordInput value={password} onChange={setPassword} placeholder="New password (8+ characters)" autoComplete="new-password" />
            <PasswordInput value={password2} onChange={setPassword2} placeholder="Type it again" autoComplete="new-password" />
            <button className="btn block" type="submit" disabled={busy}>{busy ? <Spinner /> : 'Change password'}</button>
          </form>
        )}
      </Card>
    </AuthFrame>
  );
}
