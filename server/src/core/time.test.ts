import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bogotaDateStr,
  bogotaMinutes,
  bogotaWallToUtc,
  dayIndexOf,
  formatMinutes,
  minutesOf,
  parseHm,
  parseYmd,
  utcToBogota,
  weekdayOf,
} from './time.js';

// Bogotá es UTC−5 sin horario de verano → 07:00 locales = 12:00 UTC.

test('bogotaWallToUtc convierte hora local a UTC (UTC−5)', () => {
  const instant = bogotaWallToUtc('2026-11-03', 7 * 60);
  assert.equal(instant.toISOString(), '2026-11-03T12:00:00.000Z');
});

test('utcToBogota devuelve la hora local de vuelta', () => {
  const parts = utcToBogota(new Date('2026-11-03T12:00:00.000Z'));
  assert.equal(parts.year, 2026);
  assert.equal(parts.month, 11);
  assert.equal(parts.day, 3);
  assert.equal(parts.minutes, 7 * 60);
});

test('ida y vuelta es estable', () => {
  const utc = bogotaWallToUtc('2026-11-07', 21 * 60);
  assert.equal(bogotaDateStr(utc), '2026-11-07');
  assert.equal(bogotaMinutes(utc), 21 * 60);
});

test('weekdayOf: sábado y domingo correctos', () => {
  assert.equal(weekdayOf('2026-11-07'), 6); // sábado
  assert.equal(weekdayOf('2026-11-08'), 0); // domingo
  assert.equal(weekdayOf('2026-11-02'), 1); // lunes
});

test('parseYmd acepta fechas reales y rechaza imposibles', () => {
  assert.ok(parseYmd('2026-11-03'));
  assert.equal(parseYmd('2026-02-30'), null); // febrero no tiene 30
  assert.equal(parseYmd('2026-13-01'), null); // mes 13
  assert.equal(parseYmd('3-11-2026'), null); // formato incorrecto
});

test('parseHm valida horas y minutos', () => {
  assert.deepEqual(parseHm('23:59'), { hour: 23, minute: 59 });
  assert.equal(parseHm('24:00'), null);
  assert.equal(parseHm('10:7'), null);
});

test('minutesOf / formatMinutes hacen ida y vuelta', () => {
  assert.equal(minutesOf('07:30'), 450);
  assert.equal(formatMinutes(450), '07:30');
  assert.equal(formatMinutes(1260), '21:00');
});

test('dayIndexOf: fechas en orden cronológico', () => {
  const monday = dayIndexOf('2026-11-02') as number;
  const tuesday = dayIndexOf('2026-11-03') as number;
  assert.equal(tuesday - monday, 1);
});
