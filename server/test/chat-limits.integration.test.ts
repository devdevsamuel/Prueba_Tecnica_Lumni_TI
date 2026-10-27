import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Clock } from '../src/core/clock.js';
import { bogotaWallToUtc } from '../src/core/time.js';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import type { AiCompletion, AiClient, ChatTurn } from '../src/modules/chat/aiClient.js';
import { AiQuotaError } from '../src/modules/chat/aiClient.js';

/**
 * Integración de la Fase 5b: control de uso del asistente.
 *
 * Cubre las 4 capas que protegen la suscripción del proveedor:
 *  - límite por sesión (3/min y 5/24 h en este fichero, no 5/50, para no
 *    sembrar 50 filas en cada test),
 *  - presupuesto mensual global (activado aquí a 10 M tokens),
 *  - traducción de la cuota del proveedor a 429 propio,
 *  - trazabilidad (`usage`) persistida y expuesta en `GET /api/admin/chat/usage`.
 *
 * El modelo sigue siendo un doble: no puede haber una llamada real en un test
 * reproducible. Las sesiones de prueba usan ids `limits-test-*` para limpiar
 * SOLO lo propio (en la BD de desarrollo conviven conversaciones reales).
 */

const config = loadConfig({
  ...process.env,
  AI_MAX_PER_SESSION_MIN: '3',
  AI_MAX_PER_SESSION_DAY: '5',
  AI_MONTHLY_TOKEN_BUDGET: '10000000',
});

const FIXED_NOW = bogotaWallToUtc('2026-11-10', 8 * 60);
const clock: Clock = { now: () => FIXED_NOW, sleep: async () => undefined };

const BUDGET_REPLY = /límite de uso de este mes/;

/** Doble del modelo con cola de respuestas y errores (para el 429 del proveedor). */
class FakeAi implements AiClient {
  readonly turnsSeen: ChatTurn[][] = [];
  private queue: Array<string | Error> = [];

  enqueue(...values: Array<string | Error>): void {
    this.queue = [...values];
  }

  async complete(turns: readonly ChatTurn[], _sessionId: string): Promise<AiCompletion> {
    this.turnsSeen.push([...turns]);
    const next = this.queue.shift();
    if (next === undefined) throw new Error('FakeAi: no hay respuestas encoladas para este test.');
    if (next instanceof Error) throw next;
    return {
      content: next,
      usage: {
        promptTokens: 100,
        completionTokens: 40,
        reasoningTokens: 10,
        costUsd: 0.001,
        model: 'fake-model',
      },
    };
  }
}

const ASK = JSON.stringify({ action: 'ask', text: '¿Para cuántas personas es la sala?' });

const fakeAi = new FakeAi();
const createdShells: string[] = [];
let pool: Pool;
let server: Server | undefined;
let baseUrl: string;

async function post(body: unknown, cookie?: string): Promise<Response> {
  return fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}

/** Crea una conversación con id legible (text) para localizarla y limpiarla. */
async function createSession(id: string): Promise<void> {
  await pool.query('INSERT INTO chat_sessions (id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
}

/** Siembra mensajes de usuario con antigüedad controlada (ventanas móviles). */
async function seedUserMessages(id: string, count: number, minutesAgo: number): Promise<void> {
  await pool.query(
    `INSERT INTO chat_messages (session_id, role, content, created_at)
     SELECT $1, 'user', 'mensaje sembrado', now() - ($2 || ' minutes')::interval
       FROM generate_series(1, $3::int)`,
    [id, String(minutesAgo), count],
  );
}

async function login(email: string, password: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const header = response.headers.get('set-cookie') ?? '';
  const match = /sid=([^;]*)/.exec(header);
  if (!match) throw new Error(`No llegó Set-Cookie (HTTP ${response.status}): ${header}`);
  return `sid=${match[1]}`;
}

interface UsageItem {
  readonly sessionId: string;
  readonly role: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly reasoningTokens: number;
  readonly costUsd: number;
  readonly model: string | null;
}

interface UsageResponse {
  readonly summary: {
    readonly messages: number;
    readonly turns: number;
    readonly sessions: number;
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly reasoningTokens: number;
    readonly costUsd: number;
    readonly monthTokens: number;
    readonly monthBudget: number | null;
    readonly model: string;
  };
  readonly items: readonly UsageItem[];
  readonly page: number;
  readonly total: number;
  readonly totalPages: number;
}

before(async () => {
  pool = createPool(config.databaseUrl);
  await migrate(pool); // idempotente; aplica 0006 si falta

  // Solo residuos de este fichero (una corrida anterior interrumpida).
  await pool.query(`DELETE FROM chat_sessions WHERE id LIKE 'limits-test-%'`);

  const app = createApp({ config, pool, clock, ai: fakeAi });
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  await pool.query(`DELETE FROM chat_sessions WHERE id LIKE 'limits-test-%'`);
  // Sesiones con uuid que crea el propio POST (no se tocan las reales).
  for (const id of createdShells) {
    await pool.query('DELETE FROM chat_sessions WHERE id = $1', [id]);
  }
  await pool.query(
    `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email IN ('admin@coworking.test','cliente@coworking.test'))`,
  );
  await pool.end();
});

// ── Trazabilidad: el `usage` de cada llamada queda en el mensaje ────────────

test('USAGE: el consumo del modelo se persiste en el mensaje del asistente', async () => {
  fakeAi.enqueue(ASK);
  const response = await post({ content: 'Hola, quiero reservar una sala' });
  assert.equal(response.status, 200);

  const cookie = /chat_sid=([^;]*)/.exec(response.headers.get('set-cookie') ?? '');
  assert.ok(cookie, 'el primer mensaje debe crear la cookie de conversación');
  createdShells.push(cookie[1]!);

  const { rows } = await pool.query<{
    role: string;
    prompt_tokens: number;
    completion_tokens: number;
    reasoning_tokens: number;
    cost_usd: string;
    model: string | null;
  }>(
    `SELECT role, prompt_tokens, completion_tokens, reasoning_tokens, cost_usd, model
       FROM chat_messages
      WHERE session_id = $1 AND role = 'assistant'
      ORDER BY id DESC LIMIT 1`,
    [cookie[1]],
  );
  const row = rows[0];
  assert.ok(row, 'debe existir el mensaje del asistente');
  assert.equal(row.prompt_tokens, 100);
  assert.equal(row.completion_tokens, 40);
  assert.equal(row.reasoning_tokens, 10);
  assert.equal(Number(row.cost_usd), 0.001);
  assert.equal(row.model, 'fake-model');

  // El mensaje del usuario NO consume por sí solo (modelo NULL, 0 tokens).
  const user = await pool.query<{ prompt_tokens: number; model: string | null }>(
    `SELECT prompt_tokens, model FROM chat_messages
      WHERE role = 'user' AND session_id = $1
      ORDER BY id DESC LIMIT 1`,
    [cookie[1]],
  );
  assert.equal(user.rows[0]?.prompt_tokens, 0);
  assert.equal(user.rows[0]?.model, null);
});

test('USAGE: el reintento por esquema SUMA el consumo de las dos llamadas', async () => {
  await createSession('limits-test-retry');
  fakeAi.enqueue('esto no es json', ASK);

  const response = await post({ content: 'Quiero una sala' }, 'chat_sid=limits-test-retry');
  assert.equal(response.status, 200);
  assert.equal(fakeAi.turnsSeen.length >= 2, true);

  const { rows } = await pool.query<{ prompt_tokens: number; completion_tokens: number; cost_usd: string }>(
    `SELECT prompt_tokens, completion_tokens, cost_usd FROM chat_messages
      WHERE session_id = 'limits-test-retry' AND role = 'assistant'`,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.prompt_tokens, 200, '100 de la 1.ª llamada + 100 del reintento');
  assert.equal(rows[0]!.completion_tokens, 80);
  assert.equal(Number(rows[0]!.cost_usd), 0.002);
});

// ── Límite por sesión ───────────────────────────────────────────────────────

test('LÍMITE/minuto: 3 mensajes en un minuto → 429 rate_limited con Retry-After', async () => {
  await createSession('limits-test-minute');
  await seedUserMessages('limits-test-minute', 3, 0);
  const callsBefore = fakeAi.turnsSeen.length;

  const response = await post({ content: 'Un mensaje más' }, 'chat_sid=limits-test-minute');
  assert.equal(response.status, 429);
  const payload = (await response.json()) as { error: { code: string; message: string } };
  assert.equal(payload.error.code, 'rate_limited');
  assert.match(payload.error.message, /demasiados mensajes/i);

  const retryAfter = Number(response.headers.get('retry-after'));
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60, `Retry-After: ${retryAfter}`);
  assert.equal(fakeAi.turnsSeen.length, callsBefore, 'un 429 no debe llamar al modelo');

  // Nada nuevo persistido: el reintento posterior no duplicará el mensaje.
  const count = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM chat_messages WHERE session_id = 'limits-test-minute'`,
  );
  assert.equal(count.rows[0]?.n, '3');
});

test('LÍMITE/día: 5 mensajes en 24 h → 429 rate_limited (aunque no haya ráfaga)', async () => {
  await createSession('limits-test-day');
  // Hace 2 minutos: fuera de la ventana de 1 minuto, dentro de la de 24 h.
  await seedUserMessages('limits-test-day', 5, 2);
  const callsBefore = fakeAi.turnsSeen.length;

  const response = await post({ content: 'Otro mensaje' }, 'chat_sid=limits-test-day');
  assert.equal(response.status, 429);
  const payload = (await response.json()) as { error: { code: string; message: string } };
  assert.equal(payload.error.code, 'rate_limited');
  assert.match(payload.error.message, /límite diario/i);

  const retryAfter = Number(response.headers.get('retry-after'));
  assert.ok(retryAfter > 60, `el reintento es en horas, no en segundos (Retry-After: ${retryAfter})`);
  assert.equal(fakeAi.turnsSeen.length, callsBefore, 'un 429 no debe llamar al modelo');
});

// ── Cuota del proveedor (429/402) ───────────────────────────────────────────

test('CUOTA: el 429 del proveedor se traduce a 429 ai_quota propio', async () => {
  await createSession('limits-test-quota');
  fakeAi.enqueue(new AiQuotaError('El proveedor de IA ha agotado la cuota (429): plan agotado'));

  const response = await post({ content: '¿Hay salas mañana?' }, 'chat_sid=limits-test-quota');
  assert.equal(response.status, 429);
  const payload = (await response.json()) as { error: { code: string; message: string } };
  assert.equal(payload.error.code, 'ai_quota');
  assert.match(payload.error.message, /límite de uso del servicio/i);
  assert.equal(response.headers.get('retry-after'), '3600');

  // El mensaje del usuario no queda colgado sin respuesta: no se persiste nada.
  const count = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM chat_messages WHERE session_id = 'limits-test-quota'`,
  );
  assert.equal(count.rows[0]?.n, '0');
});

// ── Trazabilidad en el panel ────────────────────────────────────────────────

test('ADMIN: GET /api/admin/chat/usage exige sesión y rol admin', async () => {
  const anonymous = await fetch(`${baseUrl}/api/admin/chat/usage`);
  assert.equal(anonymous.status, 401);

  const client = await login('cliente@coworking.test', 'coworking2026');
  const forbidden = await fetch(`${baseUrl}/api/admin/chat/usage`, { headers: { Cookie: client } });
  assert.equal(forbidden.status, 403);
});

test('ADMIN: la trazabilidad devuelve totales y el turno con su consumo', async () => {
  await createSession('limits-test-admin');
  fakeAi.enqueue(ASK);
  const chat = await post({ content: 'Hola' }, 'chat_sid=limits-test-admin');
  assert.equal(chat.status, 200);

  const admin = await login('admin@coworking.test', 'coworking2026');
  // La BD de desarrollo tiene conversaciones reales: se busca ESTA sesión en la
  // primera página (es la más reciente) y no se asume una tabla vacía.
  const response = await fetch(`${baseUrl}/api/admin/chat/usage?page=1&pageSize=100`, {
    headers: { Cookie: admin },
  });
  assert.equal(response.status, 200);
  const data = (await response.json()) as UsageResponse;

  assert.equal(data.summary.model, config.ai.model);
  assert.equal(data.summary.monthBudget, 10_000_000);
  assert.ok(data.summary.turns >= 1);
  assert.ok(data.summary.promptTokens >= 100);
  assert.ok(data.summary.monthTokens >= 140);
  assert.ok(data.total >= 2);

  const mine = data.items.filter((item) => item.sessionId === 'limits-test-admin');
  assert.equal(mine.length, 2, 'mensaje de usuario + respuesta del asistente');
  const assistant = mine.find((item) => item.role === 'assistant');
  assert.ok(assistant, 'el turno del asistente debe aparecer');
  assert.equal(assistant.promptTokens, 100);
  assert.equal(assistant.completionTokens, 40);
  assert.equal(assistant.reasoningTokens, 10);
  assert.equal(assistant.model, 'fake-model');
  assert.equal(mine.find((item) => item.role === 'user')?.model, null);

  // Página fuera de rango: el total sigue siendo el global (no 0).
  const outOfRange = await fetch(`${baseUrl}/api/admin/chat/usage?page=999&pageSize=100`, {
    headers: { Cookie: admin },
  });
  assert.equal(outOfRange.status, 200);
  const outData = (await outOfRange.json()) as UsageResponse;
  assert.equal(outData.total, data.total);
  assert.equal(outData.items.length, 0);
  assert.equal(outData.totalPages, Math.ceil(data.total / 100));
});

test('ADMIN: paginación y sesión inválidas → 400', async () => {
  const admin = await login('admin@coworking.test', 'coworking2026');
  const badPage = await fetch(`${baseUrl}/api/admin/chat/usage?page=0`, { headers: { Cookie: admin } });
  assert.equal(badPage.status, 400);
  const badSize = await fetch(`${baseUrl}/api/admin/chat/usage?pageSize=500`, { headers: { Cookie: admin } });
  assert.equal(badSize.status, 400);
});

// ── Presupuesto mensual (va al final: deja el mes "agotado") ────────────────

test('PRESUPUESTO: agotado → responde fijo SIN llamar al modelo', async () => {
  await createSession('limits-test-budget');
  // Un turno ya consumió gran parte del presupuesto: la suma del mes lo supera.
  await pool.query(
    `INSERT INTO chat_messages (session_id, role, content, prompt_tokens, completion_tokens, model)
     VALUES ('limits-test-budget', 'assistant', 'turno previo', 20000000, 1, 'fake-model')`,
  );
  const callsBefore = fakeAi.turnsSeen.length;

  try {
    const response = await post({ content: '¿Y una sala para el viernes?' }, 'chat_sid=limits-test-budget');
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { messages: Array<{ role: string; content: string }> };
    const last = payload.messages.at(-1);
    assert.equal(last?.role, 'assistant');
    assert.match(String(last?.content), BUDGET_REPLY);
    assert.equal(fakeAi.turnsSeen.length, callsBefore, 'el presupuesto corta ANTES del modelo');

    // Queda constancia en la conversación (y en la trazabilidad del admin).
    const rows = await pool.query<{ role: string }>(
      `SELECT role FROM chat_messages WHERE session_id = 'limits-test-budget' ORDER BY id`,
    );
    assert.deepEqual(
      rows.rows.map((row) => row.role),
      ['assistant', 'user', 'assistant'],
    );
  } finally {
    await pool.query(`DELETE FROM chat_messages WHERE session_id = 'limits-test-budget'`);
  }
});
