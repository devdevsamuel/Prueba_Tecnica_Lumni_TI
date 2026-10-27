import type { Pool } from 'pg';
import type { Clock } from '../../core/clock.js';
import {
  bogotaDateStr,
  bogotaMinutes,
  bogotaWallToUtc,
  dayIndexOf,
  formatMinutes,
  minutesOf,
} from '../../core/time.js';
import { findNextSlot, quote, type BusyInterval, type QuoteResult, type Slot } from '../quotes/quote.js';
import { getRoom, quoteReasonMessage, type Room } from '../quotes/service.js';
import { enqueueConfirmation } from '../email/service.js';
import {
  buildLines,
  codeFromConcept,
  computeTotal,
  type BookingLineDraft,
  type ServiceCode,
} from './pricing.js';
import { assertTransition, InvalidTransitionError, type BookingStatus } from './state.js';

/**
 * Servicio de reservas (Fase 2): borradores retomables, confirmación idempotente
 * y cancelación con motivo. Recibe `pool` y `clock` por parámetro (inyección
 * manual, docs/03 §7-D). La lógica de precios reutiliza la función pura del
 * cotizador; la transición de estado, la máquina de `state.ts`.
 */
export interface BookingDeps {
  readonly pool: Pool;
  readonly clock: Clock;
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

export interface BookingLineView {
  readonly concept: string;
  readonly kind: string;
  readonly amount: number;
}

export interface SuggestedSlot {
  readonly date: string;
  readonly startTime: string;
}

export interface AvailabilityView {
  readonly canBook: boolean;
  readonly reason: string | null;
  readonly suggestedSlot: SuggestedSlot | null;
}

export interface BookingView {
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
  readonly lines: readonly BookingLineView[];
  readonly total: number | null;
  readonly cancelReason: string | null;
  /** Aviso de disponibilidad (no bloquea guardar, pero avisa al usuario). */
  readonly availability: AvailabilityView | null;
}

// ── Errores de dominio (las rutas los traducen a HTTP) ──────────────────────

export class BookingNotFoundError extends Error {
  constructor(readonly id: number) {
    super(`No existe la reserva ${id}.`);
    this.name = 'BookingNotFoundError';
  }
}

/** Intento de editar algo que ya no es borrador. */
export class NotDraftError extends Error {
  constructor(id: number, status: string) {
    super(`La reserva ${id} está en "${status}": solo se pueden editar borradores.`);
    this.name = 'NotDraftError';
  }
}

/** Regla de negocio incumplida (horario inválido, datos incompletos, sin motivo). */
export class DraftRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DraftRuleError';
  }
}

/** Choque con el constraint de exclusión: 409 + siguiente horario libre. */
export class OverlapError extends Error {
  constructor(readonly suggestedSlot: Slot | null) {
    super('La sala ya está reservada en ese horario.');
    this.name = 'OverlapError';
  }
}

// ── Lecturas ────────────────────────────────────────────────────────────────

interface BookingRow {
  readonly id: number;
  readonly customer_name: string | null;
  readonly customer_email: string | null;
  readonly room_id: number | null;
  readonly starts_at: Date | null;
  readonly ends_at: Date | null;
  readonly status: string;
  readonly cancel_reason: string | null;
  readonly total: string | null;
  readonly room_name: string | null;
  readonly hourly_rate: string | null;
}

const ROW_SELECT = `
  SELECT b.id, b.customer_name, b.customer_email, b.room_id, b.starts_at, b.ends_at,
         b.status, b.cancel_reason, b.total,
         r.name AS room_name, r.hourly_rate
    FROM bookings b
    LEFT JOIN rooms r ON r.id = b.room_id`;

async function loadRow(pool: Pool, id: number): Promise<BookingRow | undefined> {
  const { rows } = await pool.query<BookingRow>(`${ROW_SELECT} WHERE b.id = $1`, [id]);
  return rows[0];
}

/** Franjas confirmadas de esa sala durante el día (Bogotá), en minutos del día. */
async function loadBusy(pool: Pool, roomId: number, date: string): Promise<BusyInterval[]> {
  const { rows } = await pool.query<{ starts_at: Date; ends_at: Date }>(
    `SELECT starts_at, ends_at
       FROM bookings
      WHERE room_id = $1 AND status = 'confirmed'
        AND starts_at < $2 AND ends_at > $3`,
    [roomId, bogotaWallToUtc(date, 1440), bogotaWallToUtc(date, 0)],
  );
  return rows.map((row) => ({
    startMinutes: bogotaMinutes(row.starts_at),
    endMinutes: bogotaMinutes(row.ends_at),
  }));
}

/** Evalúa la regla de horario + disponibilidad con la función pura del cotizador. */
async function evaluate(
  deps: BookingDeps,
  params: { roomId: number; date: string; startTime: string; durationMinutes: number },
): Promise<{ result: QuoteResult; room: Room }> {
  const room = await getRoom({ pool: deps.pool, clock: deps.clock }, params.roomId);
  const busy = await loadBusy(deps.pool, room.id, params.date);
  const now = deps.clock.now();
  const today = bogotaDateStr(now);
  const result = quote({
    date: params.date,
    startTime: params.startTime,
    durationMinutes: params.durationMinutes,
    hourlyRate: room.hourlyRate,
    busy,
    nowMinutes: bogotaMinutes(now),
    todayIndex: dayIndexOf(today) ?? 0,
  });
  return { result, room };
}

/** Siguiente hueco libre el mismo día tras un conflicto (para responder 409). */
async function nextSlotFor(deps: BookingDeps, row: BookingRow): Promise<Slot | null> {
  if (!row.room_id || !row.starts_at || !row.ends_at) return null;
  const date = bogotaDateStr(row.starts_at);
  const busy = await loadBusy(deps.pool, row.room_id, date);
  const now = deps.clock.now();
  return findNextSlot({
    date,
    startTime: formatMinutes(bogotaMinutes(row.starts_at)),
    durationMinutes: Math.round((row.ends_at.getTime() - row.starts_at.getTime()) / 60_000),
    busy,
    nowMinutes: bogotaMinutes(now),
    todayIndex: dayIndexOf(bogotaDateStr(now)) ?? 0,
  });
}

// ── Vistas ──────────────────────────────────────────────────────────────────

function durationOf(row: BookingRow): number | null {
  if (!row.starts_at || !row.ends_at) return null;
  return Math.round((row.ends_at.getTime() - row.starts_at.getTime()) / 60_000);
}

async function buildView(deps: BookingDeps, id: number): Promise<BookingView> {
  const row = await loadRow(deps.pool, id);
  if (!row) throw new BookingNotFoundError(id);

  const { rows: lineRows } = await deps.pool.query<{ concept: string; kind: string; amount: string }>(
    'SELECT concept, kind, amount FROM booking_lines WHERE booking_id = $1 ORDER BY id',
    [id],
  );
  const lines: BookingLineView[] = lineRows.map((line) => ({
    concept: line.concept,
    kind: line.kind,
    amount: Number(line.amount),
  }));
  const services = lines
    .filter((line) => line.kind === 'service')
    .map((line) => codeFromConcept(line.concept))
    .filter((code): code is ServiceCode => code !== null);

  // Aviso de disponibilidad: se calcula pero nunca bloquea una lectura.
  // Solo tiene sentido para un borrador o para una reserva cancelada: en este
  // último caso el turno quedó libre y se quiere ofrecer el siguiente hueco.
  // Una reserva `confirmed` ya ocupa su propio horario, por lo que su
  // sugerencia sería inválida (además, su propio booking aparecería como
  // ocupado y ocultaría el siguiente hueco real).
  let availability: AvailabilityView | null = null;
  if (
    (row.status === 'draft' || row.status === 'cancelled') &&
    row.room_id &&
    row.starts_at &&
    row.ends_at
  ) {
    const { result } = await evaluate(deps, {
      roomId: row.room_id,
      date: bogotaDateStr(row.starts_at),
      startTime: formatMinutes(bogotaMinutes(row.starts_at)),
      durationMinutes: durationOf(row) ?? 0,
    });
    availability = {
      canBook: result.canBook,
      reason: result.reason ? quoteReasonMessage(result.reason) : null,
      suggestedSlot: result.suggestedSlot,
    };
  }

  const durationMinutes = durationOf(row);
  return {
    id: row.id,
    status: row.status as BookingStatus,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    roomId: row.room_id,
    roomName: row.room_name,
    hourlyRate: row.hourly_rate === null ? null : Number(row.hourly_rate),
    date: row.starts_at ? bogotaDateStr(row.starts_at) : null,
    startTime: row.starts_at ? formatMinutes(bogotaMinutes(row.starts_at)) : null,
    durationMinutes,
    endTime:
      row.starts_at && durationMinutes !== null
        ? formatMinutes(bogotaMinutes(row.starts_at) + durationMinutes)
        : null,
    services,
    lines,
    total: row.total === null ? null : Number(row.total),
    cancelReason: row.cancel_reason,
    availability,
  };
}

/** Datos del borrador para retomar el wizard (404 si no existe). */
export async function getBooking(deps: BookingDeps, id: number): Promise<BookingView> {
  return buildView(deps, id);
}

// ── Escrituras ──────────────────────────────────────────────────────────────

interface EffectiveFields {
  customerName: string | null;
  customerEmail: string | null;
  roomId: number | null;
  date: string | null;
  startTime: string | null;
  durationMinutes: number | null;
  services: readonly ServiceCode[];
}

function mergeFields(row: BookingRow | undefined, input: DraftInput, services: readonly ServiceCode[]): EffectiveFields {
  return {
    customerName: input.customerName ?? row?.customer_name ?? null,
    customerEmail: input.customerEmail ?? row?.customer_email ?? null,
    roomId: input.roomId ?? row?.room_id ?? null,
    date: input.date ?? (row?.starts_at ? bogotaDateStr(row.starts_at) : null),
    startTime:
      input.startTime ?? (row?.starts_at ? formatMinutes(bogotaMinutes(row.starts_at)) : null),
    durationMinutes: input.durationMinutes ?? (row ? durationOf(row) : null),
    services,
  };
}

/** Recupera los servicios ya guardados en las líneas del borrador. */
async function storedServices(pool: Pool, id: number): Promise<readonly ServiceCode[]> {
  const { rows } = await pool.query<{ concept: string }>(
    `SELECT concept FROM booking_lines WHERE booking_id = $1 AND kind = 'service' ORDER BY id`,
    [id],
  );
  return rows
    .map((row) => codeFromConcept(row.concept))
    .filter((code): code is ServiceCode => code !== null);
}

function toInterval(fields: EffectiveFields): { startsAt: Date | null; endsAt: Date | null } {
  if (!fields.date || !fields.startTime || fields.durationMinutes === null) {
    return { startsAt: null, endsAt: null };
  }
  const startMinutes = minutesOf(fields.startTime);
  if (startMinutes === null) return { startsAt: null, endsAt: null };
  return {
    startsAt: bogotaWallToUtc(fields.date, startMinutes),
    endsAt: bogotaWallToUtc(fields.date, startMinutes + fields.durationMinutes),
  };
}

function isExclusionViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23P01'
  );
}

/**
 * Crea o actualiza un borrador (upsert por paso) y congela el precio cuando hay
 * sala + horario. Los datos de horario inválidos **bloquean**; la falta de
 * disponibilidad solo se devuelve como aviso (un borrador no reserva el turno).
 */
export async function saveDraft(deps: BookingDeps, input: DraftInput): Promise<BookingView> {
  const { pool } = deps;

  // A. Si es una actualización, debe existir y seguir siendo borrador.
  let existing: BookingRow | undefined;
  if (input.id !== undefined) {
    existing = await loadRow(pool, input.id);
    if (!existing) throw new BookingNotFoundError(input.id);
    if (existing.status !== 'draft') throw new NotDraftError(input.id, existing.status);
  }

  // B. Campos efectivos: los ya guardados + lo que llega en esta llamada.
  const services = input.services ?? (existing ? await storedServices(pool, existing.id) : []);
  const fields = mergeFields(existing, input, services);
  const { startsAt, endsAt } = toInterval(fields);

  // C. Validar y calcular ANTES de escribir nada: si el horario es inválido, no
  //    se crea ni se toca el borrador (evita filas huérfanas ante un 422).
  let total: number | null = null;
  let lines: readonly BookingLineDraft[] = [];
  let availability: AvailabilityView | null = null;

  // La disponibilidad se ofrece solo mientras la reserva sea un borrador.
  // En una creación nueva (`existing` no existe) también corresponde.
  if (
    (existing === undefined || existing.status === 'draft') &&
    fields.roomId !== null &&
    startsAt &&
    endsAt &&
    fields.startTime &&
    fields.durationMinutes !== null
  ) {
    const { result } = await evaluate(deps, {
      roomId: fields.roomId,
      date: fields.date as string,
      startTime: fields.startTime,
      durationMinutes: fields.durationMinutes,
    });

    // El horario inválido no deja guardar; la ocupación, solo avisa (un
    // borrador no reserva el turno: eso lo decide la confirmación).
    if (!result.canBook && result.reason && result.reason !== 'room_unavailable') {
      throw new DraftRuleError(quoteReasonMessage(result.reason));
    }
    if (!result.breakdown) {
      throw new DraftRuleError('No se pudo calcular el precio de esta reserva.');
    }

    total = computeTotal(result.breakdown, fields.services);
    lines = buildLines(result.breakdown, fields.services);
    availability = {
      canBook: result.canBook,
      reason: result.reason ? quoteReasonMessage(result.reason) : null,
      suggestedSlot: result.suggestedSlot,
    };
  }

  // D. Escritura atómica: campos + total + reconstrucción de líneas.
  const client = await pool.connect();
  let txOpen = false;
  let savedId: number | undefined = existing?.id;
  try {
    await client.query('BEGIN');
    txOpen = true;

    if (savedId !== undefined) {
      await client.query(
        `UPDATE bookings
            SET customer_name = $2, customer_email = $3, room_id = $4,
                starts_at = $5, ends_at = $6, total = $7, updated_at = now()
          WHERE id = $1`,
        [savedId, fields.customerName, fields.customerEmail, fields.roomId, startsAt, endsAt, total],
      );
      await client.query('DELETE FROM booking_lines WHERE booking_id = $1', [savedId]);
    } else {
      const inserted = await client.query<{ id: number }>(
        `INSERT INTO bookings (customer_name, customer_email, room_id, starts_at, ends_at, status, total)
         VALUES ($1, $2, $3, $4, $5, 'draft', $6) RETURNING id`,
        [fields.customerName, fields.customerEmail, fields.roomId, startsAt, endsAt, total],
      );
      savedId = inserted.rows[0]!.id;
    }

    for (const line of lines) {
      await client.query(
        `INSERT INTO booking_lines (booking_id, concept, kind, amount) VALUES ($1, $2, $3, $4)`,
        [savedId, line.concept, line.kind, line.amount],
      );
    }
    await client.query('COMMIT');
    txOpen = false;
  } finally {
    if (txOpen) await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }

  if (savedId === undefined) throw new Error('No se pudo guardar el borrador.');
  const view = await buildView(deps, savedId);
  return availability ? { ...view, availability } : view;
}

/**
 * `draft → confirmed` de forma idempotente (docs/03 §2): un solo UPDATE
 * condicionado a `draft` con el precio congelado.
 *  - afectó 1 fila → `created` (201);
 *  - afectó 0 filas y ya estaba `confirmed` → misma respuesta sin recalcular;
 *  - choque con el constraint de exclusión → `OverlapError` → 409 + sugerencia.
 */
export async function confirm(
  deps: BookingDeps,
  id: number,
): Promise<{ view: BookingView; created: boolean }> {
  let created: boolean;
  try {
    created = await confirmTransition(deps, id);
  } catch (error) {
    // El conflicto se detectó con la transacción ya cerrada y la conexión
    // liberada, así que ahora sí se puede consultar el siguiente hueco libre.
    if (error instanceof OverlapError) {
      const row = await loadRow(deps.pool, id);
      throw new OverlapError(row ? await nextSlotFor(deps, row) : null);
    }
    throw error;
  }
  return { view: await buildView(deps, id), created };
}

async function confirmTransition(deps: BookingDeps, id: number): Promise<boolean> {
  const client = await deps.pool.connect();
  let txOpen = false;
  try {
    await client.query('BEGIN');
    txOpen = true;

    // `FOR UPDATE OF b` (no el join) porque el LEFT JOIN hace nulable `rooms`
    // y PostgreSQL rechaza FOR UPDATE sobre el lado nulable de un outer join.
    const { rows } = await client.query<BookingRow>(
      `${ROW_SELECT} WHERE b.id = $1 FOR UPDATE OF b`,
      [id],
    );
    const row = rows[0];
    if (!row) throw new BookingNotFoundError(id);

    if (row.status !== 'draft') {
      // Doble clic / dos pestañas: si ya está confirmada se devuelve tal cual.
      if (row.status === 'confirmed') {
        await client.query('COMMIT');
        txOpen = false;
        return false;
      }
      throw new InvalidTransitionError(row.status as BookingStatus, 'confirmed');
    }

    // Desde la migración 0002 estos campos son anulables: al confirmar, obligatorios.
    if (
      !row.customer_name ||
      !row.customer_email ||
      row.room_id === null ||
      !row.starts_at ||
      !row.ends_at ||
      row.total === null
    ) {
      throw new DraftRuleError('Faltan datos de la reserva: completa todos los pasos antes de confirmar.');
    }

    let updated;
    try {
      updated = await client.query(
        `UPDATE bookings
            SET status = 'confirmed', confirmed_at = now(), total = $2
          WHERE id = $1 AND status = 'draft'`,
        [id, row.total],
      );
    } catch (error) {
      if (isExclusionViolation(error)) throw new OverlapError(null);
      throw error;
    }

    // Outbox transaccional (docs/03 §2-3): el correo se encola en la MISMA
    // transición. Si algo falla aquí no se confirma nada, y tampoco queda correo
    // — nunca puede existir una confirmación sin su correo ni al revés.
    if ((updated.rowCount ?? 0) === 1) {
      await enqueueConfirmation(client, {
        bookingId: row.id,
        customerName: row.customer_name,
        roomName: row.room_name ?? 'Sala',
        date: bogotaDateStr(row.starts_at),
        startTime: formatMinutes(bogotaMinutes(row.starts_at)),
        endTime: formatMinutes(bogotaMinutes(row.ends_at)),
        total: Number(row.total),
        nextAttemptAt: deps.clock.now(),
      });
    }

    await client.query('COMMIT');
    txOpen = false;

    if ((updated.rowCount ?? 0) === 1) return true;

    // Otra petición ganó la carrera: se relee y se responde como si ya fuera.
    const again = await loadRow(deps.pool, id);
    if (again?.status === 'confirmed') return false;
    throw new InvalidTransitionError((again?.status ?? 'draft') as BookingStatus, 'confirmed');
  } finally {
    // Nunca se libera la conexión con una transacción abierta.
    if (txOpen) await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/**
 * Cancela con motivo obligatorio (docs/01 §2.2). La transición se valida con la
 * máquina de estados y el UPDATE se condiciona al estado previo (carrera segura).
 */
export async function cancel(
  deps: BookingDeps,
  id: number,
  reason: string,
): Promise<BookingView> {
  if (!reason || reason.trim().length === 0) {
    throw new DraftRuleError('El motivo de la cancelación es obligatorio.');
  }

  const row = await loadRow(deps.pool, id);
  if (!row) throw new BookingNotFoundError(id);
  assertTransition(row.status as BookingStatus, 'cancelled');

  const updated = await deps.pool.query(
    `UPDATE bookings SET status = 'cancelled', cancel_reason = $2, updated_at = now()
      WHERE id = $1 AND status = $3`,
    [id, reason.trim(), row.status],
  );
  if ((updated.rowCount ?? 0) !== 1) {
    const again = await loadRow(deps.pool, id);
    if (!again) throw new BookingNotFoundError(id);
    throw new InvalidTransitionError(again.status as BookingStatus, 'cancelled');
  }
  return buildView(deps, id);
}
