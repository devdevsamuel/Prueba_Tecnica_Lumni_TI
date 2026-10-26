/**
 * Precios de la reserva: servicios adicionales y desglose congelado (puro).
 *
 * Decisión de ambigüedad (docs/01 §14.10): el PDF nombra "proyector" y "café"
 * sin importe → tarifa fija por reserva (proyector $10.000, café $5.000).
 * Siguen aplicándose las reglas del §14.3: los servicios entran en el `total`,
 * pero descuento y recargo se calculan solo sobre la tarifa horaria.
 */
import type { QuoteBreakdown } from '../quotes/quote.js';

export const SERVICE_CATALOG = [
  { code: 'projector', label: 'Proyector', price: 10_000 },
  { code: 'coffee', label: 'Café', price: 5_000 },
] as const;

export type ServiceCode = (typeof SERVICE_CATALOG)[number]['code'];

const SERVICE_CODES: ReadonlySet<string> = new Set(SERVICE_CATALOG.map((s) => s.code));

export function isServiceCode(value: string): value is ServiceCode {
  return SERVICE_CODES.has(value);
}

export function serviceLabel(code: ServiceCode): string {
  const found = SERVICE_CATALOG.find((service) => service.code === code);
  if (!found) throw new Error(`Servicio desconocido: ${code}`);
  return found.label;
}

/** Suma de los servicios elegidos. */
export function servicesTotal(codes: readonly ServiceCode[]): number {
  return codes.reduce((sum, code) => sum + servicePrice(code), 0);
}

export function servicePrice(code: ServiceCode): number {
  const found = SERVICE_CATALOG.find((service) => service.code === code);
  if (!found) throw new Error(`Servicio desconocido: ${code}`);
  return found.price;
}

/**
 * Recupera el código de un servicio a partir del concepto guardado (su etiqueta).
 * `booking_lines.concept` almacena la etiqueta legible y esta función invierte el
 * mapeo para restaurar los servicios al retomar el borrador.
 */
export function codeFromConcept(concept: string): ServiceCode | null {
  const found = SERVICE_CATALOG.find((service) => service.label === concept);
  return found ? found.code : null;
}

export type LineKind = 'base' | 'discount' | 'surcharge' | 'service';

export interface BookingLineDraft {
  readonly concept: string;
  readonly kind: LineKind;
  readonly amount: number;
}

/**
 * Desglose congelable de la reserva. **Los descuentos van en negativo** para
 * que `SUM(booking_lines.amount) = total` (lo exige la consulta de
 * inconsistencias de la Parte 3, docs/01 §11.4).
 */
export function buildLines(
  breakdown: QuoteBreakdown,
  services: readonly ServiceCode[],
): BookingLineDraft[] {
  const lines: BookingLineDraft[] = [
    { concept: 'Tarifa de la sala', kind: 'base', amount: breakdown.base },
  ];
  if (breakdown.discount !== 0) {
    lines.push({
      concept: `Descuento por duración (${breakdown.discountPercent} %)`,
      kind: 'discount',
      amount: -breakdown.discount,
    });
  }
  if (breakdown.surcharge !== 0) {
    lines.push({ concept: 'Recargo de sábado (25 %)', kind: 'surcharge', amount: breakdown.surcharge });
  }
  for (const code of services) {
    lines.push({ concept: serviceLabel(code), kind: 'service', amount: servicePrice(code) });
  }
  return lines;
}

/** Total de la reserva = tarifa horaria (ya con descuento/recargo) + servicios. */
export function computeTotal(breakdown: QuoteBreakdown, services: readonly ServiceCode[]): number {
  return breakdown.total + servicesTotal(services);
}
