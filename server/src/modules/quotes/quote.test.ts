import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  calculateBreakdown,
  discountPercentFor,
  findNextSlot,
  isValidDuration,
  overlapsStrictly,
  quote,
  type BusyInterval,
  type QuoteInput,
} from './quote.js';
import { dayIndexOf } from '../../core/time.js';

// 2026-11-03 es martes; 2026-11-07 sábado; 2026-11-08 domingo.
const TUESDAY = '2026-11-03';
const SATURDAY = '2026-11-07';
const SUNDAY = '2026-11-08';

const RATE_SMALL = 40_000;

/** Entrada por defecto: martes, hora futura, sin reservas. */
function makeInput(overrides: Partial<QuoteInput> = {}): QuoteInput {
  return {
    date: TUESDAY,
    startTime: '10:00',
    durationMinutes: 60,
    hourlyRate: RATE_SMALL,
    busy: [],
    nowMinutes: 7 * 60, // 07:00: cualquier hora posterior ya es "futuro"
    todayIndex: dayIndexOf(TUESDAY) as number,
    ...overrides,
  };
}

// ── Duración ────────────────────────────────────────────────────────────────

test('duración 0 h, 15 min y 45 min → rechazo', () => {
  for (const durationMinutes of [0, 15, 45]) {
    const result = quote(makeInput({ durationMinutes }));
    assert.equal(result.canBook, false, `duración ${durationMinutes} debía rechazarse`);
    assert.equal(result.reason, 'duration_invalid');
    assert.equal(result.breakdown, null);
  }
});

test('duración 30 min y 4,5 h (múltiplo de 30) → válidas', () => {
  for (const durationMinutes of [30, 270]) {
    const result = quote(makeInput({ durationMinutes }));
    assert.equal(result.canBook, true, `duración ${durationMinutes} debía ser válida`);
    assert.equal(result.reason, null);
  }
});

test('duración 11 h → rechazo (tope 10 h)', () => {
  const result = quote(makeInput({ durationMinutes: 11 * 60 }));
  assert.equal(result.canBook, false);
  assert.equal(result.reason, 'duration_invalid');
});

test('isValidDuration: múltiplos de 30 entre 30 y 600', () => {
  assert.equal(isValidDuration(30), true);
  assert.equal(isValidDuration(600), true);
  assert.equal(isValidDuration(29), false);
  assert.equal(isValidDuration(630), false);
  assert.equal(isValidDuration(45), false);
  assert.equal(isValidDuration(90.5), false);
});

// ── Bloques de 30 min ───────────────────────────────────────────────────────

test('inicio 10:07 (fuera de bloque) → rechazo', () => {
  const result = quote(makeInput({ startTime: '10:07' }));
  assert.equal(result.canBook, false);
  assert.equal(result.reason, 'not_in_slot');
});

// ── Horario de atención ─────────────────────────────────────────────────────

test('inicio 6:30 → rechazo (antes de abrir)', () => {
  const result = quote(makeInput({ startTime: '06:30' }));
  assert.equal(result.canBook, false);
  assert.equal(result.reason, 'before_open');
});

test('inicio 7:00 → válido', () => {
  const result = quote(makeInput({ startTime: '07:00' }));
  assert.equal(result.canBook, true);
});

test('que termine exactamente a las 21:00 → válido', () => {
  // 20:00 + 1 h = 21:00 exacto.
  const result = quote(makeInput({ startTime: '20:00', durationMinutes: 60 }));
  assert.equal(result.canBook, true);
});

test('que termine después de las 21:00 → rechazo (desborda el cierre)', () => {
  // Con bloques de 30 min, el primer fin imposible es 21:30 (20:30 + 1 h).
  // La regla rechaza cualquier fin > 21:00; el fin exacto 21:00 ya se prueba arriba.
  const result = quote(makeInput({ startTime: '20:30', durationMinutes: 60 }));
  assert.equal(result.canBook, false);
  assert.equal(result.reason, 'after_close');
});

test('domingo → cerrado', () => {
  const result = quote(makeInput({ date: SUNDAY, startTime: '10:00' }));
  assert.equal(result.canBook, false);
  assert.equal(result.reason, 'sunday_closed');
});

// ── Descuentos escalonados (no acumulativos) ────────────────────────────────

test('descuento escalonado: 3h30 0 %, 4h 10 %, 7h30 10 %, 8h 20 %, 10h 20 %', () => {
  assert.equal(discountPercentFor(210), 0); // 3 h 30
  assert.equal(discountPercentFor(240), 10); // 4 h
  assert.equal(discountPercentFor(450), 10); // 7 h 30
  assert.equal(discountPercentFor(480), 20); // 8 h
  assert.equal(discountPercentFor(600), 20); // 10 h
});

test('8 h aplica 20 % (no 10 % + 20 %)', () => {
  const breakdown = calculateBreakdown(480, RATE_SMALL, false);
  assert.equal(breakdown.base, 40_000 * 8);
  assert.equal(breakdown.discountPercent, 20);
  assert.equal(breakdown.discount, 40_000 * 8 * 0.2);
  // Total = base − descuento, sin recargo en día hábil.
  assert.equal(breakdown.total, 40_000 * 8 * 0.8);
});

// ── Recargo de sábado ───────────────────────────────────────────────────────

test('sábado: recargo = (base − descuento) × 1,25', () => {
  // 4 h de sábado → descuento 10 %, recargo 25 % sobre el valor ya descontado.
  const breakdown = calculateBreakdown(240, RATE_SMALL, true);
  assert.equal(breakdown.base, 40_000 * 4); // 160 000
  assert.equal(breakdown.discount, 16_000);
  assert.equal(breakdown.surcharge, (160_000 - 16_000) * 0.25); // 36 000
  assert.equal(breakdown.total, (160_000 - 16_000) * 1.25); // 180 000
});

test('sábado se detecta y el total aplica el recargo', () => {
  const result = quote(makeInput({ date: SATURDAY, startTime: '10:00', durationMinutes: 240 }));
  assert.equal(result.isSaturday, true);
  assert.equal(result.breakdown?.surcharge, (160_000 - 16_000) * 0.25);
  assert.equal(result.breakdown?.total, 180_000);
});

// ── Solape estricto ─────────────────────────────────────────────────────────

test('solape estricto: termina 10:00 / empieza 10:00 → NO se cruzan', () => {
  assert.equal(overlapsStrictly(600, 720, 720, 780), false);
  // Sí se cruzan si comparten un minuto.
  assert.equal(overlapsStrictly(600, 721, 720, 780), true);
});

// ── Disponibilidad y sugerencia ─────────────────────────────────────────────

test('horario ocupado → canBook=false + motivo + suggestedSlot del mismo día', () => {
  const busy: BusyInterval[] = [{ startMinutes: 600, endMinutes: 660 }]; // 10:00–11:00
  const result = quote(makeInput({ startTime: '10:00', durationMinutes: 60, busy }));
  assert.equal(result.canBook, false);
  assert.equal(result.reason, 'room_unavailable');
  assert.ok(result.suggestedSlot, 'debía sugerir un horario');
  assert.equal(result.suggestedSlot?.date, TUESDAY);
  assert.equal(result.suggestedSlot?.startTime, '11:00');
});

test('reserva pegada pero no solapada (10:00–11:00 libre tras 9:00–10:00) → válida', () => {
  const busy: BusyInterval[] = [{ startMinutes: 540, endMinutes: 600 }]; // 09:00–10:00
  const result = quote(makeInput({ startTime: '10:00', durationMinutes: 60, busy }));
  assert.equal(result.canBook, true);
});

test('sugerencia salta reservas y respeta el cierre', () => {
  // Ocupado 10:00–12:00; pido 10:00 dos horas → siguiente libre 12:00.
  const busy: BusyInterval[] = [{ startMinutes: 600, endMinutes: 720 }];
  const slot = findNextSlot(makeInput({ startTime: '10:00', durationMinutes: 120, busy }));
  assert.equal(slot?.startTime, '12:00');
});

test('no hay hueco antes del cierre → suggestedSlot null', () => {
  // Pido 19:00 + 4 h = 23:00, imposible; y ocupado el resto del día.
  const busy: BusyInterval[] = [{ startMinutes: 420, endMinutes: 1260 }];
  const slot = findNextSlot(makeInput({ startTime: '19:00', durationMinutes: 240, busy }));
  assert.equal(slot, null);
});

test('sugerencia en día futuro no se limita por la hora del reloj', () => {
  // "hoy" es un martes a las 15:00, pero pido el lunes siguiente (día futuro):
  // la sugerencia debe ser la primera hora hábil (07:00), sin recortar por "ahora".
  const futureMonday = '2026-11-09';
  const result = quote(
    makeInput({
      date: futureMonday,
      startTime: '06:30', // antes de abrir → before_open + sugerencia
      nowMinutes: 15 * 60, // el reloj marca 15:00, pero no es ese día
      todayIndex: dayIndexOf(TUESDAY) as number,
    }),
  );
  assert.equal(result.reason, 'before_open');
  assert.equal(result.suggestedSlot?.startTime, '07:00');
});

// ── Fecha en el pasado ──────────────────────────────────────────────────────

test('fecha anterior a hoy → rechazo', () => {
  const result = quote(makeInput({ date: '2026-11-02' })); // lunes anterior
  assert.equal(result.canBook, false);
  assert.equal(result.reason, 'in_past');
});

test('hora anterior a "ahora" el mismo día → rechazo', () => {
  const result = quote(makeInput({ startTime: '08:00', nowMinutes: 10 * 60 }));
  assert.equal(result.canBook, false);
  assert.equal(result.reason, 'in_past');
});

// ── Caso feliz completo ─────────────────────────────────────────────────────

test('martes 4 h en sala pequeña → desglose correcto y canBook', () => {
  const result = quote(makeInput({ startTime: '09:00', durationMinutes: 240 }));
  assert.equal(result.canBook, true);
  assert.equal(result.reason, null);
  assert.equal(result.breakdown?.base, 160_000);
  assert.equal(result.breakdown?.discountPercent, 10);
  assert.equal(result.breakdown?.discount, 16_000);
  assert.equal(result.breakdown?.surcharge, 0);
  assert.equal(result.breakdown?.total, 144_000);
  assert.equal(result.endTime, '13:00');
});
