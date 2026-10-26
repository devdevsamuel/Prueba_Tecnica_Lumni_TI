import { apiGet, apiPost } from './api';
import type { Booking } from './bookings';

/**
 * Cliente del panel de administración (Fase 3). Los filtros van en la URL del
 * back y en la URL de la página (docs/06 §4: refrescables y compartibles).
 */
export interface AdminListItem {
  readonly id: number;
  readonly customerName: string;
  readonly customerEmail: string;
  readonly roomId: number | null;
  readonly roomName: string | null;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly status: string;
  readonly cancelReason: string | null;
  readonly total: number | null;
  readonly createdAt: string;
}

export interface AdminListResponse {
  readonly items: readonly AdminListItem[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
}

export interface BookingFilters {
  readonly page?: number;
  readonly pageSize?: number;
  readonly status?: string;
  readonly room?: string;
}

export function fetchBookings(filters: BookingFilters, signal?: AbortSignal): Promise<AdminListResponse> {
  const params = new URLSearchParams();
  if (filters.page) params.set('page', String(filters.page));
  if (filters.pageSize) params.set('pageSize', String(filters.pageSize));
  if (filters.status) params.set('status', filters.status);
  if (filters.room) params.set('room', filters.room);
  const query = params.toString();
  return apiGet<AdminListResponse>(`/api/admin/bookings${query ? `?${query}` : ''}`, signal);
}

export function adminFetchBooking(id: number, signal?: AbortSignal): Promise<Booking> {
  return apiGet<Booking>(`/api/admin/bookings/${id}`, signal);
}

export function adminCancelBooking(id: number, reason: string): Promise<Booking> {
  return apiPost<Booking>(`/api/admin/bookings/${id}/cancel`, { reason });
}

/** Hora de Colombia para mostrar en la tabla y el detalle (docs/05 §6). */
const BOGOTA_FORMAT = new Intl.DateTimeFormat('es-CO', {
  timeZone: 'America/Bogota',
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** ISO → "3 nov 2026, 9:00" (hora de Bogotá). `null` para borradores sin horario. */
export function formatBogota(iso: string | null): string {
  if (!iso) return 'Sin horario';
  return BOGOTA_FORMAT.format(new Date(iso));
}
