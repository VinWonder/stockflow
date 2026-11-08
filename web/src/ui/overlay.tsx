import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertCircle } from 'lucide-react';

import { colors } from '../lib/theme';

type Close = (value?: unknown) => void;
type Render = (close: Close) => ReactNode;

interface Entry {
  id: number;
  render: Render;
  resolve: (v: unknown) => void;
}

interface Toast {
  id: number;
  kind: 'success' | 'error';
  message: string;
}

interface Overlay {
  /** Show a dialog, sheet or full-screen view; resolves with what it was closed with. */
  open: <T>(render: (close: (value?: T) => void) => ReactNode) => Promise<T | undefined>;
  success: (message: string) => void;
  error: (error: unknown) => void;
}

const OverlayContext = createContext<Overlay | null>(null);

let nextId = 1;

/**
 * Hosts dialogs, sheets and toasts. Each open overlay adds a browser history entry,
 * so the phone's back button closes the sheet instead of leaving the screen.
 */
export function OverlayProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [toast, setToast] = useState<Toast | null>(null);
  const stack = useRef<Entry[]>([]);
  const pending = useRef<(() => void)[]>([]);
  const toastTimer = useRef<number>();

  const close = useCallback((entry: Entry, value: unknown, fromBackButton: boolean) => {
    if (!stack.current.includes(entry)) return;
    stack.current = stack.current.filter((e) => e !== entry);
    setEntries(stack.current);
    if (fromBackButton) {
      entry.resolve(value);
    } else {
      // Resolve once the history entry is gone, so a navigate() straight after doesn't race history.back().
      pending.current.push(() => entry.resolve(value));
      window.history.back();
    }
  }, []);

  useEffect(() => {
    const onPop = () => {
      const next = pending.current.shift();
      if (next) return next();
      const top = stack.current[stack.current.length - 1];
      if (top) close(top, undefined, true);
    };
    const onKey = (e: KeyboardEvent) => {
      const top = stack.current[stack.current.length - 1];
      if (e.key === 'Escape' && top) close(top, undefined, false);
    };
    window.addEventListener('popstate', onPop);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('keydown', onKey);
    };
  }, [close]);

  const open = useCallback(<T,>(render: (close: (value?: T) => void) => ReactNode) => {
    return new Promise<T | undefined>((resolve) => {
      const entry: Entry = { id: nextId++, render: render as Render, resolve: resolve as (v: unknown) => void };
      window.history.pushState({ ...window.history.state, overlay: entry.id }, '');
      stack.current = [...stack.current, entry];
      setEntries(stack.current);
    });
  }, []);

  const show = useCallback((kind: Toast['kind'], message: string) => {
    window.clearTimeout(toastTimer.current);
    setToast({ id: nextId++, kind, message });
    navigator.vibrate?.(kind === 'error' ? 60 : 15);
    toastTimer.current = window.setTimeout(() => setToast(null), kind === 'error' ? 5000 : 3000);
  }, []);

  const value = useMemo<Overlay>(
    () => ({
      open,
      success: (m) => show('success', m),
      error: (e) => show('error', e instanceof Error ? e.message : String(e)),
    }),
    [open, show],
  );

  return (
    <OverlayContext.Provider value={value}>
      {children}
      {entries.map((e) => (
        <div key={e.id}>{e.render((v) => close(e, v, false))}</div>
      ))}
      {toast && (
        <div className="toasts" key={toast.id}>
          <div
            className="toast"
            role="status"
            style={{ background: toast.kind === 'success' ? colors.success : colors.danger }}
            onClick={() => setToast(null)}
          >
            {toast.kind === 'success' ? <CheckCircle2 size={20} /> : <AlertCircle size={20} />}
            <span>{toast.message}</span>
          </div>
        </div>
      )}
    </OverlayContext.Provider>
  );
}

export function useOverlay() {
  const ctx = useContext(OverlayContext);
  if (!ctx) throw new Error('useOverlay outside OverlayProvider');
  return ctx;
}

/** Bottom sheet frame (centred card on wide screens). Click outside to close. */
export function Sheet({ onClose, title, tall, children }: { onClose: () => void; title?: string; tall?: boolean; children: ReactNode }) {
  return (
    <div className="scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`sheet${tall ? ' tall' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="handle" />
        {title && <div className="sheet-title">{title}</div>}
        {children}
      </div>
    </div>
  );
}

export function Dialog({ onClose, title, children, actions }: { onClose: () => void; title: string; children?: ReactNode; actions: ReactNode }) {
  return (
    <div className="scrim center" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        {children}
        <div className="actions">{actions}</div>
      </div>
    </div>
  );
}

export function useConfirm() {
  const { open } = useOverlay();
  return (opts: { title: string; message: string; confirm?: string; danger?: boolean }) =>
    open<boolean>((close) => (
      <Dialog
        onClose={() => close(false)}
        title={opts.title}
        actions={
          <>
            <button className="btn text" onClick={() => close(false)}>Cancel</button>
            <button className={`btn small${opts.danger ? ' danger' : ''}`} onClick={() => close(true)} autoFocus>
              {opts.confirm ?? 'Yes'}
            </button>
          </>
        }
      >
        <p style={{ margin: 0 }}>{opts.message}</p>
      </Dialog>
    )).then((v) => v ?? false);
}

function AskTextDialog({ title, hint, confirm, close }: { title: string; hint: string; confirm: string; close: (v?: string) => void }) {
  const [text, setText] = useState('');
  return (
    <Dialog
      onClose={() => close()}
      title={title}
      actions={
        <>
          <button className="btn text" onClick={() => close()}>Cancel</button>
          <button className="btn small" onClick={() => close(text.trim())}>{confirm}</button>
        </>
      }
    >
      <textarea className="input" rows={2} autoFocus placeholder={hint} value={text} onChange={(e) => setText(e.target.value)} />
    </Dialog>
  );
}

export function useAskText() {
  const { open } = useOverlay();
  return (opts: { title: string; hint?: string; confirm?: string }) =>
    open<string>((close) => <AskTextDialog title={opts.title} hint={opts.hint ?? ''} confirm={opts.confirm ?? 'OK'} close={close} />);
}
