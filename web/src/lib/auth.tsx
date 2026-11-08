import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { api, setSignedOutHandler, tokens } from './api';
import type { Me } from './models';

type Status = 'unknown' | 'signedOut' | 'signedIn';

interface Auth {
  status: Status;
  me: Me | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  refreshMe: () => Promise<void>;
}

const AuthContext = createContext<Auth | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<Status>('unknown');
  const [me, setMe] = useState<Me | null>(null);

  const logout = useCallback(() => {
    tokens.clear();
    qc.clear();
    setMe(null);
    setStatus('signedOut');
  }, [qc]);

  const refreshMe = useCallback(async () => {
    const data = await api.get<Me>('/auth/me/');
    setMe(data);
    setStatus('signedIn');
  }, []);

  useEffect(() => {
    setSignedOutHandler(logout);
    if (!tokens.access()) {
      setStatus('signedOut');
      return;
    }
    refreshMe().catch(() => setStatus('signedOut'));
  }, [logout, refreshMe]);

  const login = useCallback(
    async (username: string, password: string) => {
      const data = await api.post<{ access: string; refresh: string }>('/auth/token/', {
        username: username.trim(),
        password,
      });
      tokens.set(data.access, data.refresh);
      await refreshMe();
    },
    [refreshMe],
  );

  const value = useMemo(() => ({ status, me, login, logout, refreshMe }), [status, me, login, logout, refreshMe]);
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
