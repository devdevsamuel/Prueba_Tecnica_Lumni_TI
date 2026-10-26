import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertTransition,
  canTransition,
  InvalidTransitionError,
  TRANSITIONS,
  type BookingStatus,
} from './state.js';

const ALL: readonly BookingStatus[] = ['draft', 'confirmed', 'completed', 'cancelled'];

const LEGAL: readonly (readonly [BookingStatus, BookingStatus])[] = [
  ['draft', 'confirmed'],
  ['draft', 'cancelled'],
  ['confirmed', 'completed'],
  ['confirmed', 'cancelled'],
];

test('las 4 transiciones legales del enunciado están permitidas', () => {
  for (const [from, to] of LEGAL) {
    assert.equal(canTransition(from, to), true, `${from} → ${to} debía ser legal`);
  }
});

test('toda transición fuera de esas 4 está rechazada', () => {
  const legalKeys = new Set(LEGAL.map(([from, to]) => `${from}->${to}`));
  for (const from of ALL) {
    for (const to of ALL) {
      const allowed = legalKeys.has(`${from}->${to}`);
      assert.equal(canTransition(from, to), allowed, `${from} → ${to} (esperado: ${allowed})`);
    }
  }
});

test('assertTransition lanza InvalidTransitionError en lo ilegal y no en lo legal', () => {
  assert.throws(() => assertTransition('draft', 'completed'), InvalidTransitionError);
  assert.throws(() => assertTransition('confirmed', 'draft'), InvalidTransitionError);
  assert.throws(() => assertTransition('completed', 'cancelled'), InvalidTransitionError);
  assert.throws(() => assertTransition('cancelled', 'confirmed'), InvalidTransitionError);
  assert.throws(() => assertTransition('confirmed', 'confirmed'), InvalidTransitionError);
  assert.doesNotThrow(() => assertTransition('draft', 'confirmed'));
  assert.doesNotThrow(() => assertTransition('confirmed', 'cancelled'));
});

test('los estados finales no tienen salida', () => {
  assert.deepEqual(TRANSITIONS.completed, []);
  assert.deepEqual(TRANSITIONS.cancelled, []);
});

test('el error lleva la transición intentada (útil para el mensaje 409)', () => {
  try {
    assertTransition('draft', 'completed');
    assert.fail('debía lanzar');
  } catch (error) {
    assert.ok(error instanceof InvalidTransitionError);
    assert.equal(error.from, 'draft');
    assert.equal(error.to, 'completed');
    assert.match(error.message, /draft → completed/);
  }
});
