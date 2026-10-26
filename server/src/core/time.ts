/**
 * Zona horaria y conversión de fechas (docs/01 §14.4, docs/02 §2).
 *
 * Regla del negocio: TODO se recibe y se presenta en America/Bogota (UTC−5, sin
 * horario de verano en Colombia desde 1993). PostgreSQL guarda `timestamptz` en
 * UTC, así que necesitamos ir y venir entre las dos representaciones.
 *
 * Sin librerías de fecha: uso `Intl.DateTimeFormat` para leer la hora local en
 * cualquier huso y el truco de restar el desfase para convertir hora local → UTC.
 * Descarta dayjs/date-fns/moment (dependencias, docs/02 §2).
 */
export const BOGOTA_TZ = 'America/Bogota';

const MS_PER_DAY = 86_400_000;
const MINUTES_PER_DAY = 1440;

/** Desfase (ms) del huso respecto a UTC en un instante dado. */
function tzOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const part of parts) {
    switch (part.type) {
      case 'year':
        year = Number(part.value);
        break;
      case 'month':
        month = Number(part.value);
        break;
      case 'day':
        day = Number(part.value);
        break;
      case 'hour':
        hour = Number(part.value);
        break;
      case 'minute':
        minute = Number(part.value);
        break;
      case 'second':
        second = Number(part.value);
        break;
      default:
        break;
    }
  }
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  return asUtc - instant.getTime();
}

/** Componentes de una fecha en Bogotá, derivados del calendario (sin husos). */
export interface Ymd {
  readonly year: number;
  readonly month: number; // 1–12
  readonly day: number; // 1–31
}

/** 'YYYY-MM-DD' → { year, month, day } si es una fecha real; si no, null. */
export function parseYmd(value: string): Ymd | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Verifica que el día exista de verdad (2026-02-30 no es fecha válida).
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day };
}

/** 'HH:MM' → { hour, minute } si es una hora real; si no, null. */
export function parseHm(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** Días desde la época de una fecha de calendario (comparable, sin husos). */
export function dayIndex(ymd: Ymd): number {
  return Math.floor(Date.UTC(ymd.year, ymd.month - 1, ymd.day) / MS_PER_DAY);
}

/** Días desde la época de un string 'YYYY-MM-DD'; null si no es fecha válida. */
export function dayIndexOf(value: string): number | null {
  const ymd = parseYmd(value);
  return ymd ? dayIndex(ymd) : null;
}

/** Día de la semana de una fecha de calendario: 0=domingo … 6=sábado. */
export function weekdayOf(value: string): number | null {
  const ymd = parseYmd(value);
  if (!ymd) return null;
  return new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day)).getUTCDay();
}

/** Fecha 'YYYY-MM-DD' desplazada N días (calendario puro, sin husos). */
export function addDays(date: string, days: number): string {
  const ymd = parseYmd(date);
  if (!ymd) throw new Error(`Fecha inválida: ${date}`);
  const shifted = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day + days));
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${String(shifted.getUTCFullYear()).padStart(4, '0')}-${month}-${day}`;
}

/** 'HH:MM' → minutos desde medianoche; null si no es hora válida. */
export function minutesOf(value: string): number | null {
  const hm = parseHm(value);
  return hm ? hm.hour * 60 + hm.minute : null;
}

/** Minutos desde medianoche → 'HH:MM' (acepta valores fuera de rango con rebose). */
export function formatMinutes(minutes: number): string {
  const normalized = ((Math.trunc(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hour = Math.floor(normalized / 60);
  const minute = normalized % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * Hora local en Bogotá (fecha + minutos desde medianoche) → instante UTC.
 * `minutes` puede exceder 1440 para referirse al día siguiente.
 */
export function bogotaWallToUtc(date: string, minutes: number): Date {
  const ymd = parseYmd(date);
  if (!ymd) throw new Error(`Fecha inválida: ${date}`);
  // Hora "naive" interpretada como UTC; luego resto el desfase real del huso.
  const naive = Date.UTC(ymd.year, ymd.month - 1, ymd.day, 0, minutes);
  let offset = tzOffsetMs(new Date(naive), BOGOTA_TZ);
  // Segunda pasada: necesaria si el desfase depende del instante (no en Bogotá, pero es correcto igual).
  offset = tzOffsetMs(new Date(naive - offset), BOGOTA_TZ);
  return new Date(naive - offset);
}

/** Instante UTC → componentes de la hora en Bogotá. */
export function utcToBogota(instant: Date): Ymd & { minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BOGOTA_TZ,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(instant);

  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  for (const part of parts) {
    switch (part.type) {
      case 'year':
        year = Number(part.value);
        break;
      case 'month':
        month = Number(part.value);
        break;
      case 'day':
        day = Number(part.value);
        break;
      case 'hour':
        hour = Number(part.value);
        break;
      case 'minute':
        minute = Number(part.value);
        break;
      default:
        break;
    }
  }
  return { year, month, day, minutes: hour * 60 + minute };
}

/** Fecha de una fecha en Bogotá como 'YYYY-MM-DD'. */
export function bogotaDateStr(instant: Date): string {
  const { year, month, day } = utcToBogota(instant);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Minutos desde medianoche en Bogotá de un instante UTC. */
export function bogotaMinutes(instant: Date): number {
  return utcToBogota(instant).minutes;
}
