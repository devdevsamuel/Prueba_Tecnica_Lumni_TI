import { apiGet, apiPost } from './api';

/**
 * Tipos y llamadas del cotizador (Fase 1). Único punto de red de esta pantalla
 * (docs/03 §7 S): las páginas no hacen `fetch` directo.
 */

export type RoomSize = 'small' | 'medium' | 'large';

export interface Room {
  readonly id: number;
  readonly name: string;
  readonly size: RoomSize;
  readonly capacity: number;
  readonly hourlyRate: number;
  readonly active: boolean;
}

export interface SuggestedSlot {
  readonly date: string;
  readonly startTime: string;
}

export interface QuoteResult {
  readonly room: Room;
  readonly date: string;
  readonly startTime: string;
  readonly durationMinutes: number;
  readonly endTime: string;
  readonly isSaturday: boolean;
  readonly base: number;
  readonly discountPercent: number;
  readonly discount: number;
  readonly surcharge: number;
  readonly total: number;
  readonly canBook: boolean;
  readonly reason: string | null;
  readonly suggestedSlot: SuggestedSlot | null;
}

export interface QuoteRequest {
  readonly roomId: number;
  readonly date: string;
  readonly startTime: string;
  readonly durationMinutes: number;
}

export function fetchRooms(signal?: AbortSignal): Promise<{ rooms: Room[] }> {
  return apiGet<{ rooms: Room[] }>('/api/rooms', signal);
}

export function postQuote(request: QuoteRequest, signal?: AbortSignal): Promise<QuoteResult> {
  return apiPost<QuoteResult>('/api/quotes', request, signal);
}

/** Formato COP sin decimals: $160.000 (moneda de Colombia). */
const COP = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

export function formatCop(value: number): string {
  return COP.format(value);
}

/** "120 minutos" → "2 horas" / "1 h 30 min" para etiquetas legibles. */
export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} minutos`;
  if (rest === 0) return hours === 1 ? '1 hora' : `${hours} horas`;
  return `${hours} h ${rest} min`;
}

/** Opciones de duración (30…600 en bloques de 30) compartidas por el cotizador y el wizard. */
export const DURATION_OPTIONS: readonly number[] = Array.from({ length: 20 }, (_, index) => (index + 1) * 30);

/** Opciones de hora de inicio (07:00…20:30, todos los inicios que caben antes de las 21:00). */
export const START_OPTIONS: readonly string[] = Array.from({ length: 28 }, (_, index) => {
  const minutes = 7 * 60 + index * 30;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
});
