import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, loadConfig } from './config.js';

const validEnv: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgresql://localhost:5432/coworking',
  SESSION_SECRET: 'a'.repeat(64),
  AI_API_KEY: 'oc_sk_prueba',
};

test('loadConfig aplica los defaults del enunciado', () => {
  const config = loadConfig(validEnv);
  assert.equal(config.port, 3000);
  assert.equal(config.tz, 'America/Bogota');
  assert.equal(config.ai.baseUrl, 'https://opencode.ai/inference/go/openai/v1');
  assert.equal(config.ai.model, 'glm-5.3-flash');
  assert.equal(config.ai.apiKey, 'oc_sk_prueba');
});

test('loadConfig lee las variables presentes', () => {
  const config = loadConfig({ ...validEnv, PORT: '4000', TZ: 'America/Bogota', AI_API_KEY: 'oc_sk_prueba' });
  assert.equal(config.port, 4000);
  assert.equal(config.ai.apiKey, 'oc_sk_prueba');
});

test('loadConfig rechaza SESSION_SECRET corto con mensaje claro', () => {
  assert.throws(
    () => loadConfig({ ...validEnv, SESSION_SECRET: 'corto' }),
    (error: unknown) => error instanceof ConfigError && /SESSION_SECRET/.test(error.message),
  );
});

test('loadConfig rechaza DATABASE_URL inválida', () => {
  assert.throws(
    () => loadConfig({ ...validEnv, DATABASE_URL: 'no-es-una-url' }),
    (error: unknown) => error instanceof ConfigError && /DATABASE_URL/.test(error.message),
  );
});

test('loadConfig rechaza PORT no numérico', () => {
  assert.throws(
    () => loadConfig({ ...validEnv, PORT: 'ochenta' }),
    (error: unknown) => error instanceof ConfigError && /PORT/.test(error.message),
  );
});

test('loadConfig exige AI_API_KEY desde la Fase 5', () => {
  const { AI_API_KEY: _omit, ...withoutKey } = validEnv;
  assert.throws(
    () => loadConfig(withoutKey),
    (error: unknown) => error instanceof ConfigError && /AI_API_KEY/.test(error.message),
  );
});

test('loadConfig aplica los defaults de recordatorios y login', () => {
  const config = loadConfig(validEnv);
  assert.equal(config.reminders.enabled, true);
  assert.equal(config.reminders.leadHours, 48);
  assert.equal(config.reminders.scanIntervalMs, 60_000);
  assert.equal(config.reminders.catchupHours, 24);
  assert.equal(config.login.maxAttempts, 5);
  assert.equal(config.login.windowMinutes, 15);
});

test('loadConfig permite desactivar recordatorios y ajustar el límite de login', () => {
  const config = loadConfig({
    ...validEnv,
    REMINDER_ENABLED: 'false',
    REMINDER_LEAD_HOURS: '72',
    LOGIN_MAX_ATTEMPTS: '3',
    LOGIN_WINDOW_MINUTES: '30',
  });
  assert.equal(config.reminders.enabled, false);
  assert.equal(config.reminders.leadHours, 72);
  assert.equal(config.login.maxAttempts, 3);
  assert.equal(config.login.windowMinutes, 30);
});
