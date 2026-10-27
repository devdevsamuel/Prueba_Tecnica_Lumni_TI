import type { Queryable } from './outboxRepo.js';
import { insertConfirmation, insertReminder } from './outboxRepo.js';
import { renderConfirmation, renderReminder, type ConfirmationEmailInput } from './templates.js';

/**
 * Servicio del módulo de correo: lo único que los demás módulos deben tocar
 * (docs/02 §4 — nunca se importa el SQL de otro módulo, se pasa por su servicio).
 *
 * La confirmación llama aquí **dentro de su transacción**, que es lo que hace
 * que el outbox sea transaccional: o se confirma y se encola, o no pasa nada
 * de los dos (docs/03 §2-3).
 */
export async function enqueueConfirmation(
  db: Queryable,
  input: ConfirmationEmailInput & { readonly nextAttemptAt: Date },
): Promise<void> {
  const rendered = renderConfirmation(input);
  await insertConfirmation(db, {
    bookingId: input.bookingId,
    subject: rendered.subject,
    body: rendered.body,
    nextAttemptAt: input.nextAttemptAt,
  });
}

/**
 * Encola el recordatorio. Se llama desde el scheduler, no desde la transacción
 * de confirmación: así el recordatorio puede programarse con antelación y el
 * worker lo envía cuando `next_attempt_at` vence. El UNIQUE (booking_id, kind)
 * hace que ejecutar el scheduler muchas veces no duplique.
 */
export async function enqueueReminder(
  db: Queryable,
  input: ConfirmationEmailInput & { readonly nextAttemptAt: Date },
): Promise<boolean> {
  const rendered = renderReminder(input);
  return insertReminder(db, {
    bookingId: input.bookingId,
    subject: rendered.subject,
    body: rendered.body,
    nextAttemptAt: input.nextAttemptAt,
  });
}
