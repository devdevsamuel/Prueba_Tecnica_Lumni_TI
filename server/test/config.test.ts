import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, loadConfig } from '../src/config.js';

/**
 * Configuración del control de uso del asistente (Fase 5b). `loadConfig` es
 * puro (recibe el env), así que se prueba sin arrancar el servidor ni tocar la BD.
 */

/** Env mínimo válido: lo demás son defaults. */
function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgresql://localhost:5432/coworking',
    SESSION_SECRET: 'x'.repeat(32),
    AI_API_KEY: 'oc_sk_test',
    ...overrides,
  };
}

test('config: límites del chat con valores por defecto', () => {
  const config = loadConfig(env());
  assert.equal(config.ai.maxTokens, 4_000);
  assert.equal(config.ai.limits.perMinute, 5);
  assert.equal(config.ai.limits.perDay, 50);
  assert.equal(config.ai.limits.monthlyTokenBudget, undefined, 'sin presupuesto por defecto');
});

test('config: presupuesto vacío = sin límite; con número = activo', () => {
  assert.equal(
    loadConfig(env({ AI_MONTHLY_TOKEN_BUDGET: '' })).ai.limits.monthlyTokenBudget,
    undefined,
  );
  assert.equal(
    loadConfig(env({ AI_MONTHLY_TOKEN_BUDGET: '250000' })).ai.limits.monthlyTokenBudget,
    250_000,
  );
});

test('config: límites personalizados se respetan', () => {
  const config = loadConfig(
    env({
      AI_MAX_TOKENS: '8000',
      AI_MAX_PER_SESSION_MIN: '2',
      AI_MAX_PER_SESSION_DAY: '10',
    }),
  );
  assert.equal(config.ai.maxTokens, 8_000);
  assert.equal(config.ai.limits.perMinute, 2);
  assert.equal(config.ai.limits.perDay, 10);
});

test('config: un presupuesto no numérico falla al arrancar', () => {
  assert.throws(
    () => loadConfig(env({ AI_MONTHLY_TOKEN_BUDGET: 'muchos' })),
    (error: unknown) => error instanceof ConfigError && /AI_MONTHLY_TOKEN_BUDGET/.test(error.message),
  );
});

test('config: la conexión del migrador cae a DATABASE_URL si no se define', () => {
  const config = loadConfig(env());
  assert.equal(config.migratorDatabaseUrl, config.databaseUrl);
});

test('config: MIGRATOR_DATABASE_URL permite separar DDL de DML', () => {
  const config = loadConfig(
    env({ MIGRATOR_DATABASE_URL: 'postgresql://owner@localhost:5432/coworking' }),
  );
  assert.equal(config.migratorDatabaseUrl, 'postgresql://owner@localhost:5432/coworking');
  assert.equal(config.databaseUrl, 'postgresql://localhost:5432/coworking');
});

test('config: una MIGRATOR_DATABASE_URL inválida falla al arrancar', () => {
  assert.throws(
    () => loadConfig(env({ MIGRATOR_DATABASE_URL: 'no-es-una-url' })),
    (error: unknown) => error instanceof ConfigError && /MIGRATOR_DATABASE_URL/.test(error.message),
  );
});
