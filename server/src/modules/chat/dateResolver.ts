import { addDays, bogotaDateStr, bogotaMinutes, weekdayOf } from '../../core/time.js';
import { PART_START_TIME, type DAY_REFS, type PARTS_OF_DAY } from './schema.js';

/**
 * Fechas relativas resueltas EN CÓDIGO (docs/01 §9): el modelo solo clasifica
 * (`dayRef` + `partOfDay`) y aquí se convierte en fecha y hora concretas con el
 * calendario y la zona de Bogotá. **El modelo nunca decide la fecha.**
 */
export type DayRef = (typeof DAY_REFS)[number];
export type PartOfDay = (typeof PARTS_OF_DAY)[number];

export interface ResolvedSlot {
  /** 'YYYY-MM-DD' en Bogotá. */
  readonly date: string;
  /** 'HH:MM' en Bogotá. */
  readonly startTime: string;
}

const WEEKDAY_BY_NAME: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/** Día de la semana al que apunta la referencia (0=domingo … 6=sábado). */
function targetWeekday(dayRef: DayRef, todayWeekday: number): number {
  if (dayRef === 'today') return todayWeekday;
  if (dayRef === 'tomorrow') return (todayWeekday + 1) % 7;
  return WEEKDAY_BY_NAME[dayRef] ?? todayWeekday;
}

/**
 * Próxima ocurrencia de esa referencia:
 *  - "el sábado" desde un martes → el sábado que viene;
 *  - "el sábado" siendo sábado ANTES de la hora elegida → hoy;
 *  - "el sábado" siendo sábado DESPUÉS de esa hora → el sábado de la semana que viene.
 * `today`/`tomorrow` son literales: si la hora ya pasó, el cotizador devolverá
 * `in_past` y el servicio responderá con una alternativa (no se inventa fecha).
 */
export function resolveSlot(input: {
  readonly dayRef: DayRef;
  readonly partOfDay: PartOfDay;
  readonly now: Date;
}): ResolvedSlot {
  const today = bogotaDateStr(input.now);
  const todayWeekday = weekdayOf(today);
  if (todayWeekday === null) throw new Error(`Fecha de hoy inválida: ${today}`);

  const startTime = PART_START_TIME[input.partOfDay];
  const target = targetWeekday(input.dayRef, todayWeekday);
  let daysAhead = (target - todayWeekday + 7) % 7;

  const startMinutes = timeToMinutes(startTime);
  const isSameDay = daysAhead === 0;
  const alreadyPast = isSameDay && startMinutes !== null && startMinutes <= bogotaMinutes(input.now);
  const isLiteralReference = input.dayRef === 'today' || input.dayRef === 'tomorrow';

  if (alreadyPast && !isLiteralReference) daysAhead = 7;

  return { date: addDays(today, daysAhead), startTime };
}

/** 'HH:MM' → minutos desde medianoche; `null` si no es hora válida. */
function timeToMinutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}
