/** An error the user can understand, shown in a toast. */
export class ApiError extends Error {
  constructor(message: string, public status?: number, public code?: string) {
    super(message);
  }
}

const KEYS = { base: 'base_url', access: 'access', refresh: 'refresh' };

function read(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private mode: the session lasts until the tab closes.
  }
}

/** Same address as the app by default (Django serves both). Can point elsewhere from the sign-in screen. */
export const defaultBaseUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api';
export const getBaseUrl = () => read(KEYS.base) || defaultBaseUrl;
export const setBaseUrl = (url: string) => write(KEYS.base, url.replace(/\/+$/, '') || null);

export const tokens = {
  access: () => read(KEYS.access),
  set(access: string, refresh?: string) {
    write(KEYS.access, access);
    if (refresh) write(KEYS.refresh, refresh);
  },
  clear() {
    write(KEYS.access, null);
    write(KEYS.refresh, null);
  },
};

let onSignedOut: () => void = () => {};
export const setSignedOutHandler = (fn: () => void) => {
  onSignedOut = fn;
};

const isAuthCall = (path: string) =>
  /\/auth\/(token|refresh|register|password\/(forgot|verify|reset))\//.test(path) || path.startsWith('/track/');

type Query = Record<string, string | number | boolean | null | undefined>;

function buildUrl(path: string, query?: Query) {
  const base = getBaseUrl();
  const url = new URL(base + path, window.location.origin);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  return url.toString();
}

async function send(method: string, path: string, body?: unknown, query?: Query): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const access = tokens.access();
  if (access && !isAuthCall(path)) headers.Authorization = `Bearer ${access}`;
  try {
    return await fetch(buildUrl(path, query), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'TimeoutError') {
      throw new ApiError('The server is taking too long. Check your connection.');
    }
    throw new ApiError("Can't reach the server. Check Wi-Fi/data and the server address.");
  }
}

// One refresh at a time, shared by every request that hit a 401 together.
let refreshing: Promise<boolean> | null = null;

function refreshTokens(): Promise<boolean> {
  const refresh = read(KEYS.refresh);
  if (!refresh) return Promise.resolve(false);
  refreshing ??= (async () => {
    try {
      const r = await send('POST', '/auth/refresh/', { refresh });
      if (!r.ok) return false;
      const data = await r.json();
      tokens.set(data.access, data.refresh);
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

async function request<T = any>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
  let res = await send(method, path, body, query);
  if (res.status === 401 && !isAuthCall(path)) {
    if (await refreshTokens()) res = await send(method, path, body, query);
    if (res.status === 401) {
      tokens.clear();
      onSignedOut();
    }
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) throw new ApiError(describe(res.status, data), res.status, data?.code);
  return data as T;
}

function flatten(v: unknown): string {
  if (Array.isArray(v)) return v.map(flatten).filter(Boolean).join(' ');
  if (v && typeof v === 'object') return Object.values(v).map(flatten).filter(Boolean).join(' ');
  return v == null ? '' : String(v);
}

const nice = (field: string) => {
  const s = field.replace(/_/g, ' ');
  return s ? s[0].toUpperCase() + s.slice(1) : s;
};

function describe(status: number, data: any): string {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    if (data.detail != null) return String(data.detail);
    const parts = Object.entries(data)
      .filter(([k]) => k !== 'code')
      .map(([k, v]) => (k === 'non_field_errors' || k === 'lines' ? flatten(v) : `${nice(k)}: ${flatten(v)}`));
    if (parts.length) return parts.join('\n');
  }
  if (status === 401) return 'Your session has ended. Sign in again.';
  if (status === 403) return "You don't have permission to do that.";
  if (status === 404) return 'Not found.';
  if (status >= 500) return 'Server error. Try again shortly.';
  return 'Something went wrong. Try again.';
}

export const api = {
  get: <T = any>(path: string, query?: Query) => request<T>('GET', path, undefined, query),
  post: <T = any>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  patch: <T = any>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T = any>(path: string) => request<T>('DELETE', path),

  /** Reads a list endpoint whether or not it is paginated. */
  async list<T>(path: string, query?: Query): Promise<T[]> {
    const data = await request<any>('GET', path, undefined, { page_size: 300, ...query });
    return Array.isArray(data) ? data : (data?.results ?? []);
  },
};
