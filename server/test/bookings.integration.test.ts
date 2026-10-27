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
import type { BookingView } from '../src/modules/bookings/service.js';

/**
 * Integración de la Fase 2: servidor real en puerto efímero + PostgreSQL real
 * con `fetch` nativo (0 dependencias). Cubre las dos garantías del enunciado:
 * idempotencia (no duplica ni recalcula) y concurrencia (solo uno confirma).
 */

// Reloj fijo: miércoles 2026-11-04 a las 08:00 en Bogotá → las 09:00 son "futuro".
const FIXED_NOW = bogotaWallToUtc('2026-11-04', 8 * 60);
const clock: Clock = { now: () => FIXED_NOW, sleep: async () => undefined };
const DATE = '2026-11-04';

const config = loadConfig(process.env);
let pool: Pool;
let server: Server | undefined;
let baseUrl: string;
let roomId: number;

const TEST_ROOM_NAME = `Sala Booking Test ${process.pid}`;

interface Failure {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: { readonly suggestedSlot?: { readonly date: string; readonly startTime: string } };
  };
}

interface ApiResponse {
  readonly status: number;
  readonly body: BookingView | Failure;
}

function ok(response: ApiResponse): BookingView {
  const body = response.body;
  if ('error' in body) throw new Error(`Se esperaba éxito y llegó ${body.error.code}: ${body.error.message}`);
  return body;
}

function failed(response: ApiResponse): Failure {
  const body = response.body;
  if (!('error' in body)) throw new Error('Se esperaba una respuesta de error.');
  return body;
}

async function post(path: string, body: unknown): Promise<ApiResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as BookingView | Failure };
}

async function get(path: string): Promise<ApiResponse> {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, body: (await response.json()) as BookingView | Failure };
}

async function countBookings(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>('SELECT count(*) FROM bookings');
  return Number(rows[0]!.count);
}

before(async () => {
  pool = createPool(config.databaseUrl);
  await migrate(pool); // idempotente

  await pool.query('DELETE FROM bookings WHERE room_id IN (SELECT id FROM rooms WHERE name = $1)', [
    TEST_ROOM_NAME,
  ]);
  await pool.query('DELETE FROM rooms WHERE name = $1', [TEST_ROOM_NAME]);

  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO rooms (name, size, capacity, hourly_rate) VALUES ($1, 'small', 4, 40000) RETURNING id`,
    [TEST_ROOM_NAME],
  );
  roomId = rows[0]!.id;

  const app = createApp({ config, pool, clock });
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  // Los borradores sin sala tienen room_id = NULL y NO los alcanza un filtro por
  // room_id (NULL no compara), así que se limpian también por el correo de prueba.
  await pool.query(`DELETE FROM bookings WHERE customer_email LIKE '%@ejemplo.com'`);
  await pool.query('DELETE FROM bookings WHERE room_id = $1', [roomId]);
  await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]);
  await pool.end();
});

test('el paso 1 se guarda y el borrador se retoma con GET', async () => {
  const created = await post('/api/bookings', {
    customerName: 'Ana Pérez',
    customerEmail: 'ana@ejemplo.com',
  });
  assert.equal(created.status, 201);
  const draft = ok(created);
  assert.equal(draft.status, 'draft');
  assert.equal(draft.customerName, 'Ana Pérez');
  assert.equal(draft.date, null, 'aún no hay horario');

  const restored = await get(`/api/bookings/${draft.id}`);
  assert.equal(restored.status, 200);
  const view = ok(restored);
  assert.equal(view.customerEmail, 'ana@ejemplo.com');
  assert.equal(view.id, draft.id);
});

test('el paso 2 congela el precio (tarifa horaria con descuento)', async () => {
  const created = ok(
    await post('/api/bookings', { customerName: 'Ana', customerEmail: 'ana@ejemplo.com' }),
  );
  const saved = ok(
    await post('/api/bookings', {
      id: created.id,
      roomId,
      date: DATE,
      startTime: '09:00',
      durationMinutes: 240, // 4 h → 10 % → 160 000 − 16 000
    }),
  );
  assert.equal(saved.total, 144_000);
  assert.equal(saved.startTime, '09:00');
  assert.equal(saved.endTime, '13:00');
  assert.equal(saved.availability?.canBook, true);
  assert.ok(saved.lines.length >= 2, 'debe guardar base y descuento');
});

test('el paso 3 añade servicios al total sin tocar el descuento', async () => {
  const draft = ok(
    await post('/api/bookings', { customerName: 'B', customerEmail: 'b@ejemplo.com' }),
  );
  const withTime = ok(
    await post('/api/bookings', {
      id: draft.id,
      roomId,
      date: DATE,
      startTime: '16:00',
      durationMinutes: 60,
    }),
  );
  assert.equal(withTime.total, 40_000);

  const withServices = ok(
    await post('/api/bookings', { id: draft.id, services: ['projector', 'coffee'] }),
  );
  assert.equal(withServices.total, 55_000); // 40 000 + 10 000 + 5 000
  assert.deepEqual([...withServices.services].sort(), ['coffee', 'projector']);

  // SUM(booking_lines) === total (requisito de la consulta de inconsistencias).
  const sum = withServices.lines.reduce((accumulator, line) => accumulator + line.amount, 0);
  assert.equal(sum, withServices.total);
});

test('confirmar devuelve 201 con el precio congelado', async () => {
  const draft = ok(await post('/api/bookings', { customerName: 'C', customerEmail: 'c@ejemplo.com' }));
  ok(
    await post('/api/bookings', {
      id: draft.id,
      roomId,
      date: DATE,
      startTime: '08:00',
      durationMinutes: 60,
      services: ['coffee'],
    }),
  );

  const confirmed = await post(`/api/bookings/${draft.id}/confirm`, {});
  assert.equal(confirmed.status, 201);
  const view = ok(confirmed);
  assert.equal(view.status, 'confirmed');
  assert.equal(view.total, 45_000); // 40 000 + 5 000
});

test('idempotencia: confirmar 2 veces no duplica ni recalcula', async () => {
  const draft = ok(await post('/api/bookings', { customerName: 'D', customerEmail: 'd@ejemplo.com' }));
  ok(
    await post('/api/bookings', {
      id: draft.id,
      roomId,
      date: DATE,
      startTime: '14:00',
      durationMinutes: 60,
      services: ['projector'],
    }),
  );

  const before = await countBookings();
  const first = await post(`/api/bookings/${draft.id}/confirm`, {});
  assert.equal(first.status, 201);
  const firstView = ok(first);

  const second = await post(`/api/bookings/${draft.id}/confirm`, {});
  assert.equal(second.status, 200, 'la segunda confirmación debe resolverse como ya-hecha');
  const secondView = ok(second);

  assert.equal(secondView.total, firstView.total, 'no se recalcula el precio');
  assert.deepEqual(secondView.lines, firstView.lines, 'las líneas quedan idénticas');
  assert.equal(
    await countBookings(),
    before,
    'confirmar (aunque sea dos veces) no debe crear filas nuevas',
  );

  const { rows } = await pool.query<{ count: string }>(
    'SELECT count(*) FROM booking_lines WHERE booking_id = $1',
    [draft.id],
  );
  assert.equal(Number(rows[0]!.count), firstView.lines.length, 'sin líneas duplicadas');
});

test('concurrencia: dos confirmaciones en paralelo → 1×201 + 1×409', async () => {
  const time = { roomId, date: DATE, startTime: '18:00', durationMinutes: 60 };
  const first = ok(await post('/api/bookings', { customerName: 'E1', customerEmail: 'e1@ejemplo.com', ...time }));
  const second = ok(await post('/api/bookings', { customerName: 'E2', customerEmail: 'e2@ejemplo.com', ...time }));

  const [a, b] = await Promise.all([
    post(`/api/bookings/${first.id}/confirm`, {}),
    post(`/api/bookings/${second.id}/confirm`, {}),
  ]);

  const statuses = [a.status, b.status].sort((x, y) => x - y);
  assert.deepEqual(statuses, [201, 409], `esperaba 1×201 + 1×409, llegué ${statuses.join(' + ')}`);

  const winner = a.status === 201 ? a : b;
  const loser = a.status === 409 ? a : b;

  // El ganador conserva el precio pactado y sus líneas.
  const winnerView = ok(winner);
  assert.equal(winnerView.status, 'confirmed');
  assert.equal(winnerView.total, 40_000);
  assert.equal(winnerView.lines.length, 1);

  // El perdedor recibe el motivo y el siguiente horario libre del mismo día.
  const failure = failed(loser);
  assert.equal(failure.error.code, 'room_unavailable');
  assert.equal(failure.error.details?.suggestedSlot?.date, DATE);
  assert.equal(failure.error.details?.suggestedSlot?.startTime, '19:00');
});

test('una reserva confirmada ya no expone sugerencias de disponibilidad', async () => {
  const draft = ok(await post('/api/bookings', { customerName: 'S', customerEmail: 's@ejemplo.com' }));
  ok(
    await post('/api/bookings', {
      id: draft.id,
      roomId,
      date: DATE,
      startTime: '15:00',
      durationMinutes: 60,
    }),
  );

  const confirmed = await post(`/api/bookings/${draft.id}/confirm`, {});
  assert.equal(confirmed.status, 201);
  assert.equal(
    ok(confirmed).availability,
    null,
    'una reserva confirmada ya no debe ofrecer una sugerencia de horario inválida',
  );

  const restored = await get(`/api/bookings/${draft.id}`);
  assert.equal(ok(restored).availability, null, 'tampoco al retomar una reserva confirmada');
});

test('una reserva cancelada vuelve a ofrecer un horario alternativo', async () => {
  const draft = ok(await post('/api/bookings', { customerName: 'X', customerEmail: 'x@ejemplo.com' }));
  ok(
    await post('/api/bookings', {
      id: draft.id,
      roomId,
      date: DATE,
      startTime: '17:00',
      durationMinutes: 60,
    }),
  );

  const cancelled = await post(`/api/bookings/${draft.id}/cancel`, { reason: 'Cambios de planes' });
  assert.equal(cancelled.status, 200);
  const view = ok(cancelled);
  assert.equal(view.status, 'cancelled');
  assert.equal(view.availability?.canBook, true, 'al cancelar, el turno queda libre de nuevo');
});

test('cancelar exige motivo y se valida la transición', async () => {
  const draft = ok(await post('/api/bookings', { customerName: 'F', customerEmail: 'f@ejemplo.com' }));

  const withoutReason = await post(`/api/bookings/${draft.id}/cancel`, {});
  assert.equal(withoutReason.status, 400);
  assert.equal(failed(withoutReason).error.code, 'validation_error');

  const cancelled = await post(`/api/bookings/${draft.id}/cancel`, { reason: 'Cambiaron los planes' });
  assert.equal(cancelled.status, 200);
  assert.equal(ok(cancelled).cancelReason, 'Cambiaron los planes');

  const twice = await post(`/api/bookings/${draft.id}/cancel`, { reason: 'Otra vez' });
  assert.equal(twice.status, 409, 'cancelled → cancelled no es una transición legal');
  assert.equal(failed(twice).error.code, 'invalid_transition');
});

test('una transición ilegal desde el backend devuelve 409', async () => {
  const draft = ok(await post('/api/bookings', { customerName: 'G', customerEmail: 'g@ejemplo.com' }));
  ok(await post('/api/bookings', { id: draft.id, roomId, date: DATE, startTime: '20:00', durationMinutes: 60 }));

  // Fuerza un estado final que el wizard no expone (simula una reserva ya atendida).
  await pool.query(`UPDATE bookings SET status = 'completed' WHERE id = $1`, [draft.id]);

  const result = await post(`/api/bookings/${draft.id}/confirm`, {});
  assert.equal(result.status, 409);
  assert.equal(failed(result).error.code, 'invalid_transition');
});

test('confirmar un borrador incompleto devuelve 422', async () => {
  const draft = ok(await post('/api/bookings', { customerName: 'H', customerEmail: 'h@ejemplo.com' }));
  const result = await post(`/api/bookings/${draft.id}/confirm`, {});
  assert.equal(result.status, 422);
  assert.equal(failed(result).error.code, 'business_rule');
});

test('un horario inválido rechaza guardar y NO deja borrador huérfano', async () => {
  const before = await countBookings();
  // 2026-11-08 es domingo (cerrado).
  const result = await post('/api/bookings', {
    customerName: 'I',
    customerEmail: 'i@ejemplo.com',
    roomId,
    date: '2026-11-08',
    startTime: '10:00',
    durationMinutes: 60,
  });
  assert.equal(result.status, 422);
  assert.match(failed(result).error.message, /domingos/);
  assert.equal(await countBookings(), before, 'no debe crearse ninguna fila');
});

test('GET de una reserva inexistente → 404', async () => {
  const result = await get('/api/bookings/999999');
  assert.equal(result.status, 404);
  assert.equal(failed(result).error.code, 'not_found');
});
