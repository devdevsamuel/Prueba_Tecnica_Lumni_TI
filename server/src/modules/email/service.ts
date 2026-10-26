import type { Queryable } from './outboxRepo.js';
import { insertConfirmation } from './outboxRepo.js';
import { renderConfirmation, type ConfirmationEmailInput } from './templates.js';

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
