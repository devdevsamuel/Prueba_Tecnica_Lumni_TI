/**
 * Máquina de estados de la reserva (docs/03 §5) — pura y declarativa.
 * La validación SIEMPRE está en el backend: la UI solo pinta botones.
 * Añadir un estado o una transición = una línea en el mapa + su test (OCP).
 */
export type BookingStatus = 'draft' | 'confirmed' | 'completed' | 'cancelled';

export const TRANSITIONS: Record<BookingStatus, readonly BookingStatus[]> = {
  draft: ['confirmed', 'cancelled'],
  confirmed: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: BookingStatus,
    readonly to: BookingStatus,
  ) {
    super(`Transición no permitida: ${from} → ${to}.`);
    this.name = 'InvalidTransitionError';
  }
}

/** Lanza `InvalidTransitionError` si la transición no está en el mapa. */
export function assertTransition(from: BookingStatus, to: BookingStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
