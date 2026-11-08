import { toD } from './format';

// Field names match the Django API exactly; small helpers below add what the screens need.

export type Json = Record<string, any>;

export interface Me {
  id: number;
  username: string;
  full_name: string;
  role: 'admin' | 'manager' | 'staff' | string;
  phone: string | null;
  is_admin: boolean;
  locations: number[];
}

export const isManager = (me: Me) => me.role === 'manager' || me.is_admin;
export const roleLabel = (me: Me) => (me.is_admin ? 'Admin' : me.role === 'manager' ? 'Stock manager' : 'Shop staff');
export const canManage = (me: Me, locationId: number) =>
  me.is_admin || (me.role === 'manager' && me.locations.includes(locationId));
export const works = (me: Me, locationId: number) => me.is_admin || me.locations.includes(locationId);
export const displayName = (me: Me) => me.full_name || me.username;

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts.slice(0, 2).map((p) => p[0].toUpperCase()).join('') : '?';
}

export interface LocationSummary {
  items: number;
  units: string | number;
  value: string | number;
  low: number;
  out: number;
}

export interface Location {
  id: number;
  code: string;
  name: string;
  kind: 'godown' | 'shop' | string;
  is_main: boolean;
  color: string;
  can_sell: boolean;
  address?: string;
  summary?: LocationSummary | null;
}

export const isGodown = (l: Location) => l.kind === 'godown';
export const kindLabel = (l: Location) => (isGodown(l) ? 'Godown' : l.is_main ? 'Main shop' : 'Shop');

export interface Variant {
  id: number;
  product: number;
  product_name: string;
  sku: string;
  size: string;
  colour: string;
  options: string;
  label: string;
  barcode: string | null;
  cost_price: string | number;
  selling_price: string | number;
  unit: string;
  allow_fractions: boolean;
}

export interface StockLevel {
  id: number;
  location: number;
  location_code: string;
  variant: Variant;
  quantity: string | number;
  reorder_at: string | number;
  is_low: boolean;
  bin_location: string;
  value: string | number;
  updated_at?: string;
}

export interface Movement {
  id: number;
  kind: string;
  kind_label: string;
  reference: string;
  note: string;
  user_name: string;
  variant_label: string;
  location_code: string;
  sku?: string;
  quantity: string | number;
  balance_after: string | number;
  created_at: string;
}

export interface Supplier {
  id: number;
  name: string;
  phone: string;
  contact_person: string;
  total_supplied: string | number;
  deliveries: number;
}

export interface DocLine {
  id: number;
  variant: number;
  variant_label: string;
  sku: string;
  unit: string;
  quantity: string | number;
  received_quantity?: string | number | null;
  confirmed_quantity?: string | number | null;
  shortage?: string | number;
}

/** Shared shape for transfers and requests: code, status, lines and people. */
export interface Doc extends Json {
  id: number;
  code: string;
  status: string;
  status_label: string;
  notes: string;
  created_at: string;
  lines: DocLine[];
  people: Record<string, string | null>;
  rejection_reason?: string;
}

export interface AppNotification {
  id: number;
  kind: string;
  title: string;
  body: string;
  ref_type: string;
  ref_id: number | null;
  needs_action: boolean;
  is_read: boolean;
  created_at: string;
}

/** A line being edited in a form before it is sent to the server. */
export interface LineDraft {
  variant: Variant;
  quantity: number;
  price: number;
  available?: number | null;
}

export const newLine = (variant: Variant, available?: number | null, price?: number): LineDraft => ({
  variant,
  quantity: 1,
  price: price ?? toD(variant.selling_price),
  available,
});

export const reasons: Record<string, string> = {
  customer_pickup: 'Customer pick-up / delivery',
  damaged: 'Damaged',
  expired: 'Expired / spoilt',
  return_supplier: 'Returned to supplier',
  internal_use: 'Used on site / internal',
  lost: 'Lost / stolen',
  found: 'Found during check',
  customer_return: 'Customer return',
  correction: 'Correction',
  other: 'Other',
};
