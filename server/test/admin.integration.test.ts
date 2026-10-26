import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Pool } from 'pg';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Clock } from '../src/core/clock.js';
import { bogotaWallToUtc } from '../src/core/time.js';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';

/**
 * Integración de la Fase 3: sesión real (login/logout/revocación) y panel de
 * admin. Cubre los 3 códigos del contrato (docs/01 §2.3):
 * 401 sin sesión · 403 con cliente · 400 con filtros inválidos.
 */

// Reloj fijo: martes 2026-11-10 a las 08:00 en Bogotá.
const FIXED_NOW = bogotaWallToUtc('2026-11-10', 8 * 60);
const clock: Clock = { now: () => FIXED_NOW, sleep: async () => undefined };
const DAY = '2026-11-10';

const ADMIN = { email: 'admin@coworking.test', password: 'coworking2026' };
const CLIENT = { email: 'cliente@coworking.test', password: 'coworking2026' };
const WRONG = { email: 'admin@coworking.test', password: 'otra-contraseña' };

const config = loadConfig(process.env);
let pool: Pool;
let server: Server | undefined;
let baseUrl: string;
let roomA: number;
let roomB: number;

// Dominio de correo propio de este archivo: el test de reservas usa otro, así
// que sus limpiezas no se pisan aunque los dos archivos corran en paralelo.
const EMAIL_DOMAIN = '@prueba-admin.com';

const ROOM_A = `Sala Admin A ${process.pid}`;
const ROOM_B = `Sala Admin B ${process.pid}`;

interface Failure {
  readonly error: { readonly code: string; readonly message: string; readonly details?: unknown };
}
interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
}
interface Listed {
  readonly items: readonly { readonly id: number; readonly status: string }[];
  readonly total: number;
  readonly page: number;
  readonly totalPages: number;
}

function failed(response: ApiResponse): Failure {
  const body = response.body;
  if (typeof body !== 'object' || body === null || !('error' in body)) {
    throw new Error('Se esperaba una respuesta de error.');
  }
  return body as Failure;
}

function listed(response: ApiResponse): Listed {
  const body = response.body;
  if (typeof body !== 'object' || body === null || !('items' in body)) {
    throw new Error('Se esperaba un listado.');
  }
  return body as Listed;
}

async function request(path: string, options: RequestInit = {}, cookie?: string): Promise<ApiResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as unknown) : undefined };
}

/** Devuelve la cabecera `Cookie` de una sesión iniciada (o lanza). */
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

async function insertBooking(
  roomId: number,
  status: string,
  startHour: number,
): Promise<void> {
  const start = bogotaWallToUtc(DAY, startHour * 60);
  const end = bogotaWallToUtc(DAY, startHour * 60 + 60);
  await pool.query(
    `INSERT INTO bookings (customer_name, customer_email, room_id, starts_at, ends_at, status, total)
     VALUES ($1, $2, $3, $4, $5, $6, 40000)`,
    [`Cliente ${status}`, `prueba${startHour}${status}${EMAIL_DOMAIN}`, roomId, start, end, status],
  );
}

before(async () => {
  pool = createPool(config.databaseUrl);
  await migrate(pool); // idempotente

  // Limpieza defensiva: también de ejecuciones anteriores (los nombres llevaban
  // pid, así que sin el patrón quedarían salas huérfanas).
  await pool.query('DELETE FROM bookings WHERE customer_email LIKE $1', [`%${EMAIL_DOMAIN}`]);
  await pool.query(`DELETE FROM bookings WHERE room_id IN (SELECT id FROM rooms WHERE name LIKE 'Sala Admin %')`);
  await pool.query(`DELETE FROM rooms WHERE name LIKE 'Sala Admin %'`);

  const insertedA = await pool.query<{ id: number }>(
    `INSERT INTO rooms (name, size, capacity, hourly_rate) VALUES ($1,'small',4,40000) RETURNING id`,
    [ROOM_A],
  );
  const insertedB = await pool.query<{ id: number }>(
    `INSERT INTO rooms (name, size, capacity, hourly_rate) VALUES ($1,'medium',8,70000) RETURNING id`,
    [ROOM_B],
  );
  roomA = insertedA.rows[0]!.id;
  roomB = insertedB.rows[0]!.id;

  // Sala A: 3 confirmed, 2 draft, 1 cancelled · Sala B: 1 confirmed → 7 en total.
  await insertBooking(roomA, 'confirmed', 8);
  await insertBooking(roomA, 'confirmed', 10);
  await insertBooking(roomA, 'confirmed', 14);
  await insertBooking(roomA, 'draft', 16);
  await insertBooking(roomA, 'draft', 18);
  await insertBooking(roomA, 'cancelled', 20);
  await insertBooking(roomB, 'confirmed', 9);

  const app = createApp({ config, pool, clock });
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  await pool.query('DELETE FROM bookings WHERE customer_email LIKE $1', [`%${EMAIL_DOMAIN}`]);
  await pool.query(`DELETE FROM bookings WHERE room_id IN (SELECT id FROM rooms WHERE name LIKE 'Sala Admin %')`);
  await pool.query(`DELETE FROM rooms WHERE name LIKE 'Sala Admin %'`);
  // Los logins de prueba crean sesiones: se retiran para no dejar residuos.
  await pool.query(
    `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email IN ('admin@coworking.test','cliente@coworking.test'))`,
  );
  await pool.end();
});

test('login con el admin sembrado crea sesión válida', async () => {
  const cookie = await login(ADMIN.email, ADMIN.password);
  const me = await request('/api/auth/me', {}, cookie);
  assert.equal(me.status, 200);
  assert.equal((me.body as { user: { role: string } }).user.role, 'admin');
});

test('contraseña incorrecta → 401 (mismo mensaje que usuario inexistente)', async () => {
  const wrong = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(WRONG),
  });
  assert.equal(wrong.status, 401);
  const body = (await wrong.json()) as Failure;
  assert.equal(body.error.code, 'invalid_credentials');

  const unknown = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'nadie@ejemplo.com', password: 'x' }),
  });
  assert.equal(unknown.status, 401);
  const unknownBody = (await unknown.json()) as Failure;
  assert.equal(unknownBody.error.message, body.error.message, 'no debe revelar si existe la cuenta');
});

test('GET /api/auth/me sin sesión → 401', async () => {
  const response = await request('/api/auth/me');
  assert.equal(response.status, 401);
  assert.equal(failed(response).error.code, 'unauthorized');
});

test('401 en /api/admin/* sin sesión', async () => {
  for (const path of ['/api/admin/bookings', '/api/admin/bookings/1', '/api/admin/bookings/1/cancel']) {
    const response = await request(path, { method: path.endsWith('cancel') ? 'POST' : 'GET' }, undefined);
    assert.equal(response.status, 401, `${path} debía devolver 401`);
  }
});

test('403 cuando el cliente intenta acceder al admin', async () => {
  const cookie = await login(CLIENT.email, CLIENT.password);
  const response = await request('/api/admin/bookings', {}, cookie);
  assert.equal(response.status, 403);
  assert.equal(failed(response).error.code, 'forbidden');
});

test('400 con status o room inválidos', async () => {
  const cookie = await login(ADMIN.email, ADMIN.password);

  const badStatus = await request('/api/admin/bookings?status=inventado', {}, cookie);
  assert.equal(badStatus.status, 400);
  assert.equal(failed(badStatus).error.code, 'validation_error');

  const badRoom = await request('/api/admin/bookings?room=abc', {}, cookie);
  assert.equal(badRoom.status, 400);

  const badPage = await request('/api/admin/bookings?page=0', {}, cookie);
  assert.equal(badPage.status, 400);
});

test('el listado pagina y filtra por estado y sala', async () => {
  const cookie = await login(ADMIN.email, ADMIN.password);

  // Los archivos de test corren en paralelo sobre la misma BD: se acotan las
  // cifras exactas a las salas de ESTE archivo y lo global se afirma como mínimo.
  const all = await request('/api/admin/bookings?pageSize=100', {}, cookie);
  assert.equal(all.status, 200);
  assert.ok(listed(all).total >= 7, 'al menos las 7 reservas propias');

  const confirmedGlobal = await request('/api/admin/bookings?status=confirmed&pageSize=100', {}, cookie);
  assert.ok(
    listed(confirmedGlobal).total >= 4,
    'al menos las 4 confirmadas propias (otras pruebas añaden más)',
  );
  assert.ok(
    listed(confirmedGlobal).items.every((item) => item.status === 'confirmed'),
    'el filtro de estado no debe colar otras filas',
  );

  const confirmedA = await request(
    `/api/admin/bookings?status=confirmed&room=${roomA}&pageSize=100`,
    {},
    cookie,
  );
  assert.equal(listed(confirmedA).total, 3, 'las 3 confirmadas de la sala A');

  const roomFiltered = await request(`/api/admin/bookings?room=${roomA}&pageSize=100`, {}, cookie);
  assert.equal(listed(roomFiltered).total, 6, 'la sala B queda fuera');

  const combined = await request(`/api/admin/bookings?room=${roomA}&status=confirmed&pageSize=100`, {}, cookie);
  assert.equal(listed(combined).total, 3);

  const paged = await request('/api/admin/bookings?pageSize=2&page=2', {}, cookie);
  assert.equal(paged.status, 200);
  assert.equal(listed(paged).page, 2);
  assert.equal(listed(paged).items.length, 2);
  assert.equal(listed(paged).totalPages, Math.ceil(listed(paged).total / 2));
});

test('el detalle devuelve la reserva con sus líneas', async () => {
  const cookie = await login(ADMIN.email, ADMIN.password);
  const list = await request(
    `/api/admin/bookings?status=confirmed&room=${roomA}&pageSize=1`,
    {},
    cookie,
  );
  const first = listed(list).items[0];
  assert.ok(first, 'debe haber al menos una reserva confirmada');

  const detail = await request(`/api/admin/bookings/${first.id}`, {}, cookie);
  assert.equal(detail.status, 200);
  const body = detail.body as { id: number; status: string; lines: unknown[] };
  assert.equal(body.id, first.id);
  assert.equal(body.status, 'confirmed');
  assert.ok(Array.isArray(body.lines));
});

test('cancelar desde el admin exige motivo', async () => {
  const cookie = await login(ADMIN.email, ADMIN.password);
  const list = await request(`/api/admin/bookings?status=draft&room=${roomA}&pageSize=1`, {}, cookie);
  const draft = listed(list).items[0];
  assert.ok(draft, 'debe haber un borrador de prueba');

  const noReason = await request(`/api/admin/bookings/${draft.id}/cancel`, { method: 'POST', body: '{}' }, cookie);
  assert.equal(noReason.status, 400);
  assert.equal(failed(noReason).error.code, 'validation_error');

  const cancelled = await request(
    `/api/admin/bookings/${draft.id}/cancel`,
    { method: 'POST', body: JSON.stringify({ reason: 'Cancelado desde el panel' }) },
    cookie,
  );
  assert.equal(cancelled.status, 200);
  assert.equal((cancelled.body as { status: string }).status, 'cancelled');
  assert.equal((cancelled.body as { cancelReason: string }).cancelReason, 'Cancelado desde el panel');
});

test('logout revoca la sesión en el servidor (no solo en el cliente)', async () => {
  const cookie = await login(ADMIN.email, ADMIN.password);
  assert.equal((await request('/api/auth/me', {}, cookie)).status, 200);

  const logout = await request('/api/auth/logout', { method: 'POST' }, cookie);
  assert.equal(logout.status, 200);

  // La cookie sigue existiendo, pero la fila se borró → ya no sirve.
  assert.equal((await request('/api/auth/me', {}, cookie)).status, 401, 'la sesión debe quedar revocada');
  assert.equal((await request('/api/admin/bookings', {}, cookie)).status, 401);
});

test('una cookie manipulada o fabricada se rechaza', async () => {
  const valid = await login(ADMIN.email, ADMIN.password);
  const [payload, signature] = valid.slice('sid='.length).split('.');

  const tamperedSignature = `sid=${payload}.${(signature ?? '').slice(0, -1)}X`;
  assert.equal((await request('/api/admin/bookings', {}, tamperedSignature)).status, 401);

  const forged = `sid=${Buffer.from('no-existe').toString('base64url')}.firma-fabricada`;
  assert.equal((await request('/api/admin/bookings', {}, forged)).status, 401);

  const malformed = 'sid=sin-firma';
  assert.equal((await request('/api/admin/bookings', {}, malformed)).status, 401);
});
