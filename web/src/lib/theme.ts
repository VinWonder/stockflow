export const colors = {
  steel: '#1F3A5F',
  amber: '#F59E0B',
  success: '#16A34A',
  danger: '#DC2626',
  info: '#2563EB',
  violet: '#7C3AED',
  slate: '#64748B',
};

/** Colour for every document status in the app. */
export function statusColor(status: string) {
  switch (status) {
    case 'requested':
    case 'pending':
    case 'open':
      return colors.amber;
    case 'approved':
    case 'completed':
    case 'received':
    case 'posted':
      return colors.success;
    case 'confirmed':
    case 'submitted':
      return colors.info;
    case 'in_transit':
      return colors.violet;
    case 'rejected':
    case 'void':
      return colors.danger;
    default:
      return colors.slate;
  }
}

export const fromHex = (hex?: string | null, fallback = colors.info) =>
  hex && /^#[0-9a-f]{6}$/i.test(hex) ? hex : fallback;

/** Colour with transparency, e.g. alpha('#16A34A', 0.12). */
export function alpha(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Mix a colour towards black, for card gradients. */
export function darken(hex: string, amount: number) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.round(c * (1 - amount));
  return `rgb(${f((n >> 16) & 255)}, ${f((n >> 8) & 255)}, ${f(n & 255)})`;
}

export type ThemeMode = 'system' | 'light' | 'dark';

export function getThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem('theme');
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyThemeMode(mode: ThemeMode) {
  try {
    localStorage.setItem('theme', mode);
  } catch {
    // ignore
  }
  if (mode === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = mode;
}
