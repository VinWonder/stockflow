import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, Check, KeyRound, Mail, Phone, Plus, Store, Trash2, User, Warehouse } from 'lucide-react';

import { api } from '../lib/api';
import { Card, Field, Segmented, Spinner } from '../ui/common';
import { useOverlay } from '../ui/overlay';
import { PositionField, type Position } from '../ui/PositionField';
import { AuthFrame, PasswordInput } from './LoginScreen';

interface StoreDraft {
  name: string;
  kind: 'shop' | 'godown';
  address: string;
}

const STEPS = ['You', 'Confirm email', 'Main shop', 'Other stores'];

/**
 * Open a client account without any back-office help: the business (a main shop with several stores),
 * the owner's login, the main shop and any other shops and godowns.
 */
export function SignupScreen() {
  const navigate = useNavigate();
  const overlay = useOverlay();
  const [step, setStep] = useState(0);
  const [business, setBusiness] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [mainName, setMainName] = useState('');
  const [mainAddress, setMainAddress] = useState('');
  const [mainPos, setMainPos] = useState<Position | null>(null);
  const [stores, setStores] = useState<StoreDraft[]>([{ name: '', kind: 'godown', address: '' }]);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');

  const sendCode = async () => {
    setBusy(true);
    try {
      await api.post('/auth/register/code/', { email: email.trim() });
      overlay.success(`Code sent to ${email.trim()}. Check your inbox (and spam).`);
      return true;
    } catch (e) {
      overlay.error(e);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const next = async () => {
    if (step === 0) {
      if (!business.trim() || !fullName.trim()) return overlay.error('Enter your business name and your name.');
      if (!/^\S+@\S+\.\S+$/.test(email.trim())) return overlay.error('Enter a valid email: password reset codes are sent there.');
      if (phone.replace(/\D/g, '').length < 9) return overlay.error('Enter your phone number, e.g. 0712 345 678.');
      if (password.length < 8) return overlay.error('Choose a password with at least 8 characters.');
      if (password !== password2) return overlay.error("The two passwords don't match.");
      if (!mainName) setMainName(`${business.trim()} Main Shop`);
      if (!(await sendCode())) return;
    }
    if (step === 1) {
      if (!/^d{6}$/.test(code)) return overlay.error('Enter the 6-digit code from the email.');
      setBusy(true);
      try {
        await api.post('/auth/register/verify/', { email: email.trim(), code });
      } catch (e) {
        return overlay.error(e);
      } finally {
        setBusy(false);
      }
    }
    if (step === 2 && !mainName.trim()) return overlay.error('Give your main shop a name.');
    setStep(step + 1);
  };

  const submit = async () => {
    const extra = stores.filter((s) => s.name.trim());
    const names = [mainName, ...extra.map((s) => s.name)].map((n) => n.trim().toLowerCase());
    if (new Set(names).size !== names.length) {
      overlay.error('Give each shop and godown a different name.');
      return;
    }
    setBusy(true);
    try {
      await api.post('/auth/register/', {
        email_code: code,
        business_name: business.trim(),
        full_name: fullName.trim(),
        email: email.trim(),
        phone: phone.trim(),
        password,
        main_shop: { name: mainName.trim(), address: mainAddress.trim(), latitude: mainPos?.lat.toFixed(6) ?? null, longitude: mainPos?.lng.toFixed(6) ?? null },
        stores: extra.map((s) => ({ name: s.name.trim(), kind: s.kind, address: s.address.trim() })),
      });
      navigate('/', { replace: true, state: { signedUp: true, login: email.trim() } });
      overlay.success(`Account created with ${1 + extra.length} store${extra.length ? 's' : ''}. Sign in to start.`);
    } catch (e) {
      overlay.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame
      title="Create account"
      subtitle="Your business, its main shop and every shop and godown under it."
      onBack={() => (step === 0 ? navigate('/', { replace: true }) : setStep(step - 1))}
    >
      <div className="stepper">
        {STEPS.map((s, i) => (
          <div key={s} className={`step${i === step ? ' on' : ''}${i < step ? ' done' : ''}`}>
            <span>{i < step ? <Check size={14} strokeWidth={3} /> : i + 1}</span>
            {s}
          </div>
        ))}
      </div>
      <Card style={{ padding: 20 }}>
        {step === 0 && (
          <div className="stack">
            <div className="input-wrap">
              <Building2 size={20} />
              <input className="input" autoFocus autoCapitalize="words" placeholder="Business name, e.g. Kamau Hardware" value={business} onChange={(e) => setBusiness(e.target.value)} />
            </div>
            <div className="input-wrap">
              <User size={20} />
              <input className="input" autoCapitalize="words" autoComplete="name" placeholder="Your full name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
            </div>
            <div className="input-wrap">
              <Mail size={20} />
              <input className="input" type="email" autoComplete="email" placeholder="Email (for sign-in and password reset)" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="input-wrap">
              <Phone size={20} />
              <input className="input" type="tel" autoComplete="tel" placeholder="Phone, e.g. 0712 345 678" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            <PasswordInput value={password} onChange={setPassword} placeholder="Password (8+ characters)" autoComplete="new-password" />
            <PasswordInput value={password2} onChange={setPassword2} placeholder="Type the password again" autoComplete="new-password" />
            <button className="btn block" disabled={busy} onClick={next}>{busy ? <Spinner /> : 'Next: confirm email'}</button>
          </div>
        )}

        {step === 1 && (
          <div className="stack">
            <p className="small" style={{ margin: 0 }}>We sent a 6-digit code to <b>{email.trim()}</b>. Enter it to confirm the email is yours.</p>
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
                onChange={(e) => setCode(e.target.value.replace(/D/g, ''))}
              />
            </div>
            <button className="btn block" disabled={busy} onClick={next}>{busy ? <Spinner /> : 'Confirm email'}</button>
            <button className="btn text block" disabled={busy} onClick={sendCode}>Send a new code</button>
          </div>
        )}

        {step === 2 && (
          <div className="stack">
            <p className="small" style={{ margin: 0 }}>Your <b>main shop</b> is the head office: it sells, receives deliveries and sends stock to the other stores.</p>
            <Field label="Main shop name">
              <input className="input" autoCapitalize="words" value={mainName} onChange={(e) => setMainName(e.target.value)} />
            </Field>
            <Field label="Where is it? (street, town)">
              <input className="input" autoCapitalize="words" value={mainAddress} onChange={(e) => setMainAddress(e.target.value)} />
            </Field>
            <PositionField value={mainPos} onChange={setMainPos} label="Map position (optional)" />
            <button className="btn block" onClick={next}>Next: other shops & godowns</button>
          </div>
        )}

        {step === 3 && (
          <div className="stack">
            <p className="small" style={{ margin: 0 }}>Add the other shops and godowns you have. You can add more, set their map positions and add staff later.</p>
            {stores.map((s, i) => (
              <div key={i} className="card" style={{ padding: 12, background: 'var(--bg)' }}>
                <div className="row" style={{ gap: 8 }}>
                  <input
                    className="input grow"
                    autoCapitalize="words"
                    placeholder={s.kind === 'godown' ? 'e.g. Home Godown' : 'e.g. Ruiru Shop'}
                    value={s.name}
                    onChange={(e) => setStores(stores.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                  />
                  <button className="icon-btn" aria-label="Remove" onClick={() => setStores(stores.filter((_, j) => j !== i))}>
                    <Trash2 size={20} />
                  </button>
                </div>
                <div style={{ marginTop: 8 }}>
                  <Segmented<'shop' | 'godown'>
                    value={s.kind}
                    onChange={(kind) => setStores(stores.map((x, j) => (j === i ? { ...x, kind } : x)))}
                    options={[
                      { value: 'shop', label: 'Shop', icon: Store },
                      { value: 'godown', label: 'Godown / store', icon: Warehouse },
                    ]}
                  />
                </div>
                <input
                  className="input"
                  style={{ marginTop: 8 }}
                  placeholder="Location (optional)"
                  value={s.address}
                  onChange={(e) => setStores(stores.map((x, j) => (j === i ? { ...x, address: e.target.value } : x)))}
                />
              </div>
            ))}
            <div className="row" style={{ gap: 8 }}>
              <button className="btn outline small grow" onClick={() => setStores([...stores, { name: '', kind: 'shop', address: '' }])}>
                <Plus size={18} /> Shop
              </button>
              <button className="btn outline small grow" onClick={() => setStores([...stores, { name: '', kind: 'godown', address: '' }])}>
                <Plus size={18} /> Godown
              </button>
            </div>
            <button className="btn block success" disabled={busy} onClick={submit}>
              {busy ? <Spinner /> : `Create account with ${1 + stores.filter((s) => s.name.trim()).length} store(s)`}
            </button>
          </div>
        )}
      </Card>
      <p className="small" style={{ textAlign: 'center', marginTop: 14 }}>
        Already have an account?{' '}
        <button className="btn text" style={{ minHeight: 0, padding: 0 }} onClick={() => navigate('/', { replace: true })}>Sign in</button>
      </p>
    </AuthFrame>
  );
}
