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
import { processOne, reclaimOnStart, type WorkerDeps } from '../src/modules/email/worker.js';
import type { EmailMessage, EmailSender, SendResult } from '../src/modules/email/sender.js';

/**
 * Integración de la Fase 4 (Parte 2.1): outbox transaccional, idempotencia,
 * backoff, agotamiento y cola tras reinicio.
 *
 * El worker automático de `index.ts` NO corre aquí, así que la cola solo
 * avanza cuando un test llama a `processOne` → totalmente determinista.
 */

// Reloj fijo y AVANZABLE: controla el backoff sin esperas reales.
let now = bogotaWallToUtc('2026-11-04', 8 * 60);
const clock: Clock = { now: () => now, sleep: async () => undefined };
const advance = (ms: number): void => {
  now = new Date(now.getTime() + ms);
};

/** Doble que cuenta los envíos (docs/03 §7-D). */
class CountingSender implements EmailSender {
  readonly messages: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<SendResult> {
    this.messages.push(message);
    return { ok: true };
  }
}

/** Doble que siempre falla: para backoff y agotamiento. */
class FailingSender implements EmailSender {
  async send(): Promise<SendResult> {
    return { ok: false, error: 'Proveedor de correo caído (doble de prueba)' };
  }
}

const config = loadConfig(process.env);
let pool: Pool;
let server: Server | undefined;
let baseUrl: string;
let roomId: number;

const ROOM = `Sala Email Test ${process.pid}`;
const EMAIL_DOMAIN = '@email-test.test';

async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Crea un borrador con hora dada y lo confirma (encola su correo). */
async function confirmAt(startTime: string, email: string): Promise<number> {
  const draft = await post('/api/bookings', {
    customerName: 'Cliente Correo',
    customerEmail: email,
    roomId,
    date: '2026-11-05',
    startTime,
    durationMinutes: 60,
  });
  const id = draft.body.id as number;
  const confirmed = await post(`/api/bookings/${id}/confirm`, {});
  assert.equal(confirmed.status, 201, 'la confirmación debe crear la reserva');
  return id;
}

async function outboxRow(bookingId: number): Promise<Record<string, unknown>> {
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT id, status, attempts, last_error, sent_at, next_attempt_at,
            rendered_subject, rendered_body
       FROM email_outbox WHERE booking_id = $1`,
    [bookingId],
  );
  assert.equal(rows.length, 1, 'debe haber exactamente una fila de outbox');
  return rows[0]!;
}

function workerDeps(sender: EmailSender, baseDelayMs = 1_000): WorkerDeps {
  return { pool, sender, clock, baseDelayMs };
}

/**
 * Vacía la cola antes de cada test con aserciones sobre ella: así `processOne`
 * solo puede coger EL trabajo que crea ese test (los tests de confirmación de
 * otros ficheros también dejan correos encolados en esta misma base).
 */
async function drainQueue(): Promise<void> {
  const discard = new CountingSender();
  while (await processOne(workerDeps(discard))) {
    // se consume lo que haya (artefactos de tests anteriores)
  }
}

before(async () => {
  pool = createPool(config.databaseUrl);
  await migrate(pool); // idempotente

  // Limpieza defensiva (también de ejecuciones anteriores).
  await pool.query('DELETE FROM email_outbox WHERE booking_id IN (SELECT id FROM bookings WHERE customer_email LIKE $1)', [`%${EMAIL_DOMAIN}`]);
  await pool.query('DELETE FROM bookings WHERE customer_email LIKE $1', [`%${EMAIL_DOMAIN}`]);
  await pool.query(`DELETE FROM bookings WHERE room_id IN (SELECT id FROM rooms WHERE name LIKE 'Sala Email %')`);
  await pool.query(`DELETE FROM rooms WHERE name LIKE 'Sala Email %'`);

  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO rooms (name, size, capacity, hourly_rate) VALUES ($1, 'small', 4, 40000) RETURNING id`,
    [ROOM],
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
  await pool.query('DELETE FROM bookings WHERE customer_email LIKE $1', [`%${EMAIL_DOMAIN}`]);
  await pool.query(`DELETE FROM bookings WHERE room_id IN (SELECT id FROM rooms WHERE name LIKE 'Sala Email %')`);
  await pool.query(`DELETE FROM rooms WHERE name LIKE 'Sala Email %'`);
  // El login de la prueba de bandeja crea una sesión: se retira.
  await pool.query(
    `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email IN ('admin@coworking.test','cliente@coworking.test'))`,
  );
  await pool.end();
});

test('idempotencia: doble confirmación → exactamente 1 fila en email_outbox', async () => {
  const bookingId = await confirmAt('09:00', `doble${EMAIL_DOMAIN}`);

  const second = await post(`/api/bookings/${bookingId}/confirm`, {});
  assert.equal(second.status, 200, 'la segunda confirmación se resuelve como ya-hecha');

  const row = await outboxRow(bookingId);
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 0, 'el correo sigue intacto: ni duplicado ni enviado aún');
});

test('el worker envía el correo y queda visible en la BD', async () => {
  await drainQueue();
  const bookingId = await confirmAt('10:00', `envio${EMAIL_DOMAIN}`);
  const sender = new CountingSender();

  assert.equal(await processOne(workerDeps(sender)), true, 'había un trabajo pendiente');

  const row = await outboxRow(bookingId);
  assert.equal(row.status, 'sent');
  assert.equal(row.attempts, 1);
  assert.ok(row.sent_at, 'debe llevar marca de envío');
  assert.equal(row.last_error, null);

  // Lo que se envió coincide con lo encolado y con la reserva.
  assert.equal(sender.messages.length, 1);
  assert.equal(sender.messages[0]!.to, `envio${EMAIL_DOMAIN}`);
  assert.match(sender.messages[0]!.subject, new RegExp(`Reserva #${bookingId}`));
  assert.ok(sender.messages[0]!.body.includes('Sala'), 'el cuerpo pinta la sala');
});

test('concurrencia: dos workers en paralelo envían UN solo correo', async () => {
  await drainQueue();
  const bookingId = await confirmAt('11:00', `paralelo${EMAIL_DOMAIN}`);
  const sender = new CountingSender();

  // Dos procesos compiten por la misma cola a la vez.
  const results = await Promise.all([
    processOne(workerDeps(sender)),
    processOne(workerDeps(sender)),
  ]);

  assert.equal(
    results.filter(Boolean).length,
    1,
    'FOR UPDATE SKIP LOCKED deja pasar a uno solo: el otro no encuentra trabajo',
  );
  assert.equal(sender.messages.length, 1, 'exactamente un correo salido');

  const row = await outboxRow(bookingId);
  assert.equal(row.status, 'sent');
  assert.equal(row.attempts, 1, 'el intento se cuenta UNA vez');
});

test('backoff: 1×, 2×, 4× y 8× el retardo base entre intentos', async () => {
  await drainQueue();
  const bookingId = await confirmAt('14:00', `backoff${EMAIL_DOMAIN}`);
  const deps = workerDeps(new FailingSender(), 1_000);
  const rowId = (await outboxRow(bookingId)).id as number;

  const nextAt = async (): Promise<number> => {
    const { rows } = await pool.query<{ next_attempt_at: Date }>(
      'SELECT next_attempt_at FROM email_outbox WHERE id = $1',
      [rowId],
    );
    return rows[0]!.next_attempt_at.getTime();
  };

  const antes = now.getTime();
  await processOne(deps);
  assert.equal((await outboxRow(bookingId)).attempts, 1);
  assert.equal((await outboxRow(bookingId)).status, 'pending');
  assert.equal((await nextAt()) - antes, 1_000, 'intento 1 → 1× base');

  advance(1_000);
  let marcas = now.getTime();
  await processOne(deps);
  assert.equal((await outboxRow(bookingId)).attempts, 2);
  assert.equal((await nextAt()) - marcas, 2_000, 'intento 2 → 2× base');

  advance(2_000);
  marcas = now.getTime();
  await processOne(deps);
  assert.equal((await outboxRow(bookingId)).attempts, 3);
  assert.equal((await nextAt()) - marcas, 4_000, 'intento 3 → 4× base');

  advance(4_000);
  marcas = now.getTime();
  await processOne(deps);
  assert.equal((await outboxRow(bookingId)).attempts, 4);
  assert.equal((await nextAt()) - marcas, 8_000, 'intento 4 → 8× base');

  // Queda agotado para el test siguiente (avanza hasta ahí).
  advance(8_000);
});

test('agotamiento: el quinto intento pasa a failed y ya no se reprograma', async () => {
  await drainQueue();
  const bookingId = await confirmAt('15:00', `agotado${EMAIL_DOMAIN}`);
  const deps = workerDeps(new FailingSender(), 0); // base 0 → sin esperas
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    assert.equal(await processOne(deps), true, `intento ${attempt} procesado`);
  }

  const row = await outboxRow(bookingId);
  assert.equal(row.status, 'failed', 'con 5 intentos agota y queda visible como fallido');
  assert.equal(row.attempts, 5);
  assert.match(String(row.last_error), /Proveedor de correo caído/);

  // Sin trabajo pendiente: el worker no se queda en bucle.
  assert.equal(await processOne(deps), false);
});

test('cola tras reinicio: un trabajo a medias se reclama y se envía', async () => {
  await drainQueue();
  const bookingId = await confirmAt('16:00', `reinicio${EMAIL_DOMAIN}`);
  const rowId = (await outboxRow(bookingId)).id as number;

  // Simula un worker que muere a mitad de envío (queda en 'sending').
  await pool.query(`UPDATE email_outbox SET status = 'sending' WHERE id = $1`, [rowId]);
  assert.equal((await outboxRow(bookingId)).status, 'sending');

  // Al arrancar de nuevo se reclama y la cola sigue viva.
  assert.equal(await reclaimOnStart(workerDeps(new CountingSender())), 1, 'se reclama exactamente el huérfano');
  assert.equal((await outboxRow(bookingId)).status, 'pending');

  const sender = new CountingSender();
  assert.equal(await processOne(workerDeps(sender)), true, 'el trabajo reclamado se procesa');
  assert.equal((await outboxRow(bookingId)).status, 'sent');
  assert.equal(sender.messages.length, 1);
});

test('la bandeja del admin muestra el correo con cuerpo y admite filtro', async () => {
  // Sesión de administrador.
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@coworking.test', password: 'coworking2026' }),
  });
  const cookie = `sid=${/sid=([^;]*)/.exec(login.headers.get('set-cookie') ?? '')?.[1] ?? ''}`;
  assert.equal(login.status, 200);

  const list = await fetch(`${baseUrl}/api/admin/emails?status=sent&pageSize=50`, {
    headers: { Cookie: cookie },
  });
  assert.equal(list.status, 200);
  const listBody = (await list.json()) as {
    total: number;
    totalPages: number;
    items: { id: number; status: string; recipient: string; subject: string }[];
  };
  assert.ok(listBody.total >= 3, 'hay correos enviados por los tests anteriores');
  assert.ok(listBody.items.every((item) => item.status === 'sent'), 'el filtro funciona');

  // El total de la bandeja tampoco depende de la página pedida.
  const outOfRange = await fetch(`${baseUrl}/api/admin/emails?status=sent&pageSize=50&page=999`, {
    headers: { Cookie: cookie },
  });
  assert.equal(outOfRange.status, 200);
  const outOfRangeBody = (await outOfRange.json()) as { total: number; items: unknown[] };
  assert.equal(outOfRangeBody.total, listBody.total, 'el total no se pierde fuera de rango');
  assert.equal(outOfRangeBody.items.length, 0);
  // La bandeja es global: conviven correos reales de la BD de desarrollo, así
  // que solo se exige que los de ESTE fichero estén presentes (no únicos).
  const mine = listBody.items.filter((item) => item.recipient.endsWith(EMAIL_DOMAIN));
  assert.ok(mine.length >= 3, 'los correos de este fichero aparecen en la bandeja');

  const detail = await fetch(`${baseUrl}/api/admin/emails/${mine[0]!.id}`, {
    headers: { Cookie: cookie },
  });
  assert.equal(detail.status, 200);
  const detailBody = (await detail.json()) as { body: string; sentAt: string | null; attempts: number };
  assert.ok(detailBody.body.length > 0, 'el detalle trae el cuerpo del correo');
  assert.ok(detailBody.sentAt, 'y la marca de envío');
  assert.ok(detailBody.attempts >= 1);

  const invalid = await fetch(`${baseUrl}/api/admin/emails?status=inventado`, {
    headers: { Cookie: cookie },
  });
  assert.equal(invalid.status, 400, 'estado inválido → 400');
});
