/**
 * Reloj inyectable (docs/03 §7 I/D). En la Fase 0 solo aporta la abstracción:
 * su uso real llega con el outbox de la Fase 4 (backoff testeable en ms).
 */
export interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};
