/**
 * Cotizador — función pura (docs/03 §4, docs/01 §2.1).
 *
 * Sin I/O, sin BD, sin `Date.now()`, sin `Intl`: todo lo que necesita viene por
 * parámetro. Eso permite testear la tabla completa de reglas con `node:test`
 * sin levantar nada, y que el servicio decida de dónde salen los datos.
 *
 * Reglas del enunciado:
 *  - horario Lun–Sáb 7:00–21:00, domingo cerrado;
 *  - duración 30 min a 10 h, en bloques de 30 min;
 *  - descuento escalonado (no acumulativo): 10 % desde 4 h, 20 % desde 8 h;
 *  - recargo sábado del 25 % sobre el valor YA descontado;
 *  - disponibilidad: solape estricto contra reservas `confirmed` de la misma sala.
 */
import { dayIndexOf, formatMinutes, minutesOf, weekdayOf } from '../../core/time.js';

/** Apertura y cierre en minutos desde medianoche (hora de Bogotá). */
export const OPEN_MINUTES = 7 * 60;
export const CLOSE_MINUTES = 21 * 60;
export const SLOT_MINUTES = 30;
export const MIN_DURATION_MINUTES = SLOT_MINUTES;
export const MAX_DURATION_MINUTES = 10 * 60;

const DISCOUNT_FROM_MINUTES = 4 * 60; // 10 %
const DEEP_DISCOUNT_FROM_MINUTES = 8 * 60; // 20 % (sustituye al anterior, no se acumula)
const SATURDAY_SURCHARGE = 0.25;

export type QuoteReason =
  | 'duration_invalid'
  | 'not_in_slot'
  | 'sunday_closed'
  | 'before_open'
  | 'after_close'
  | 'in_past'
  | 'room_unavailable';

export interface QuoteInput extends SlotSearch {
  readonly hourlyRate: number; // tarifa de la sala, COP por hora
}

/**
 * Lo mínimo para buscar un hueco libre: no incluye `hourlyRate` porque el
 * barrido de horarios no calcula dinero (interfaz estrecha, docs/03 §7 I).
 */
export interface SlotSearch {
  readonly date: string; // 'YYYY-MM-DD' en Bogotá
  readonly startTime: string; // 'HH:MM' en Bogotá
  readonly durationMinutes: number;
  /** Reservas confirmadas del día, en minutos desde medianoche. */
  readonly busy: readonly BusyInterval[];
  /** Minutos desde medianoche de "ahora" en Bogotá (para rechazar el pasado). */
  readonly nowMinutes: number;
  /** Días desde la época de "hoy" en Bogotá (para rechazar fechas pasadas). */
  readonly todayIndex: number;
}

/** Franja ocupada [startMinutes, endMinutes) en minutos desde medianoche. */
export interface BusyInterval {
  readonly startMinutes: number;
  readonly endMinutes: number;
}

export interface QuoteBreakdown {
  readonly base: number;
  readonly discountPercent: number;
  readonly discount: number;
  readonly surcharge: number;
  readonly total: number;
}

export interface Slot {
  readonly date: string;
  readonly startTime: string;
}

export interface QuoteResult {
  readonly canBook: boolean;
  readonly reason: QuoteReason | null;
  readonly breakdown: QuoteBreakdown | null;
  readonly suggestedSlot: Slot | null;
  readonly isSaturday: boolean;
  readonly endTime: string;
}

/** Solape estricto: que una termine a las 10:00 y otra empiece a las 10:00 NO se cruzan. */
export function overlapsStrictly(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && aEnd > bStart;
}

/** Descuento escalonado (no acumulativo). */
export function discountPercentFor(durationMinutes: number): number {
  if (durationMinutes >= DEEP_DISCOUNT_FROM_MINUTES) return 20;
  if (durationMinutes >= DISCOUNT_FROM_MINUTES) return 10;
  return 0;
}

/** Desglose monetario puro. Asume duración y tarifa ya validadas. */
export function calculateBreakdown(
  durationMinutes: number,
  hourlyRate: number,
  isSaturday: boolean,
): QuoteBreakdown {
  const base = hourlyRate * (durationMinutes / 60);
  const discountPercent = discountPercentFor(durationMinutes);
  const discount = base * (discountPercent / 100);
  const afterDiscount = base - discount;
  const surcharge = isSaturday ? afterDiscount * SATURDAY_SURCHARGE : 0;
  return {
    base,
    discountPercent,
    discount,
    surcharge,
    total: afterDiscount + surcharge,
  };
}

/**
 * ¿Es esta duración válida? Reglas del enunciado: 30 min a 10 h en bloques de 30 min.
 * Devuelve `true` si es válida.
 */
export function isValidDuration(durationMinutes: number): boolean {
  return (
    Number.isInteger(durationMinutes) &&
    durationMinutes >= MIN_DURATION_MINUTES &&
    durationMinutes <= MAX_DURATION_MINUTES &&
    durationMinutes % SLOT_MINUTES === 0
  );
}

/**
 * Cotiza: valida reglas de horario/disponibilidad y calcula el desglose.
 * Si no se puede reservar, aporta `reason` y el siguiente hueco libre del día.
 */
export function quote(input: QuoteInput): QuoteResult {
  const startMinutes = minutesOf(input.startTime);
  const dateIndex = dayIndexOf(input.date);
  const weekday = weekdayOf(input.date);
  const isSaturday = weekday === 6;
  const endTime = formatMinutes((startMinutes ?? 0) + input.durationMinutes);

  // Duración fuera de regla: no hay desglose posible.
  if (!isValidDuration(input.durationMinutes)) {
    return {
      canBook: false,
      reason: 'duration_invalid',
      breakdown: null,
      suggestedSlot: null,
      isSaturday,
      endTime,
    };
  }

  // La hora de inicio debe caer en un bloque de 30 min.
  if (startMinutes === null || dateIndex === null || weekday === null) {
    return {
      canBook: false,
      reason: 'not_in_slot',
      breakdown: null,
      suggestedSlot: null,
      isSaturday,
      endTime,
    };
  }
  if (startMinutes % SLOT_MINUTES !== 0) {
    return {
      canBook: false,
      reason: 'not_in_slot',
      breakdown: null,
      suggestedSlot: null,
      isSaturday,
      endTime,
    };
  }

  const breakdown = calculateBreakdown(input.durationMinutes, input.hourlyRate, isSaturday);
  const endMinutes = startMinutes + input.durationMinutes;

  // Domingo cerrado.
  if (weekday === 0) {
    return {
      canBook: false,
      reason: 'sunday_closed',
      breakdown,
      suggestedSlot: null,
      isSaturday,
      endTime,
    };
  }

  // Horario de atención: 7:00–21:00 (fin exactamente 21:00 permitido).
  if (startMinutes < OPEN_MINUTES) {
    return {
      canBook: false,
      reason: 'before_open',
      breakdown,
      suggestedSlot: findNextSlot(input),
      isSaturday,
      endTime,
    };
  }
  if (endMinutes > CLOSE_MINUTES) {
    return {
      canBook: false,
      reason: 'after_close',
      breakdown,
      suggestedSlot: findNextSlot(input),
      isSaturday,
      endTime,
    };
  }

  // Fecha/hora en el pasado.
  if (dateIndex < input.todayIndex || (dateIndex === input.todayIndex && startMinutes < input.nowMinutes)) {
    return {
      canBook: false,
      reason: 'in_past',
      breakdown,
      suggestedSlot: null,
      isSaturday,
      endTime,
    };
  }

  // Disponibilidad: solape estricto contra las reservas confirmadas.
  const conflicted = input.busy.some((slot) =>
    overlapsStrictly(startMinutes, endMinutes, slot.startMinutes, slot.endMinutes),
  );
  if (conflicted) {
    return {
      canBook: false,
      reason: 'room_unavailable',
      breakdown,
      suggestedSlot: findNextSlot(input),
      isSaturday,
      endTime,
    };
  }

  return { canBook: true, reason: null, breakdown, suggestedSlot: null, isSaturday, endTime };
}

/**
 * Siguiente horario libre del mismo día, en bloques de 30 min, dentro del
 * horario de atención y sin solapar las reservas dadas (docs/01 §2.1).
 * `null` si no queda ningún hueco que quepa antes del cierre.
 */
export function findNextSlot(input: SlotSearch): Slot | null {
  const startMinutes = minutesOf(input.startTime);
  const duration = input.durationMinutes;
  if (!isValidDuration(duration) || startMinutes === null) return null;

  // El "no sugerir horas pasadas" solo aplica si la fecha pedida es HOY:
  // en un día futuro, la hora del reloj actual es irrelevante.
  const dateIndex = dayIndexOf(input.date);
  const isToday = dateIndex !== null && dateIndex === input.todayIndex;

  // Primer candidato: la hora pedida redondeada hacia arriba al bloque, nunca antes de abrir.
  let candidate = Math.max(OPEN_MINUTES, Math.ceil(startMinutes / SLOT_MINUTES) * SLOT_MINUTES);

  // Si lo pedido ya pasó hoy, empieza a mirar desde "ahora".
  if (isToday && candidate < input.nowMinutes) {
    candidate = Math.ceil(input.nowMinutes / SLOT_MINUTES) * SLOT_MINUTES;
    candidate = Math.max(candidate, OPEN_MINUTES);
  }

  while (candidate + duration <= CLOSE_MINUTES) {
    const free = !input.busy.some((slot) =>
      overlapsStrictly(candidate, candidate + duration, slot.startMinutes, slot.endMinutes),
    );
    if (free) return { date: input.date, startTime: formatMinutes(candidate) };
    candidate += SLOT_MINUTES;
  }
  return null;
}
