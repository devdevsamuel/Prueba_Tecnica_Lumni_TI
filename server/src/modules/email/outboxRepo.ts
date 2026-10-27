import type { Pool, PoolClient } from 'pg';
import type { EmailMessage } from './sender.js';

/**
 * Repositorio de la bandeja de salida: toda la SQL de la cola vive aquí
 * (docs/02 §4). `Queryable` acepta tanto el `Pool` como el `PoolClient`, porque
 * la inserción de la confirmación ocurre DENTRO de la transacción de `confirm`.
 */
export type Queryable = Pick<Pool, 'query'>;

/** La confirmación y el recordatorio comparten cola, pero no se mezclan. */
export const REMINDER_KIND = 'reminder_2d' as const;

export type OutboxKind = 'confirmation' | typeof REMINDER_KIND;

export type OutboxStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';

export interface OutboxRow {
  readonly id: number;
  readonly booking_id: number;
  readonly kind: OutboxKind;
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly next_attempt_at: Date;
  readonly last_error: string | null;
  readonly rendered_subject: string;
  readonly rendered_body: string;
  readonly sent_at: Date | null;
  readonly created_at: Date;
}

/**
 * Inserta el correo en la MISMA transacción que la transición a `confirmed`.
 * `ON CONFLICT … DO NOTHING` es la segunda barrera de idempotencia: aunque dos
 * procesos llegaran aquí a la vez, solo puede existir una fila por reserva.
 */
export async function insertConfirmation(
  db: Queryable,
  input: {
    readonly bookingId: number;
    readonly subject: string;
    readonly body: string;
    readonly nextAttemptAt: Date;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO email_outbox (booking_id, kind, status, attempts, next_attempt_at,
                               rendered_subject, rendered_body)
     VALUES ($1, 'confirmation', 'pending', 0, $2, $3, $4)
     ON CONFLICT (booking_id, kind) DO NOTHING`,
    [input.bookingId, input.nextAttemptAt, input.subject, input.body],
  );
}

/**
 * Inserta el recordatorio de una reserva confirmada. El scheduler puede correr
 * cada minuto, varias instancias o después de un reinicio: el UNIQUE
 * (booking_id, kind) + ON CONFLICT hacen que la operación sea idempotente.
 *
 * Devuelve `true` solo cuando realmente creó la fila (útil para logs/tests).
 */
export async function insertReminder(
  db: Queryable,
  input: {
    readonly bookingId: number;
    readonly subject: string;
    readonly body: string;
    readonly nextAttemptAt: Date;
  },
): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO email_outbox (booking_id, kind, status, attempts, next_attempt_at,
                               rendered_subject, rendered_body)
     VALUES ($1, $2, 'pending', 0, $3, $4, $5)
     ON CONFLICT (booking_id, kind) DO NOTHING`,
    [input.bookingId, REMINDER_KIND, input.nextAttemptAt, input.subject, input.body],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Toma el próximo trabajo vencido con `FOR UPDATE SKIP LOCKED`: varios workers
 * conviven sin pelearse por el mismo job (docs/03 §3).
 */
export async function pickDue(
  client: PoolClient,
  now: Date,
): Promise<{ id: number; attempts: number } | null> {
  const { rows } = await client.query<{ id: number }>(
    `SELECT id FROM email_outbox
      WHERE status = 'pending' AND next_attempt_at <= $1
      ORDER BY next_attempt_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT 1`,
    [now],
  );
  const id = rows[0]?.id;
  if (id === undefined) return null;

  // Se marca 'sending' y se cuenta el intento ANTES de soltar la fila.
  const updated = await client.query<{ attempts: number }>(
    `UPDATE email_outbox SET status = 'sending', attempts = attempts + 1
      WHERE id = $1 RETURNING attempts`,
    [id],
  );
  return { id, attempts: updated.rows[0]?.attempts ?? 0 };
}

/** Mensaje a enviar + datos de la reserva para decidir si sigue vigente. */
export interface LoadedMessage extends EmailMessage {
  readonly kind: OutboxKind;
  readonly bookingStatus: string;
  readonly startsAt: Date | null;
}

/** Mensaje a enviar (destinatario desde la reserva asociada). */
export async function loadMessage(db: Queryable, id: number): Promise<LoadedMessage | null> {
  const { rows } = await db.query<{
    email: string;
    subject: string;
    body: string;
    kind: OutboxKind;
    booking_status: string;
    starts_at: Date | null;
  }>(
    `SELECT b.customer_email AS email,
            o.rendered_subject AS subject,
            o.rendered_body    AS body,
            o.kind,
            b.status           AS booking_status,
            b.starts_at
       FROM email_outbox o
       JOIN bookings b ON b.id = o.booking_id
      WHERE o.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    to: row.email,
    subject: row.subject,
    body: row.body,
    kind: row.kind,
    bookingStatus: row.booking_status,
    startsAt: row.starts_at,
  };
}

export async function markSent(db: Queryable, id: number, sentAt: Date): Promise<void> {
  await db.query(
    `UPDATE email_outbox SET status = 'sent', sent_at = $2, last_error = NULL WHERE id = $1`,
    [id, sentAt],
  );
}

/**
 * Recordatorio que ya no aplica (reserva cancelada, empezada o eliminada).
 * No es un fallo de envío: `skipped` deja la razón visible en el admin y evita
 * que el worker lo reintente para siempre.
 */
export async function markSkipped(db: Queryable, id: number, reason: string): Promise<void> {
  await db.query(
    `UPDATE email_outbox SET status = 'skipped', last_error = $2 WHERE id = $1`,
    [id, reason],
  );
}

/** Programa el siguiente intento con backoff o agota el correo. */
export async function markRetry(
  db: Queryable,
  id: number,
  error: string,
  nextAttemptAt: Date | null,
): Promise<void> {
  if (nextAttemptAt === null) {
    // Sin reintentos pendientes → 'failed', visible en el admin.
    await db.query(`UPDATE email_outbox SET status = 'failed', last_error = $2 WHERE id = $1`, [
      id,
      error,
    ]);
    return;
  }
  await db.query(
    `UPDATE email_outbox SET status = 'pending', last_error = $2, next_attempt_at = $3
      WHERE id = $1`,
    [id, error, nextAttemptAt],
  );
}

/**
 * Reclama los trabajos que quedaron en 'sending' (worker caído a mitad de envío).
 * Se llama al arrancar: en ese momento, cualquier 'sending' es un huérfano.
 */
export async function reclaimStuck(db: Queryable): Promise<number> {
  const result = await db.query(
    `UPDATE email_outbox
        SET status = 'pending',
            last_error = 'Trabajo reclamado tras el reinicio del worker.'
      WHERE status = 'sending'`,
  );
  return result.rowCount ?? 0;
}
