import { apiGet, apiPost } from './api';

/**
 * Cliente de la API de reservas (Fase 2). Único punto de red del wizard
 * (docs/03 §7 S): la página nunca hace `fetch` directo.
 */

export type ServiceCode = 'projector' | 'coffee';

export interface BookingLine {
  readonly concept: string;
  readonly kind: string;
  readonly amount: number;
}

export interface SuggestedSlot {
  readonly date: string;
  readonly startTime: string;
}

export interface Availability {
  readonly canBook: boolean;
  readonly reason: string | null;
  readonly suggestedSlot: SuggestedSlot | null;
}

export type BookingStatus = 'draft' | 'confirmed' | 'completed' | 'cancelled';

export interface Booking {
  readonly id: number;
  readonly status: BookingStatus;
  readonly customerName: string | null;
  readonly customerEmail: string | null;
  readonly roomId: number | null;
  readonly roomName: string | null;
  readonly hourlyRate: number | null;
  readonly date: string | null;
  readonly startTime: string | null;
  readonly durationMinutes: number | null;
  readonly endTime: string | null;
  readonly services: readonly ServiceCode[];
  readonly lines: readonly BookingLine[];
  readonly total: number | null;
  readonly cancelReason: string | null;
  readonly availability: Availability | null;
}

export interface DraftInput {
  readonly id?: number;
  readonly customerName?: string;
  readonly customerEmail?: string;
  readonly roomId?: number;
  readonly date?: string;
  readonly startTime?: string;
  readonly durationMinutes?: number;
  readonly services?: readonly ServiceCode[];
}

/** Catálogo de servicios (lo pinta la UI; el precio lo manda el servidor). */
export const SERVICE_OPTIONS: readonly { code: ServiceCode; label: string; price: number }[] = [
  { code: 'projector', label: 'Proyector', price: 10_000 },
  { code: 'coffee', label: 'Café', price: 5_000 },
];

export function saveDraft(input: DraftInput): Promise<Booking> {
  return apiPost<Booking>('/api/bookings', input);
}

export function fetchBooking(id: number): Promise<Booking> {
  return apiGet<Booking>(`/api/bookings/${id}`);
}

export function confirmBooking(id: number): Promise<Booking> {
  return apiPost<Booking>(`/api/bookings/${id}/confirm`, {});
}

/** Cancela con motivo obligatorio (validado también en el servidor). */
export function cancelBooking(id: number, reason: string): Promise<Booking> {
  return apiPost<Booking>(`/api/bookings/${id}/cancel`, { reason });
}
