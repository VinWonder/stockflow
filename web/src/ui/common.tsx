import type { CSSProperties, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, CloudOff, Store, Warehouse, type LucideIcon } from 'lucide-react';

import { alpha, colors, darken, statusColor } from '../lib/theme';

export function Card({ children, onClick, style, className = '' }: { children: ReactNode; onClick?: () => void; style?: CSSProperties; className?: string }) {
  if (onClick) {
    return (
      <button type="button" className={`card ${className}`} style={style} onClick={onClick}>
        {children}
      </button>
    );
  }
  return (
    <div className={`card ${className}`} style={style}>
      {children}
    </div>
  );
}

export function SectionTitle({ children, action, onAction }: { children: ReactNode; action?: string; onAction?: () => void }) {
  return (
    <div className="section-title">
      <h2>{children}</h2>
      {action && (
        <button className="btn text" onClick={onAction}>
          {action}
        </button>
      )}
    </div>
  );
}

export function StatusChip({ status, label }: { status: string; label: string }) {
  const c = statusColor(status);
  return (
    <span className="chip" style={{ background: alpha(c, 0.12), color: c }}>
      <span className="dot" style={{ background: c }} />
      {label}
    </span>
  );
}

export function Pill({ text, color = colors.info, icon: Icon }: { text: string; color?: string; icon?: LucideIcon }) {
  return (
    <span className="pill" style={{ background: alpha(color, 0.12), color }}>
      {Icon && <Icon size={13} />}
      {text}
    </span>
  );
}

export function IconBox({ icon: Icon, color, size = 20, box = 40 }: { icon: LucideIcon; color: string; size?: number; box?: number }) {
  return (
    <span className="icon-box" style={{ background: alpha(color, 0.12), color, width: box, height: box }}>
      <Icon size={size} />
    </span>
  );
}

export function EmptyState({ icon: Icon, title, message, action, onAction }: { icon: LucideIcon; title: string; message?: string; action?: string; onAction?: () => void }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon size={36} />
      </div>
      <h3>{title}</h3>
      {message && <p>{message}</p>}
      {action && (
        <button className="btn tonal small" style={{ marginTop: 16 }} onClick={onAction}>
          {action}
        </button>
      )}
    </div>
  );
}

export function ErrorView({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <EmptyState
      icon={CloudOff}
      title="Couldn't load this"
      message={error instanceof Error ? error.message : String(error)}
      action={onRetry ? 'Try again' : undefined}
      onAction={onRetry}
    />
  );
}

export function LoadingList({ count = 6 }: { count?: number }) {
  return (
    <div className="list" style={{ paddingTop: 8 }} aria-busy="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton" />
      ))}
    </div>
  );
}

export function Progress() {
  return <div className="progress" />;
}

export function Spinner() {
  return <span className="spin" aria-label="Loading" />;
}

export function KpiTile({ label, value, icon, color, onClick }: { label: string; value: string; icon: LucideIcon; color: string; onClick?: () => void }) {
  return (
    <Card onClick={onClick} style={{ padding: 14 }}>
      <IconBox icon={icon} color={color} />
      <div className="kpi-value" title={value}>
        {value}
      </div>
      <div className="muted ellipsis" style={{ fontSize: 12.5, marginTop: 2 }}>
        {label}
      </div>
    </Card>
  );
}

export function StoreAvatar({ color, godown, size = 44 }: { color: string; godown: boolean; size?: number }) {
  const Icon = godown ? Warehouse : Store;
  return (
    <span
      className="icon-box"
      style={{ width: size, height: size, borderRadius: size * 0.32, background: `linear-gradient(135deg, ${color}, ${darken(color, 0.25)})`, color: '#fff' }}
    >
      <Icon size={size * 0.5} />
    </span>
  );
}

/** Page header. `back` shows an arrow that returns to the previous screen (or home when opened directly). */
export function TopBar({ title, back, children }: { title: ReactNode; back?: boolean; children?: ReactNode }) {
  const goBack = useBack();
  return (
    <header className="topbar">
      {back && (
        <button className="icon-btn" onClick={goBack} aria-label="Back">
          <ArrowLeft size={22} />
        </button>
      )}
      <h1>{title}</h1>
      {children}
    </header>
  );
}

export function useBack() {
  const navigate = useNavigate();
  return () => ((window.history.state?.idx ?? 0) > 0 ? navigate(-1) : navigate('/', { replace: true }));
}

/** Bottom action bar used by forms and detail screens. */
export function BottomActions({ children }: { children: ReactNode }) {
  return (
    <div className="bottom-actions">
      <div>{children}</div>
    </div>
  );
}

export function Field({ label, children, style }: { label: string; children: ReactNode; style?: CSSProperties }) {
  return (
    <label className="field" style={style}>
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; icon?: LucideIcon }[] }) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map(({ value: v, label, icon: Icon }) => (
        <button key={v} type="button" role="radio" aria-checked={v === value} className={v === value ? 'on' : ''} onClick={() => onChange(v)}>
          {Icon && <Icon size={18} />}
          {label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, title, subtitle }: { checked: boolean; onChange: (v: boolean) => void; title: string; subtitle?: string }) {
  return (
    <label className="switch-row">
      <div className="col grow">
        <span className="bold">{title}</span>
        {subtitle && <span className="small muted">{subtitle}</span>}
      </div>
      <input type="checkbox" hidden checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className={`switch${checked ? ' on' : ''}`} aria-hidden="true" />
    </label>
  );
}
