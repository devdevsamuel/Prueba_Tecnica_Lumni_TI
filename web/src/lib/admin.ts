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

// ── Bandeja de correos (Parte 2.1) ──────────────────────────────────────────

export const EMAIL_STATUSES = ['pending', 'sending', 'sent', 'failed'] as const;

export type EmailStatus = (typeof EMAIL_STATUSES)[number];

/** El estado llega de la URL: si no es válido se ignora en vez de pegarle al API. */
export function isEmailStatus(value: string): value is EmailStatus {
  return (EMAIL_STATUSES as readonly string[]).includes(value);
}

export interface EmailItem {
  readonly id: number;
  readonly bookingId: number;
  readonly kind: string;
  readonly status: EmailStatus;
  readonly attempts: number;
  readonly nextAttemptAt: string;
  readonly lastError: string | null;
  readonly subject: string;
  readonly sentAt: string | null;
  readonly createdAt: string;
  readonly recipient: string;
  readonly customerName: string;
  readonly roomName: string | null;
}

export interface EmailDetail extends EmailItem {
  readonly body: string;
}

export interface EmailListResponse {
  readonly items: readonly EmailItem[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
}

export function fetchEmails(
  filters: { status?: EmailStatus; page?: number; pageSize?: number },
  signal?: AbortSignal,
): Promise<EmailListResponse> {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.page) params.set('page', String(filters.page));
  if (filters.pageSize) params.set('pageSize', String(filters.pageSize));
  const query = params.toString();
  return apiGet<EmailListResponse>(`/api/admin/emails${query ? `?${query}` : ''}`, signal);
}

export function fetchEmail(id: number, signal?: AbortSignal): Promise<EmailDetail> {
  return apiGet<EmailDetail>(`/api/admin/emails/${id}`, signal);
}

// ── Trazabilidad del asistente (Fase 5b) ────────────────────────────────────

/** Un mensaje con su consumo. En los del usuario los tokens son 0 y `model` NULL. */
export interface ChatUsageItem {
  readonly id: number;
  readonly sessionId: string;
  readonly role: 'user' | 'assistant';
  readonly createdAt: string;
  readonly preview: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly reasoningTokens: number;
  readonly costUsd: number;
  readonly model: string | null;
}

/** Agregados de toda la tabla + uso del mes natural (America/Bogota). */
export interface ChatUsageSummary {
  readonly messages: number;
  readonly turns: number;
  readonly sessions: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly reasoningTokens: number;
  readonly costUsd: number;
  readonly monthTokens: number;
  /** `null` = sin presupuesto configurado (solo se avisa del consumo). */
  readonly monthBudget: number | null;
  readonly model: string;
}

export interface ChatUsageResponse {
  readonly summary: ChatUsageSummary;
  readonly items: readonly ChatUsageItem[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
}

export function fetchChatUsage(
  page: number,
  pageSize: number,
  signal?: AbortSignal,
): Promise<ChatUsageResponse> {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  return apiGet<ChatUsageResponse>(`/api/admin/chat/usage?${params.toString()}`, signal);
}
