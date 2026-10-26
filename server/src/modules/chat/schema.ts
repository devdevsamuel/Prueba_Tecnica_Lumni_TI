import { z } from 'zod';

/**
 * Esquema de la salida del modelo (docs/01 §9, docs/03 §6.2).
 *
 * Este enum **es** la garantía de la regla 3: no existe `confirm`, `cancel` ni
 * ninguna acción que lea reservas ajenas, así que el chat no puede llegar ahí
 * aunque el modelo lo pidiera. Y como el precio no está en el esquema (regla 1),
 * ningún número del modelo se confía: lo calcula siempre `quote()`.
 *
 * Las fechas NO las decide el modelo: solo clasifica (`dayRef`/`partOfDay`) y el
 * `dateResolver` convierte esa clasificación en fecha/hora concreta en código.
 */

export const DAY_REFS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'today',
  'tomorrow',
] as const;

export const PARTS_OF_DAY = ['morning', 'afternoon', 'evening', 'any'] as const;

/** Horas concretas a las que se concreta cada franja del día (07:00–21:00). */
export const PART_START_TIME: Record<(typeof PARTS_OF_DAY)[number], string> = {
  morning: '09:00',
  afternoon: '14:00',
  evening: '18:00',
  any: '10:00',
};

/** Campos comunes a las acciones que necesitan un hueco de sala. */
const SlotFields = {
  roomId: z.number().int('roomId debe ser un entero').positive(),
  dayRef: z.enum(DAY_REFS),
  partOfDay: z.enum(PARTS_OF_DAY),
  durationMinutes: z.number().int('durationMinutes debe ser entero'),
};

export const SERVICE_CODES = ['projector', 'coffee'] as const;

export type ServiceCode = (typeof SERVICE_CODES)[number];

/**
 * Único conjunto de acciones que el asistente puede emitir.
 * `z.discriminatedUnion` sobre `action` rechaza cualquier valor fuera del enum
 * (p. ej. `{"action":"confirm"}`), que es exactamente el test de inyección.
 */
export const AssistantActionSchema = z.discriminatedUnion('action', [
  /** Necesita un dato que falta: el backend solo acepta lo que ya validó. */
  z.object({
    action: z.literal('ask'),
    text: z.string().min(1).max(1000),
  }),
  /** Cotización: el backend ejecuta el cotizador REAL con estos parámetros. */
  z.object({ action: z.literal('quote'), ...SlotFields }),
  /** Alternativa propuesta: el hueco lo termina de calcular el backend. */
  z.object({ action: z.literal('suggest'), ...SlotFields }),
  /** Crea el borrador relleno; confirmarlo es un botón fuera del chat. */
  z.object({
    action: z.literal('create_draft'),
    ...SlotFields,
    services: z.array(z.enum(SERVICE_CODES)).default([]),
    customerName: z.string().trim().min(1).max(120).optional(),
    customerEmail: z.email('customerEmail debe ser un correo válido').optional(),
  }),
]);

export type AssistantAction = z.infer<typeof AssistantActionSchema>;

/**
 * Extrae y valida la acción de la respuesta cruda del modelo. Rechaza fences de
 * Markdown (` ```json `) y cualquier cosa fuera del esquema.
 */
export function parseAssistantAction(raw: string): AssistantAction {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  const jsonish = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  return parseActionValue(JSON.parse(jsonish));
}

/** Valida un valor ya parseado (respuesta del modelo o acción guardada en BD). */
export function parseActionValue(value: unknown): AssistantAction {
  return AssistantActionSchema.parse(value);
}
