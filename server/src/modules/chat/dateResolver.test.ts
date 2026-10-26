import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bogotaWallToUtc } from '../../core/time.js';
import { resolveSlot } from './dateResolver.js';

// 2026-11-10 es MARTES; 2026-11-14 es SÁBADO.
const TUESDAY_08 = bogotaWallToUtc('2026-11-10', 8 * 60);

test('"el sábado en la mañana" desde un martes → el sábado que viene a las 09:00', () => {
  const slot = resolveSlot({ dayRef: 'saturday', partOfDay: 'morning', now: TUESDAY_08 });
  assert.deepEqual(slot, { date: '2026-11-14', startTime: '09:00' });
});

test('"hoy" y "mañana" son literales', () => {
  assert.deepEqual(
    resolveSlot({ dayRef: 'today', partOfDay: 'morning', now: TUESDAY_08 }),
    { date: '2026-11-10', startTime: '09:00' },
  );
  assert.deepEqual(
    resolveSlot({ dayRef: 'tomorrow', partOfDay: 'afternoon', now: TUESDAY_08 }),
    { date: '2026-11-11', startTime: '14:00' },
  );
});

test('cada franja del día tiene su hora fija dentro del horario 7:00–21:00', () => {
  const cases = [
    ['morning', '09:00'],
    ['afternoon', '14:00'],
    ['evening', '18:00'],
    ['any', '10:00'],
  ] as const;
  for (const [partOfDay, startTime] of cases) {
    const slot = resolveSlot({ dayRef: 'friday', partOfDay, now: TUESDAY_08 });
    assert.equal(slot.startTime, startTime);
    assert.equal(slot.date, '2026-11-13', 'viernes que viene');
  }
});

test('si el día nombrado es HOY y la hora ya pasó, se va a la semana siguiente', () => {
  // Sábado a las 07:00 → el sábado a las 09:00 es todavía hoy.
  const earlySaturday = bogotaWallToUtc('2026-11-14', 7 * 60);
  assert.deepEqual(
    resolveSlot({ dayRef: 'saturday', partOfDay: 'morning', now: earlySaturday }),
    { date: '2026-11-14', startTime: '09:00' },
  );

  // Sábado a las 10:00 → la mañana de hoy ya pasó → sábado de la semana que viene.
  const lateSaturday = bogotaWallToUtc('2026-11-14', 10 * 60);
  assert.deepEqual(
    resolveSlot({ dayRef: 'saturday', partOfDay: 'morning', now: lateSaturday }),
    { date: '2026-11-21', startTime: '09:00' },
  );
});

test('"hoy" SÍ es literal: si la hora ya pasó se devuelve tal cual y el cotizador dirá in_past', () => {
  const evening = bogotaWallToUtc('2026-11-10', 20 * 60);
  assert.deepEqual(
    resolveSlot({ dayRef: 'today', partOfDay: 'evening', now: evening }),
    { date: '2026-11-10', startTime: '18:00' },
  );
});

test('los domingos también se resuelven (el cotizador es quien dirá que está cerrado)', () => {
  const slot = resolveSlot({ dayRef: 'sunday', partOfDay: 'any', now: TUESDAY_08 });
  assert.deepEqual(slot, { date: '2026-11-15', startTime: '10:00' });
});
