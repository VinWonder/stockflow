export function toD(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

const whole = new Intl.NumberFormat('en-KE', { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat('en-KE', { notation: 'compact', maximumFractionDigits: 1 });
const qtyFmt = new Intl.NumberFormat('en-KE', { maximumFractionDigits: 3 });

export const money = (v: unknown) => `KES ${whole.format(toD(v))}`;
export const moneyShort = (v: unknown) => (Math.abs(toD(v)) >= 100000 ? `KES ${compact.format(toD(v))}` : money(v));
export const qty = (v: unknown) => qtyFmt.format(toD(v));

/** Quantity as the API expects it: a string, no float noise. */
export const qtyOut = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(3));

export function parseDate(v: unknown): Date | null {
  if (v == null || v === '') return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

const dayFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
const shortFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

export function dateTime(v: unknown) {
  const d = parseDate(v);
  return d ? `${dayFmt.format(d)}, ${timeFmt.format(d)}` : '';
}

export function dateOnly(v: unknown) {
  const d = parseDate(v);
  return d ? dayFmt.format(d) : '';
}

export function ago(v: unknown) {
  const d = parseDate(v);
  if (!d) return '';
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} d ago`;
  return shortFmt.format(d);
}

/** yyyy-MM-dd in local time. */
export function apiDate(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Random v4 UUID that also works on plain-HTTP pages (crypto.randomUUID needs HTTPS). */
export function uuid(): string {
  if (window.isSecureContext && crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export async function copyText(text: string) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}

/** Allow only digits (and one dot when decimals are allowed) while typing a number. */
export function numericInput(v: string, decimals = true) {
  const cleaned = v.replace(decimals ? /[^0-9.]/g : /[^0-9]/g, '');
  if (!decimals) return cleaned;
  const [head, ...rest] = cleaned.split('.');
  return rest.length ? `${head}.${rest.join('')}` : head;
}

/** Link that opens the phone's own SMS app with the number and message filled in (iPhone uses "&body=", Android "?body="). */
export function smsHref(phone: string, body: string) {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const to = phone ? `+${phone.replace(/[^0-9]/g, '')}` : '';
  return `sms:${to}${ios ? '&' : '?'}body=${encodeURIComponent(body)}`;
}
