import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateBreakdown } from '../quotes/quote.js';
import {
  buildLines,
  codeFromConcept,
  computeTotal,
  isServiceCode,
  servicesTotal,
} from './pricing.js';

test('servicios con tarifa fija por reserva (decisión docs/01 §14.10)', () => {
  assert.equal(servicesTotal([]), 0);
  assert.equal(servicesTotal(['projector']), 10_000);
  assert.equal(servicesTotal(['coffee']), 5_000);
  assert.equal(servicesTotal(['projector', 'coffee']), 15_000);
});

test('el total suma la tarifa horaria (con descuento/recargo) y los servicios', () => {
  const breakdown = calculateBreakdown(240, 40_000, false); // 4 h → 160 000 − 10 %
  assert.equal(breakdown.total, 144_000);
  assert.equal(computeTotal(breakdown, []), 144_000);
  assert.equal(computeTotal(breakdown, ['coffee']), 149_000);
  assert.equal(computeTotal(breakdown, ['projector', 'coffee']), 159_000);
});

test('los servicios NO participan en descuento ni recargo (01 §14.3)', () => {
  const breakdown = calculateBreakdown(480, 40_000, false); // 8 h → base 320 000, 20 %
  const services = servicesTotal(['projector']);

  // El descuento se calcula SOLO sobre la tarifa horaria (320 000), no sobre
  // la tarifa ya sumada con los servicios (330 000).
  assert.equal(breakdown.discount, 64_000);
  assert.equal(computeTotal(breakdown, ['projector']), breakdown.total + services);
  assert.equal(computeTotal(breakdown, ['projector']), 256_000 + services);
});

test('SUM(booking_lines) === total: el descuento se guarda en negativo', () => {
  const breakdown = calculateBreakdown(240, 40_000, true); // sábado: descuento + recargo
  const lines = buildLines(breakdown, ['projector', 'coffee']);
  const sum = lines.reduce((accumulator, line) => accumulator + line.amount, 0);
  assert.equal(sum, computeTotal(breakdown, ['projector', 'coffee']));

  const discount = lines.find((line) => line.kind === 'discount');
  assert.ok(discount, 'debe haber línea de descuento');
  assert.ok((discount?.amount ?? 0) < 0, 'el descuento debe ser negativo');
});

test('el desglose refleja las líneas esperadas', () => {
  const lines = buildLines(calculateBreakdown(240, 40_000, true), ['coffee']);
  assert.deepEqual(
    lines.map((line) => line.kind),
    ['base', 'discount', 'surcharge', 'service'],
  );
});

test('los servicios se recuperan desde el concepto guardado', () => {
  assert.equal(codeFromConcept('Proyector'), 'projector');
  assert.equal(codeFromConcept('Café'), 'coffee');
  assert.equal(codeFromConcept('Tarifa de la sala'), null);
  assert.equal(isServiceCode('projector'), true);
  assert.equal(isServiceCode('wifi'), false);
});
