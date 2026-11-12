import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { api, setSignedOutHandler, tokens } from './api';
import {
  authenticatePlatformBiometric,
  clearAppUnlock,
  createAppUnlockSettings,
  readAppUnlock,
  registerPlatformBiometric,
  saveAppUnlock,
  verifyAppPin,
  type AppUnlockSettings,
} from './appLock';
import type { Me } from './models';

type Status = 'unknown' | 'signedOut' | 'signedIn' | 'locked';

interface Auth {
  status: Status;
  me: Me | null;
  appUnlockEnabled: boolean;
  biometricEnabled: boolean;
  login: (username: string, password: string) => Promise<void>;
  /** Use tokens the server just issued (after sign-up or a password reset). */
  signInWith: (access: string, refresh: string) => Promise<void>;
  logout: () => void;
  refreshMe: () => Promise<void>;
  configureAppUnlock: (pin: string | null, enableBiometrics: boolean) => Promise<void>;
  unlockWithPin: (pin: string) => Promise<boolean>;
  unlockWithBiometrics: () => Promise<boolean>;
  lockApp: () => void;
  disableAppUnlock: () => void;
}

const AuthContext = createContext<Auth | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<Status>('unknown');
  const [me, setMe] = useState<Me | null>(null);
  const [unlockSettings, setUnlockSettings] = useState<AppUnlockSettings | null>(null);
  const authenticating = useRef(false);

  const logout = useCallback(() => {
    tokens.clear();
    qc.clear();
    setMe(null);
    setStatus('signedOut');
    authenticating.current = false;
  }, [qc]);

  const loadMe = useCallback(async (lockOnRestore: boolean) => {
    const data = await api.get<Me>('/auth/me/');
    setMe(data);
    let savedUnlock = readAppUnlock(data.id);
    if (!lockOnRestore && savedUnlock?.failedAttempts) {
      savedUnlock = { ...savedUnlock, failedAttempts: 0 };
      saveAppUnlock(data.id, savedUnlock);
    }
    setUnlockSettings(savedUnlock);
    setStatus(lockOnRestore && savedUnlock ? 'locked' : 'signedIn');
  }, []);

  const refreshMe = useCallback(() => loadMe(false), [loadMe]);

  useEffect(() => {
    setSignedOutHandler(logout);
    if (!tokens.access()) {
      setStatus('signedOut');
      return;
    }
    loadMe(true).catch(() => setStatus('signedOut'));
  }, [logout, loadMe]);

  const signInWith = useCallback(
    async (access: string, refresh: string) => {
      tokens.set(access, refresh);
      await loadMe(false);
    },
    [loadMe],
  );

  const login = useCallback(
    async (username: string, password: string) => {
      const data = await api.post<{ access: string; refresh: string }>('/auth/token/', {
        username: username.trim(),
        password,
      });
      await signInWith(data.access, data.refresh);
    },
    [signInWith],
  );

  const configureAppUnlock = useCallback(async (pin: string | null, enableBiometrics: boolean) => {
    if (!me) throw new Error('Sign in before setting up app unlock.');
    const previous = readAppUnlock(me.id);
    if (pin !== null && !/^\d{6}$/.test(pin)) throw new Error('The app PIN must contain exactly six digits.');
    if (pin === null && !previous) throw new Error('Create a six-digit PIN to enable app unlock.');

    authenticating.current = true;
    try {
      let biometricCredential = enableBiometrics ? previous?.biometricCredential ?? null : null;
      if (enableBiometrics && !biometricCredential) {
        biometricCredential = await registerPlatformBiometric(me.id, me.username);
      }
      const settings = pin === null
        ? { ...previous!, biometricCredential, failedAttempts: 0 }
        : await createAppUnlockSettings(pin, biometricCredential);
      saveAppUnlock(me.id, settings);
      setUnlockSettings(settings);
    } finally {
      authenticating.current = false;
    }
  }, [me]);

  const disableAppUnlock = useCallback(() => {
    if (!me) return;
    clearAppUnlock(me.id);
    setUnlockSettings(null);
  }, [me]);

  const unlockWithPin = useCallback(async (pin: string) => {
    if (!me || !unlockSettings || status !== 'locked') return false;
    const accepted = await verifyAppPin(pin, unlockSettings);
    if (accepted) {
      const updated = { ...unlockSettings, failedAttempts: 0 };
      saveAppUnlock(me.id, updated);
      setUnlockSettings(updated);
      setStatus('signedIn');
      return true;
    }
    const failures = unlockSettings.failedAttempts + 1;
    if (failures >= 5) {
      logout();
    } else {
      const updated = { ...unlockSettings, failedAttempts: failures };
      saveAppUnlock(me.id, updated);
      setUnlockSettings(updated);
    }
    return false;
  }, [logout, me, status, unlockSettings]);

  const unlockWithBiometrics = useCallback(async () => {
    if (!me || !unlockSettings?.biometricCredential || status !== 'locked') return false;
    authenticating.current = true;
    try {
      const accepted = await authenticatePlatformBiometric(unlockSettings.biometricCredential);
      if (accepted) {
        const updated = { ...unlockSettings, failedAttempts: 0 };
        saveAppUnlock(me.id, updated);
        setUnlockSettings(updated);
        setStatus('signedIn');
        return true;
      }
      return false;
    } finally {
      authenticating.current = false;
    }
  }, [me, status, unlockSettings]);

  const lockApp = useCallback(() => {
    if (!authenticating.current && status === 'signedIn' && unlockSettings) setStatus('locked');
  }, [status, unlockSettings]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') lockApp();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [lockApp]);

  const value = useMemo(() => ({
    status,
    me,
    appUnlockEnabled: unlockSettings !== null,
    biometricEnabled: Boolean(unlockSettings?.biometricCredential),
    login,
    signInWith,
    logout,
    refreshMe,
    configureAppUnlock,
    unlockWithPin,
    unlockWithBiometrics,
    lockApp,
    disableAppUnlock,
  }), [
    status, me, unlockSettings, login, signInWith, logout, refreshMe, configureAppUnlock, unlockWithPin,
    unlockWithBiometrics, lockApp, disableAppUnlock,
  ]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}

/** The signed-in user (only use inside signed-in screens). */
export function useMe(): Me {
  return useAuth().me!;
}
