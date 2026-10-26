import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backoffMs, MAX_ATTEMPTS } from './worker.js';

test('backoff exponencial: 1×, 2×, 4×, 8× y 16× el retardo base', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((attempt) => backoffMs(attempt, 5_000)),
    [5_000, 10_000, 20_000, 40_000, 80_000],
  );
});

test('los intentos y el tope coinciden con el enunciado (5 intentos → failed)', () => {
  assert.equal(MAX_ATTEMPTS, 5);
  assert.equal(backoffMs(0, 1_000), 1_000, 'nunca baja del base');
  assert.equal(backoffMs(1, 1_000), 1_000);
  assert.equal(backoffMs(4, 1_000), 8_000);
});
