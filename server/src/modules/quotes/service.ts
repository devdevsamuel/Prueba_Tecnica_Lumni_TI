import type { Pool } from 'pg';
import type { Clock } from '../../core/clock.js';
import {
  bogotaDateStr,
  bogotaMinutes,
  bogotaWallToUtc,
  dayIndexOf,
} from '../../core/time.js';
import { quote, type BusyInterval, type QuoteReason } from './quote.js';

/**
 * Servicio del cotizador (docs/03 §4): única capa que toca la BD y el reloj.
 * Recibe `pool` y `clock` por parámetro (inyección manual, docs/03 §7-D) →
 * testeable con dobles. La lógica de precios vive en `quote.ts` (pura).
 */
export interface QuoteDeps {
  readonly pool: Pool;
  readonly clock: Clock;
}

export interface Room {
  readonly id: number;
  readonly name: string;
  readonly size: 'small' | 'medium' | 'large';
  readonly capacity: number;
  readonly hourlyRate: number;
  readonly active: boolean;
}

export interface QuoteRequest {
  readonly roomId: number;
  readonly date: string;
  readonly startTime: string;
  readonly durationMinutes: number;
}

export interface QuoteResponse {
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
  readonly suggestedSlot: { date: string; startTime: string } | null;
}

/** Sala inexistente o inactiva → la ruta responde 404. */
export class UnknownRoomError extends Error {
  constructor(readonly roomId: number) {
    super(`No existe la sala ${roomId} o no está activa.`);
    this.name = 'UnknownRoomError';
  }
}

/** Mensajes de motivo en español para la UI (docs/06 §4). */
const REASON_MESSAGES: Record<QuoteReason, string> = {
  duration_invalid: 'La duración debe estar entre 30 minutos y 10 horas.',
  not_in_slot: 'La hora de inicio debe caer en un bloque de 30 minutos (por ejemplo, 10:00 u 10:30).',
  sunday_closed: 'Los domingos el coworking está cerrado. Elige un día de lunes a sábado.',
  before_open: 'Atendemos de lunes a sábado de 7:00 a 21:00. Esta hora es anterior a la apertura.',
  after_close: 'Atendemos de lunes a sábado de 7:00 a 21:00. Esta reserva terminaría después del cierre.',
  in_past: 'La fecha y la hora indicadas ya pasaron. Elige un horario futuro.',
  room_unavailable: 'La sala ya está reservada en ese horario.',
};

/** Mensaje humano de un motivo del cotizador (lo reutiliza el módulo de reservas). */
export function quoteReasonMessage(reason: QuoteReason): string {
  return REASON_MESSAGES[reason];
}

interface RoomRow {
  readonly id: number;
  readonly name: string;
  readonly size: 'small' | 'medium' | 'large';
  readonly capacity: number;
  readonly hourly_rate: string;
  readonly active: boolean;
}

function toRoom(row: RoomRow): Room {
  return {
    id: row.id,
    name: row.name,
    size: row.size,
    capacity: row.capacity,
    hourlyRate: Number(row.hourly_rate),
    active: row.active,
  };
}

/** Lista las salas activas para el selector del cotizador. */
export async function listRooms(deps: QuoteDeps): Promise<Room[]> {
  const { rows } = await deps.pool.query<RoomRow>(
    'SELECT id, name, size, capacity, hourly_rate, active FROM rooms WHERE active = true ORDER BY id',
  );
  return rows.map(toRoom);
}

/**
 * Carga una sala por id; lanza `UnknownRoomError` si no existe o está inactiva.
 * Exportada para que el módulo de reservas reutilice este acceso **pasando por
 * el servicio** (docs/02 §4), sin duplicar SQL de `rooms`.
 */
export async function getRoom(deps: QuoteDeps, roomId: number): Promise<Room> {
  const { rows } = await deps.pool.query<RoomRow>(
    'SELECT id, name, size, capacity, hourly_rate, active FROM rooms WHERE id = $1',
    [roomId],
  );
  const row = rows[0];
  if (!row || !row.active) throw new UnknownRoomError(roomId);
  return toRoom(row);
}

/**
 * Reservas confirmadas de esa sala durante el día en Bogotá, convertidas a
 * minutos desde medianoche para la función pura.
 */
async function loadBusy(deps: QuoteDeps, roomId: number, date: string): Promise<BusyInterval[]> {
  const dayStart = bogotaWallToUtc(date, 0);
  const dayEnd = bogotaWallToUtc(date, 1440); // medianoche del día siguiente
  const { rows } = await deps.pool.query<{ starts_at: Date; ends_at: Date }>(
    `SELECT starts_at, ends_at
       FROM bookings
      WHERE room_id = $1
        AND status = 'confirmed'
        AND starts_at < $2
        AND ends_at > $3`,
    [roomId, dayEnd, dayStart],
  );
  return rows.map((row) => ({
    startMinutes: bogotaMinutes(row.starts_at),
    endMinutes: bogotaMinutes(row.ends_at),
  }));
}

/** Cotiza: carga sala, horarios ocupados y aplica las reglas puras. */
export async function quoteRoom(deps: QuoteDeps, request: QuoteRequest): Promise<QuoteResponse> {
  const room = await getRoom(deps, request.roomId);
  const busy = await loadBusy(deps, request.roomId, request.date);

  const now = deps.clock.now();
  const today = bogotaDateStr(now);

  const result = quote({
    date: request.date,
    startTime: request.startTime,
    durationMinutes: request.durationMinutes,
    hourlyRate: room.hourlyRate,
    busy,
    nowMinutes: bogotaMinutes(now),
    todayIndex: dayIndexOf(today) as number,
  });

  const breakdown = result.breakdown;
  return {
    room,
    date: request.date,
    startTime: request.startTime,
    durationMinutes: request.durationMinutes,
    endTime: result.endTime,
    isSaturday: result.isSaturday,
    base: breakdown?.base ?? 0,
    discountPercent: breakdown?.discountPercent ?? 0,
    discount: breakdown?.discount ?? 0,
    surcharge: breakdown?.surcharge ?? 0,
    total: breakdown?.total ?? 0,
    canBook: result.canBook,
    reason: result.reason ? REASON_MESSAGES[result.reason] : null,
    suggestedSlot: result.suggestedSlot,
  };
}
