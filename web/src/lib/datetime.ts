/**
 * Formateo de fecha y hora del negocio (America/Bogota, docs/05 §6).
 * Módulo neutral: lo usan el admin, la bandeja de correos y el chat.
 */
const BOGOTA_FORMAT = new Intl.DateTimeFormat('es-CO', {
  timeZone: 'America/Bogota',
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** ISO → "3 nov 2026, 9:00" (hora de Bogotá). */
export function formatBogota(iso: string | null, empty = 'Sin horario'): string {
  if (!iso) return empty;
  return BOGOTA_FORMAT.format(new Date(iso));
}

/** Ídem, con guion en lugar de texto por defecto (para columnas de tabla). */
export function formatBogotaFull(iso: string | null): string {
  return formatBogota(iso, '—');
}
