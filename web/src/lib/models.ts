import { toD } from './format';

// Field names match the Django API exactly; small helpers below add what the screens need.

export type Json = Record<string, any>;

export interface Business {
  id: number;
  name: string;
  phone: string;
  email: string;
  address: string;
  kra_pin: string;
}

export interface Me {
  id: number;
  username: string;
  first_name: string;
  last_name: string;
  full_name: string;
  email: string;
  role: 'admin' | 'manager' | 'staff' | string;
  phone: string | null;
  is_admin: boolean;
  locations: number[];
  business: Business | null;
}

export const isManager = (me: Me) => me.role === 'manager' || me.is_admin;
export const roleLabel = (me: { role: string; is_admin?: boolean }) =>
  me.is_admin || me.role === 'admin' ? 'Owner / admin' : me.role === 'manager' ? 'Stock manager' : 'Shop staff';
export const canManage = (me: Me, locationId: number) =>
  me.is_admin || (me.role === 'manager' && me.locations.includes(locationId));
export const works = (me: Me, locationId: number) => me.is_admin || me.locations.includes(locationId);
export const displayName = (me: { full_name?: string; username: string }) => me.full_name || me.username;

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
  is_active?: boolean;
  address?: string;
  phone?: string;
  latitude?: string | number | null;
  longitude?: string | number | null;
  summary?: LocationSummary | null;
  mine?: boolean;
}

export const isGodown = (l: Location) => l.kind === 'godown';
export const kindLabel = (l: Location) => (isGodown(l) ? 'Godown' : l.is_main ? 'Main shop' : 'Shop');
export const hasPoint = (l?: { latitude?: unknown; longitude?: unknown } | null) =>
  l != null && l.latitude != null && l.longitude != null && l.latitude !== '' && l.longitude !== '';

export interface Variant {
  id: number;
  product: number;
  product_name: string;
  product_code?: string;
  sku: string;
  size: string;
  colour: string;
  options: string;
  label: string;
  cost_price: string | number;
  selling_price: string | number;
  unit: string;
  allow_fractions: boolean;
  is_active?: boolean;
}

export interface Product {
  id: number;
  name: string;
  code: string;
  category: number | null;
  category_name: string;
  brand: string;
  unit: string;
  allow_fractions: boolean;
  reorder_level: string | number;
  suppliers: number[];
  supplier_names: string[];
  is_active: boolean;
  variants: Variant[];
  total_stock: string | number | null;
}

export interface Category {
  id: number;
  name: string;
  product_count?: number;
}

export interface StockLevel {
  id: number;
  location: number;
  location_code: string;
  location_name?: string;
  variant: Variant;
  quantity: string | number;
  reorder_at: string | number;
  is_low: boolean;
  state?: 'ok' | 'low' | 'out';
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
  email?: string;
  contact_person: string;
  total_supplied: string | number;
  deliveries: number;
  product_count?: number;
  owed?: string | number;
}

export interface Customer {
  id: number;
  name: string;
  phone: string;
  credit_limit: string | number;
  notes: string;
  owed: string | number;
  overdue: string | number;
  credit_sales?: number;
}

export interface Payment {
  id: number;
  amount: string | number;
  method: string;
  method_label: string;
  reference: string;
  received_by_name: string | null;
  created_at: string;
}

export interface Sale extends Json {
  id: number;
  code: string;
  location: number;
  location_name: string;
  customer: number | null;
  customer_name: string;
  customer_phone: string;
  payment_method: string;
  payment_reference: string;
  total: string | number;
  amount_paid: string | number;
  balance: string | number;
  payment_status: 'paid' | 'partial' | 'unpaid';
  due_date: string | null;
  status: string;
  lines: DocLine[];
  payments: Payment[];
  created_at: string;
}

export interface TeamMember {
  id: number;
  username: string;
  first_name: string;
  last_name: string;
  full_name: string;
  email: string;
  phone: string | null;
  role: string;
  role_label: string;
  locations: number[];
  is_active: boolean;
  last_login: string | null;
  sms_alerts: boolean;
  whatsapp_alerts: boolean;
}

export interface DocLine {
  id: number;
  variant: number;
  variant_label: string;
  sku: string;
  unit: string;
  quantity: string | number;
  unit_price?: string | number;
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

export interface Point {
  lat: string | number;
  lng: string | number;
  name?: string;
  at?: string;
}

export interface Tracking {
  active: boolean;
  source: Point | null;
  destination: Point | null;
  points: Point[];
  last: (Point & { seconds_ago: number; speed: number | null; accuracy: number | null }) | null;
  distance_left_m: number | null;
  eta_minutes: number | null;
  arrived_near_at: string | null;
  driver_link: string | null;
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

export interface AppConfig {
  currency: string;
  google_maps_key: string;
  mpesa_prompt: boolean;
  mpesa_simulated: boolean;
  sms_live?: boolean;
  vehicles: { value: string; label: string }[];
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

export const removeReasons = ['customer_pickup', 'damaged', 'return_supplier', 'internal_use', 'lost', 'expired', 'correction', 'other'];
export const addReasons = ['found', 'customer_return', 'correction', 'other'];

export const vehicles: { value: string; label: string; motor: boolean }[] = [
  { value: 'tuktuk', label: 'Tuk-tuk', motor: true },
  { value: 'motorbike', label: 'Motorbike', motor: true },
  { value: 'pickup', label: 'Pick-up', motor: true },
  { value: 'lorry', label: 'Lorry', motor: true },
  { value: 'handcart', label: 'Handcart', motor: false },
  { value: 'on_foot', label: 'On foot', motor: false },
  { value: 'other', label: 'Other', motor: false },
];
export const isMotor = (v: string) => vehicles.some((x) => x.value === v && x.motor);
