import type { Pool } from 'pg';
import type { Clock } from '../../core/clock.js';
import { bogotaDateStr, bogotaMinutes, formatMinutes } from '../../core/time.js';
import { enqueueReminder } from './service.js';

/**
 * Scheduler de recordatorios (extensión posterior). No es una cola nueva:
 * analiza la BD y **inserta filas** en el outbox existente; el worker actual
 * sigue siendo el único que envía, reintenta y aplica backoff por fila.
 *
 * Reglas de negocio (docs/03 §9):
 *  - solo reservas `confirmed`;
 *  - solo si la reserva existía antes del corte `starts_at - leadHours`
 *    (si se confirma con menos antelación, no se envía un recordatorio tardío);
 *  - ventana de catch-up: si el scheduler estuvo caído, recupera recordatorios
 *    vencidos hace menos de `catchupHours` y cuya reserva aún no empieza.
 */
export interface ReminderSchedulerDeps {
  readonly pool: Pool;
  readonly clock: Clock;
  readonly leadHours: number;
  readonly catchupHours: number;
  /** Adelanto de la ventana de inserción; normalmente el intervalo del tick. */
  readonly lookaheadMs?: number;
}

interface ReminderRow {
  readonly booking_id: number;
  readonly customer_name: string | null;
  readonly room_name: string | null;
  readonly starts_at: Date;
  readonly ends_at: Date;
  readonly total: string | null;
  readonly reminder_at: Date;
}

const DEFAULT_LOOKAHEAD_MS = 60_000;

/**
 * Inserta los recordatorios que ya tocan. Es idempotente: se puede llamar en
 * cada tick, desde dos procesos o tras un reinicio; `ON CONFLICT` evita
 * duplicados y el worker solo verá una fila por reserva.
 *
 * Devuelve cuántas filas nuevas se crearon (no cuántas se enviaron).
 */
export async function enqueueDueReminders(deps: ReminderSchedulerDeps): Promise<number> {
  const now = deps.clock.now();
  const lookahead = new Date(now.getTime() + (deps.lookaheadMs ?? DEFAULT_LOOKAHEAD_MS));
  const catchupFrom = new Date(now.getTime() - deps.catchupHours * 3_600_000);

  const { rows } = await deps.pool.query<ReminderRow>(
    `SELECT b.id AS booking_id,
            b.customer_name,
            r.name AS room_name,
            b.starts_at,
            b.ends_at,
            b.total,
            b.starts_at - ($2::int * interval '1 hour') AS reminder_at
       FROM bookings b
       JOIN rooms r ON r.id = b.room_id
      WHERE b.status = 'confirmed'
        AND b.starts_at > $1
        AND COALESCE(b.confirmed_at, b.created_at)
            <= b.starts_at - ($2::int * interval '1 hour')
        AND b.starts_at - ($2::int * interval '1 hour') <= $3
        AND b.starts_at - ($2::int * interval '1 hour') >= $4
      ORDER BY b.starts_at, b.id`,
    [now, deps.leadHours, lookahead, catchupFrom],
  );

  let inserted = 0;
  for (const row of rows) {
    const created = await enqueueReminder(deps.pool, {
      bookingId: row.booking_id,
      customerName: row.customer_name ?? 'Cliente',
      roomName: row.room_name ?? 'Sala',
      date: bogotaDateStr(row.starts_at),
      startTime: formatMinutes(bogotaMinutes(row.starts_at)),
      endTime: formatMinutes(bogotaMinutes(row.ends_at)),
      total: Number(row.total ?? 0),
      nextAttemptAt: row.reminder_at,
    });
    if (created) inserted += 1;
  }
  return inserted;
}

/**
 * Arranca el scheduler. Se ejecuta un tick inmediato (por si el proceso arrancó
 * después del corte) y luego cada `intervalMs`. Devuelve la función de parada.
 */
export function startReminderScheduler(
  deps: ReminderSchedulerDeps,
  intervalMs: number,
): () => void {
  const tick = (): void => {
    void enqueueDueReminders({ ...deps, lookaheadMs: intervalMs })
      .then((created) => {
        if (created > 0) console.log(`Recordatorios: ${created} encolado(s).`);
      })
      .catch((error: unknown) => {
        console.error('Recordatorios: fallo en el tick:', error);
      });
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
