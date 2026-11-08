import { useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from './api';
import type { AppNotification, Doc, Json, Location, Movement, StockLevel, Supplier } from './models';

export const useDashboard = () => useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<Json>('/dashboard/') });

/** Stores this user works in (with stock summaries). */
export const useLocations = () => useQuery({ queryKey: ['locations'], queryFn: () => api.list<Location>('/locations/') });

/** Every active store (for choosing where to send a transfer). */
export const useDirectory = () =>
  useQuery({ queryKey: ['directory'], queryFn: () => api.list<Location>('/locations/directory/') });

export const useStock = (location: number, search: string, low: boolean) =>
  useQuery({
    queryKey: ['stock', location, search, low],
    queryFn: () => api.list<StockLevel>('/stock/', { location, search, low: low ? 1 : undefined }),
    placeholderData: (prev) => prev,
  });

export const useMovements = (location: number, variant: number) =>
  useQuery({
    queryKey: ['movements', location, variant],
    queryFn: () => api.list<Movement>('/movements/', { location, variant, page_size: 100 }),
  });

export const useSuppliers = () =>
  useQuery({ queryKey: ['suppliers'], queryFn: () => api.list<Supplier>('/suppliers/', { is_active: true }) });

export const useTransfers = (status: string) =>
  useQuery({ queryKey: ['transfers', status], queryFn: () => api.list<Doc>('/transfers/', { status, page_size: 50 }) });

export const useTransfer = (id: number) =>
  useQuery({ queryKey: ['transfer', id], queryFn: () => api.get<Doc>(`/transfers/${id}/`) });

export const useRequests = (status: string) =>
  useQuery({ queryKey: ['requests', status], queryFn: () => api.list<Doc>('/requests/', { status, page_size: 50 }) });

export const useRequest = (id: number) =>
  useQuery({ queryKey: ['request', id], queryFn: () => api.get<Doc>(`/requests/${id}/`) });

export const useNotifications = () =>
  useQuery({ queryKey: ['notifications'], queryFn: () => api.list<AppNotification>('/notifications/', { page_size: 60 }) });

export const useMessagingConfig = () =>
  useQuery({ queryKey: ['messaging-config'], queryFn: () => api.get<Json>('/messaging/config/') });

/** Unread badge, refreshed every 30 seconds while the app is open. */
export const useUnread = () =>
  useQuery({
    queryKey: ['unread'],
    queryFn: async () => {
      const d = await api.get<Json>('/notifications/unread/');
      return { unread: (d.count ?? 0) as number, action: (d.action_needed ?? 0) as number };
    },
    refetchInterval: 30000,
  });

/** Call after any change so every screen shows fresh numbers. */
export function useRefreshEverything() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries();
}
