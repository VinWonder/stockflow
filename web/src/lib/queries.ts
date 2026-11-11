import { useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from './api';
import type {
  AppConfig, AppNotification, Category, Customer, Doc, Json, Location, Movement, Product, Sale, StockLevel, Supplier,
  TeamMember, Tracking,
} from './models';

/** How often "live" screens refresh while open (stock, sales and alerts change from other phones). */
export const LIVE_MS = 10000;

export const useConfig = () =>
  useQuery({ queryKey: ['config'], queryFn: () => api.get<AppConfig>('/config/'), staleTime: 5 * 60000 });

/** Owner's overview; `location` narrows everything to one shop or godown. Refreshes itself. */
export const useDashboard = (location: number | null) =>
  useQuery({
    queryKey: ['dashboard', location],
    queryFn: () => api.get<Json>('/dashboard/', { location }),
    refetchInterval: LIVE_MS * 1.5,
    placeholderData: (prev) => prev,
  });

/** Small live counters for running-low / out-of-stock badges. */
export const useStockAlerts = (location: number | null) =>
  useQuery({
    queryKey: ['stock-alerts', location],
    queryFn: () => api.get<{ low: number; out: number; changed_at: string | null }>('/stock-alerts/', { location }),
    refetchInterval: LIVE_MS,
  });

/** Stores this user works in (with stock summaries). */
export const useLocations = () =>
  useQuery({ queryKey: ['locations'], queryFn: () => api.list<Location>('/locations/'), refetchInterval: LIVE_MS * 3 });

/** Every active store in the business (for choosing where to send a transfer). */
export const useDirectory = () =>
  useQuery({ queryKey: ['directory'], queryFn: () => api.list<Location>('/locations/directory/') });

export const useStock = (location: number, search: string, state: '' | 'alert' | 'low' | 'out') =>
  useQuery({
    queryKey: ['stock', location, search, state],
    queryFn: () => api.list<StockLevel>('/stock/', { location, search, state: state || undefined }),
    placeholderData: (prev) => prev,
    refetchInterval: LIVE_MS,
  });

/** Low / out items across all my stores (or one), live. */
export const useAlertItems = (state: 'low' | 'out' | 'alert', location: number | null) =>
  useQuery({
    queryKey: ['stock', 'alerts-list', state, location],
    queryFn: () => api.list<StockLevel>('/stock/', { state, location, page_size: 500 }),
    refetchInterval: LIVE_MS,
    placeholderData: (prev) => prev,
  });

export const useMovements = (location: number, variant: number) =>
  useQuery({
    queryKey: ['movements', location, variant],
    queryFn: () => api.list<Movement>('/movements/', { location, variant, page_size: 100 }),
  });

export const useSuppliers = () =>
  useQuery({ queryKey: ['suppliers'], queryFn: () => api.list<Supplier>('/suppliers/', { is_active: true }) });

export const useCategories = () => useQuery({ queryKey: ['categories'], queryFn: () => api.list<Category>('/categories/') });

export const useProducts = (search: string) =>
  useQuery({
    queryKey: ['products', search],
    queryFn: () => api.list<Product>('/products/', { search, is_active: true }),
    placeholderData: (prev) => prev,
  });

export const useCustomers = (owing: boolean, search = '') =>
  useQuery({
    queryKey: ['customers', owing, search],
    queryFn: () => api.list<Customer>('/customers/', { owing: owing ? 1 : undefined, search, is_active: true }),
    placeholderData: (prev) => prev,
  });

export const useCustomerStatement = (id: number) =>
  useQuery({ queryKey: ['customer', id], queryFn: () => api.get<{ customer: Customer; sales: Sale[] }>(`/customers/${id}/statement/`) });

export const useTeam = () => useQuery({ queryKey: ['team'], queryFn: () => api.list<TeamMember>('/users/') });

export const useTransfers = (statusIn: string) =>
  useQuery({
    queryKey: ['transfers', statusIn],
    queryFn: () => api.list<Doc>('/transfers/', { status_in: statusIn, page_size: 60 }),
    refetchInterval: LIVE_MS * 2,
  });

export const useTransfer = (id: number) =>
  useQuery({ queryKey: ['transfer', id], queryFn: () => api.get<Doc>(`/transfers/${id}/`), refetchInterval: LIVE_MS * 2 });

export const useTracking = (id: number, enabled: boolean) =>
  useQuery({
    queryKey: ['tracking', id],
    queryFn: () => api.get<Tracking>(`/transfers/${id}/track/`),
    enabled,
    refetchInterval: enabled ? 8000 : false,
  });

export const useRequests = (status: string) =>
  useQuery({ queryKey: ['requests', status], queryFn: () => api.list<Doc>('/requests/', { status_in: status, page_size: 50 }) });

export const useRequest = (id: number) =>
  useQuery({ queryKey: ['request', id], queryFn: () => api.get<Doc>(`/requests/${id}/`) });

export const useNotifications = () =>
  useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.list<AppNotification>('/notifications/', { page_size: 60 }),
    refetchInterval: LIVE_MS * 3,
  });

export const useMessageLog = (enabled: boolean) =>
  useQuery({ queryKey: ['message-log'], queryFn: () => api.get<Json[]>('/messaging/log/'), enabled, refetchInterval: LIVE_MS * 3 });

export const useMessagingConfig = () =>
  useQuery({ queryKey: ['messaging-config'], queryFn: () => api.get<Json>('/messaging/config/') });

/** Unread badge, refreshed every 20 seconds while the app is open. */
export const useUnread = () =>
  useQuery({
    queryKey: ['unread'],
    queryFn: async () => {
      const d = await api.get<Json>('/notifications/unread/');
      return { unread: (d.count ?? 0) as number, action: (d.action_needed ?? 0) as number };
    },
    refetchInterval: 20000,
  });

/** Call after any change so every screen shows fresh numbers. */
export function useRefreshEverything() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries();
}
