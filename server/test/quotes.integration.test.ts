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
 * Tests de integración del cotizador (Fase 1): servidor REAL escuchando en un
 * puerto efímero + PostgreSQL real, usando `fetch` nativo (0 dependencias, docs/02 §3).
 *
 * Datos: se crea una sala de prueba propia y se borra al final, para no tocar
 * el seed ni ensuciar datos de desarrollo.
 */

// Reloj fijo: martes 2026-11-03 a las 08:00 en Bogotá. Así "futuro/pasado"
// es determinista y las reservas de las 10:00 siguen siendo "mañana".
const FIXED_NOW = bogotaWallToUtc('2026-11-03', 8 * 60);
const clock: Clock = { now: () => FIXED_NOW, sleep: async () => undefined };

const config = loadConfig(process.env);
let pool: Pool;
let server: Server | undefined;
let baseUrl: string;
let roomId: number;

// Nombre único por ejecución: si un run anterior quedó a medias, no choca.
const TEST_ROOM_NAME = `Sala Integ Test ${process.pid}`;

async function start(): Promise<void> {
  pool = createPool(config.databaseUrl);
  await migrate(pool); // idempotente

  // Limpieza defensiva de restos de runs anteriores con el mismo nombre.
  await pool.query('DELETE FROM bookings WHERE room_id IN (SELECT id FROM rooms WHERE name = $1)', [
    TEST_ROOM_NAME,
  ]);
  await pool.query('DELETE FROM rooms WHERE name = $1', [TEST_ROOM_NAME]);

  // Sala de prueba con tarifa conocida (40 000 COP/h).
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO rooms (name, size, capacity, hourly_rate)
     VALUES ($1, 'small', 4, 40000) RETURNING id`,
    [TEST_ROOM_NAME],
  );
  roomId = rows[0]!.id;

  // Reserva confirmada 10:00–11:00 ese martes, para probar disponibilidad.
  await pool.query(
    `INSERT INTO bookings (customer_name, customer_email, room_id, starts_at, ends_at, status, total)
     VALUES ('Test', 'test@x.com', $1, $2, $3, 'confirmed', 40000)`,
    [roomId, bogotaWallToUtc('2026-11-03', 10 * 60), bogotaWallToUtc('2026-11-03', 11 * 60)],
  );

  const app = createApp({ config, pool, clock });
  // La asignación va en el flujo directo (no dentro del callback) para que
  // TypeScript vea `server` como asignado y pueda tipar .address().
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function stop(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => {
      server!.close(() => resolve());
    });
  }
  // Borra en orden por la FK.
  await pool.query('DELETE FROM bookings WHERE room_id = $1', [roomId]);
  await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]);
  await pool.end();
}

before(async () => {
  await start();
});

after(async () => {
  await stop();
});

test('GET /api/rooms devuelve la sala creada', async () => {
  const response = await fetch(`${baseUrl}/api/rooms`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { rooms: Array<{ id: number; hourlyRate: number }> };
  const room = body.rooms.find((r) => r.id === roomId);
  assert.ok(room, 'la sala de prueba debe aparecer');
  assert.equal(room?.hourlyRate, 40_000);
});

test('POST /api/quotes cotiza un martes disponible', async () => {
  const response = await fetch(`${baseUrl}/api/quotes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomId, date: '2026-11-03', startTime: '13:00', durationMinutes: 120 }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    canBook: boolean;
    base: number;
    total: number;
    endTime: string;
  };
  assert.equal(body.canBook, true);
  assert.equal(body.base, 80_000); // 40 000 × 2 h
  assert.equal(body.total, 80_000); // sin descuento (< 4 h)
  assert.equal(body.endTime, '15:00');
});

test('POST /api/quotes devuelve 400 con entrada inválida', async () => {
  const response = await fetch(`${baseUrl}/api/quotes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomId, date: 'no-fecha', startTime: '25:99', durationMinutes: 10 }),
  });
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, 'validation_error');
});

test('POST /api/quotes → 404 si la sala no existe', async () => {
  const response = await fetch(`${baseUrl}/api/quotes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomId: 999999, date: '2026-11-03', startTime: '13:00', durationMinutes: 60 }),
  });
  assert.equal(response.status, 404);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, 'unknown_room');
});

test('POST /api/quotes → ocupado con sugerencia del mismo día', async () => {
  // 10:30–11:30 solapa con la reserva confirmada 10:00–11:00.
  const response = await fetch(`${baseUrl}/api/quotes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomId, date: '2026-11-03', startTime: '10:30', durationMinutes: 60 }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    canBook: boolean;
    reason: string | null;
    suggestedSlot: { date: string; startTime: string } | null;
  };
  assert.equal(body.canBook, false);
  assert.match(body.reason ?? '', /reservada/);
  assert.equal(body.suggestedSlot?.date, '2026-11-03');
  assert.equal(body.suggestedSlot?.startTime, '11:00');
});

test('POST /api/quotes → domingo cerrado', async () => {
  const response = await fetch(`${baseUrl}/api/quotes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomId, date: '2026-11-08', startTime: '10:00', durationMinutes: 60 }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { canBook: boolean; reason: string | null };
  assert.equal(body.canBook, false);
  assert.match(body.reason ?? '', /domingos/);
});
