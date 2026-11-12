import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Fingerprint, KeyRound, LockKeyhole } from 'lucide-react';

import { canUsePlatformBiometrics } from '../lib/appLock';
import { useAuth } from '../lib/auth';
import { displayName } from '../lib/models';
import { Card, Spinner, TopBar } from '../ui/common';
import { useConfirm, useOverlay } from '../ui/overlay';
import { AuthFrame } from './LoginScreen';

export function AppUnlockScreen() {
  const { me, unlockWithPin, unlockWithBiometrics, biometricEnabled, logout } = useAuth();
  const overlay = useOverlay();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);

  const submitPin = async (event: FormEvent) => {
    event.preventDefault();
    if (!/^\d{6}$/.test(pin)) return overlay.error('Enter your six-digit app PIN.');
    setBusy(true);
    try {
      if (!(await unlockWithPin(pin))) {
        overlay.error('That PIN is incorrect. After five failed attempts, sign in with your account password.');
      }
    } catch (error) {
      overlay.error(error);
    } finally {
      setBusy(false);
      setPin('');
    }
  };

  const biometric = async () => {
    setBusy(true);
    try {
      if (!(await unlockWithBiometrics())) overlay.error('Biometric verification was not completed. Use your PIN instead.');
    } catch (error) {
      overlay.error(error);
    } finally {
      setBusy(false);
    }
  };

  const usePassword = async () => {
    await logout();
  };

  return (
    <AuthFrame title="Unlock StockFlow" subtitle={me ? displayName(me) : 'Your account is protected on this device.'}>
      <Card style={{ padding: 20 }}>
        <form className="stack" onSubmit={submitPin}>
          <div className="input-wrap">
            <LockKeyhole size={20} />
            <input
              className="input"
              type="password"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              placeholder="Six-digit app PIN"
              value={pin}
              onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 6))}
            />
          </div>
          <button className="btn block" type="submit" disabled={busy}>
            {busy ? <Spinner /> : 'Unlock with PIN'}
          </button>
        </form>
        {biometricEnabled && (
          <button className="btn tonal block" style={{ marginTop: 12 }} onClick={biometric} disabled={busy}>
            <Fingerprint size={19} /> Unlock with biometrics
          </button>
        )}
        <button className="btn text block" style={{ marginTop: 8 }} onClick={usePassword} disabled={busy}>
          Forgot PIN? Sign in with password
        </button>
      </Card>
    </AuthFrame>
  );
}

export function AppUnlockSetupScreen() {
  const { appUnlockEnabled, biometricEnabled, configureAppUnlock, disableAppUnlock } = useAuth();
  const overlay = useOverlay();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [useBiometrics, setUseBiometrics] = useState(biometricEnabled);
  const [biometricsAvailable, setBiometricsAvailable] = useState(false);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    canUsePlatformBiometrics()
      .then((available) => {
        if (active) {
          setBiometricsAvailable(available);
          if (!available) setUseBiometrics(false);
        }
      })
      .catch(() => {
        if (active) {
          setBiometricsAvailable(false);
          setUseBiometrics(false);
          overlay.error('Could not check biometric support. You can still unlock with the PIN.');
        }
      })
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, [overlay]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (pin && !/^\d{6}$/.test(pin)) return overlay.error('Choose a six-digit PIN.');
    if (pin && pin !== confirmPin) return overlay.error("The PIN entries don't match.");
    if (!appUnlockEnabled && !pin) return overlay.error('Create a six-digit PIN to enable app unlock.');
    setBusy(true);
    try {
      await configureAppUnlock(pin || null, useBiometrics);
      overlay.success('App-unlock settings saved on this device.');
      navigate('/more', { replace: true });
    } catch (error) {
      overlay.error(error);
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (!(await confirm({
      title: 'Turn off app unlock?',
      message: 'StockFlow will no longer ask for a PIN or biometrics when reopened.',
      confirm: 'Turn off',
      danger: true,
    }))) return;
    disableAppUnlock();
    overlay.success('App unlock turned off.');
    navigate('/more', { replace: true });
  };

  return (
    <main className="page">
      <TopBar title="App unlock" />
      <Card style={{ padding: 20 }}>
        <form className="stack" onSubmit={save}>
          <div className="heavy" style={{ fontSize: 21 }}>{appUnlockEnabled ? 'Update your app unlock' : 'Set up app unlock'}</div>
          <p className="muted" style={{ margin: 0 }}>
            Protect this signed-in account on this device with a six-digit PIN and optional fingerprint or device biometrics.
          </p>
          <label className="col gap-s">
            <span className="bold">{appUnlockEnabled ? 'New six-digit PIN (leave blank to keep current)' : 'Create six-digit PIN'}</span>
            <input
              className="input"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              maxLength={6}
              placeholder="6 digits"
              value={pin}
              onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 6))}
            />
          </label>
          <label className="col gap-s">
            <span className="bold">{appUnlockEnabled ? 'Confirm new PIN' : 'Confirm PIN'}</span>
            <input
              className="input"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              maxLength={6}
              placeholder="Enter the PIN again"
              value={confirmPin}
              onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, '').slice(0, 6))}
            />
          </label>
          <label className="tile" style={{ cursor: biometricsAvailable ? 'pointer' : 'default', padding: '10px 0' }}>
            <Fingerprint size={22} />
            <span className="col grow">
              <span className="bold">Use device biometrics</span>
              <span className="small muted">
                {checking
                  ? 'Checking device support…'
                  : biometricsAvailable
                    ? 'Fingerprint, face recognition, or the device authenticator'
                    : 'Unavailable in this browser or device; the PIN still works'}
              </span>
            </span>
            <input
              type="checkbox"
              checked={useBiometrics && biometricsAvailable}
              disabled={checking || !biometricsAvailable}
              onChange={(event) => setUseBiometrics(event.target.checked)}
            />
          </label>
          <button className="btn block" type="submit" disabled={busy || checking}>
            {busy ? <Spinner /> : <><KeyRound size={18} /> Save app unlock</>}
          </button>
          {appUnlockEnabled && (
            <button className="btn text block" type="button" onClick={disable} disabled={busy}>
              Turn off app unlock
            </button>
          )}
        </form>
      </Card>
      <p className="small muted" style={{ padding: '0 4px' }}>
        This protects an existing signed-in session in this browser. You still need your account password on a new device or to recover access.
      </p>
    </main>
  );
}
