import type { Pool } from 'pg';
import type { Clock } from '../../core/clock.js';
import * as outbox from './outboxRepo.js';
import type { EmailSender } from './sender.js';

/**
 * Worker de la bandeja (Parte 2.1). Un tick:
 *  1. toma un trabajo vencido con `FOR UPDATE SKIP LOCKED` y lo marca `sending`
 *     (así otros workers no lo pican) y cuenta el intento;
 *  2. **libera la transacción** y llama al transporte fuera de la BD;
 *  3. `sent` si fue bien; si no, `pending` con backoff exponencial o, agotados
 *     los intentos, `failed` con el error (visible en el admin).
 *
 * Los tiempos salen del `Clock` inyectado: así el backoff es testeable en ms
 * (docs/03 §7 I/D — ahí decía que el reloj se usaría de verdad en esta fase).
 */
export const MAX_ATTEMPTS = 5;
export const DEFAULT_BASE_DELAY_MS = 5_000;

export interface WorkerDeps {
  readonly pool: Pool;
  readonly sender: EmailSender;
  readonly clock: Clock;
  /** Retardo base del backoff (los tests lo ponen a 0 o muy bajo). */
  readonly baseDelayMs?: number;
}

/** Backoff exponencial: 1×, 2×, 4×, 8×, 16× el base (docs/03 §3). */
export function backoffMs(attempts: number, baseDelayMs: number): number {
  return baseDelayMs * 2 ** Math.max(0, attempts - 1);
}

/** Toma un trabajo y lo deja en `sending` con el intento contado. */
async function pickJob(deps: WorkerDeps): Promise<{ id: number; attempts: number } | null> {
  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');
    const picked = await outbox.pickDue(client, deps.clock.now());
    if (!picked) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query('COMMIT');
    return picked;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Procesa UN trabajo vencido. Devuelve `true` si había alguno. */
export async function processOne(deps: WorkerDeps): Promise<boolean> {
  const baseDelayMs = deps.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  const picked = await pickJob(deps);
  if (!picked) return false;

  const message = await outbox.loadMessage(deps.pool, picked.id);
  if (!message) {
    // La reserva asociada ya no existe: se marca fallido para no reintentar.
    await outbox.markRetry(deps.pool, picked.id, 'Reserva asociada no encontrada.', null);
    return true;
  }

  // Un recordatorio puede quedar obsoleto entre que se encola y le toca el
  // turno: si la reserva se canceló o ya empezó, no se envía. La fila queda
  // 'skipped' (auditoría) y no se reintenta; las demás filas de la cola siguen.
  if (
    message.kind === outbox.REMINDER_KIND &&
    (message.bookingStatus !== 'confirmed' ||
      !message.startsAt ||
      message.startsAt.getTime() <= deps.clock.now().getTime())
  ) {
    await outbox.markSkipped(
      deps.pool,
      picked.id,
      'Recordatorio omitido: la reserva se canceló o ya comenzó.',
    );
    return true;
  }

  const result = await deps.sender.send(message);
  if (result.ok) {
    await outbox.markSent(deps.pool, picked.id, deps.clock.now());
    return true;
  }

  const exhausted = picked.attempts >= MAX_ATTEMPTS;
  const nextAttemptAt = exhausted
    ? null
    : new Date(deps.clock.now().getTime() + backoffMs(picked.attempts, baseDelayMs));
  await outbox.markRetry(deps.pool, picked.id, result.error, nextAttemptAt);
  return true;
}

/** Vacía hasta `max` trabajos en un solo tick. */
export async function drain(deps: WorkerDeps, max = 100): Promise<number> {
  let processed = 0;
  while (processed < max && (await processOne(deps))) {
    processed += 1;
  }
  return processed;
}

/**
 * Reclama los trabajos a medias de una ejecución anterior (`sending` huérfanos):
 * es lo que hace `startWorker` al arrancar, de ahí que la cola sobreviva a un
 * reinicio. Exportado para poder probarlo sin abrir intervalos.
 */
export async function reclaimOnStart(deps: WorkerDeps): Promise<number> {
  return outbox.reclaimStuck(deps.pool);
}

/**
 * Arranca el worker: primero reclama los `sending` huérfanos de una ejecución
 * anterior (cola intacta tras reinicio) y luego programa el tick.
 * Devuelve la función para pararlo.
 */
export function startWorker(deps: WorkerDeps, intervalMs = 5_000): () => void {
  void reclaimOnStart(deps)
    .then((reclaimed) => {
      if (reclaimed > 0) console.log(`Email worker: ${reclaimed} trabajo(s) reclamado(s).`);
    })
    .catch((error: unknown) => {
      console.error('Email worker: no se pudieron reclamar los trabajos:', error);
    });

  const timer = setInterval(() => {
    void drain(deps).catch((error: unknown) => {
      console.error('Email worker: fallo en el tick:', error);
    });
  }, intervalMs);
  timer.unref();

  return () => clearInterval(timer);
}
