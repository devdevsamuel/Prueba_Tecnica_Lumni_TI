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
import { enqueueDueReminders } from '../src/modules/email/reminderScheduler.js';
import type { EmailMessage, EmailSender, SendResult } from '../src/modules/email/sender.js';
import { drain, processOne, type WorkerDeps } from '../src/modules/email/worker.js';

/**
 * Integración de los recordatorios (extensión posterior, docs/03 §9).
 *
 * Se usa un reloj fijo en 2030 para que el scheduler solo vea las reservas de
 * este archivo: las reservas de los otros tests viven en 2026 y no entran en la
 * ventana. El worker no arranca solo; cada test llama a `processOne`/`drain`.
 *
 * Se cubre lo que el requisito pide demostrar:
 *  - el scheduler analiza la BD y encola una sola vez (idempotencia);
 *  - un fallo de un correo no repite toda la cola;
 *  - una reserva cancelada o ya empezada no recibe el recordatorio;
 *  - una reserva confirmada con menos antelación que el adelanto no recibe
 *    un recordatorio tardío.
 */

let now = bogotaWallToUtc('2030-01-12', 8 * 60 + 59);
const clock: Clock = { now: () => now, sleep: async () => undefined };
const setNow = (date: string, minutes: number): void => {
  now = bogotaWallToUtc(date, minutes);
};

class CountingSender implements EmailSender {
  readonly messages: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<SendResult> {
    this.messages.push(message);
    return { ok: true };
  }
}

/** Falla solo para un destinatario concreto; el resto de la cola sigue. */
class SelectiveFailingSender implements EmailSender {
  readonly messages: EmailMessage[] = [];
  constructor(private readonly failingPrefix: string) {}
  async send(message: EmailMessage): Promise<SendResult> {
    if (message.to.startsWith(this.failingPrefix)) {
      return { ok: false, error: 'Fallo simulado para este destinatario' };
    }
    this.messages.push(message);
    return { ok: true };
  }
}

const config = loadConfig(process.env);
let pool: Pool;
let server: Server | undefined;
let baseUrl: string;
let roomId: number;
let roomBId: number;

const ROOM = `Sala Reminder Test ${process.pid}`;
const ROOM_B = `Sala Reminder Test B ${process.pid}`;
const EMAIL_DOMAIN = '@reminder-test.test';

interface BookingResponse {
  readonly id: number;
}

async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function createAndConfirm(
  date: string,
  startTime: string,
  localPart: string,
  room: number = roomId,
): Promise<number> {
  const draft = await post('/api/bookings', {
    customerName: 'Cliente Recordatorio',
    customerEmail: `${localPart}${EMAIL_DOMAIN}`,
    roomId: room,
    date,
    startTime,
    durationMinutes: 60,
  });
  assert.equal(draft.status, 201, 'el borrador debe crearse');
  const id = (draft.body as unknown as BookingResponse).id;
  const confirmed = await post(`/api/bookings/${id}/confirm`, {});
  assert.equal(confirmed.status, 201, 'la reserva debe confirmarse');
  return id;
}

function workerDeps(sender: EmailSender, baseDelayMs = 1_000): WorkerDeps {
  return { pool, sender, clock, baseDelayMs };
}

/** Consume la confirmación (y cualquier residuo) antes de mirar el recordatorio. */
async function drainBeforeReminder(): Promise<void> {
  const discard = new CountingSender();
  await drain(workerDeps(discard), 100);
}

async function outboxRows(bookingId: number): Promise<
  { id: number; kind: string; status: string; attempts: number; subject: string }[]
> {
  const { rows } = await pool.query<{
    id: number;
    kind: string;
    status: string;
    attempts: number;
    rendered_subject: string;
  }>(
    `SELECT id, kind, status, attempts, rendered_subject
       FROM email_outbox
      WHERE booking_id = $1
      ORDER BY id`,
    [bookingId],
  );
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    status: row.status,
    attempts: row.attempts,
    subject: row.rendered_subject,
  }));
}

before(async () => {
  pool = createPool(config.databaseUrl);
  await migrate(pool);

  await pool.query('DELETE FROM bookings WHERE customer_email LIKE $1', [`%${EMAIL_DOMAIN}`]);
  await pool.query(`DELETE FROM bookings WHERE room_id IN (SELECT id FROM rooms WHERE name LIKE 'Sala Reminder Test %')`);
  await pool.query(`DELETE FROM rooms WHERE name LIKE 'Sala Reminder Test %'`);

  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO rooms (name, size, capacity, hourly_rate) VALUES ($1, 'small', 4, 40000) RETURNING id`,
    [ROOM],
  );
  roomId = rows[0]!.id;

  const second = await pool.query<{ id: number }>(
    `INSERT INTO rooms (name, size, capacity, hourly_rate) VALUES ($1, 'small', 4, 40000) RETURNING id`,
    [ROOM_B],
  );
  roomBId = second.rows[0]!.id;

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
  await pool.query(`DELETE FROM bookings WHERE room_id IN (SELECT id FROM rooms WHERE name LIKE 'Sala Reminder Test %')`);
  await pool.query(`DELETE FROM rooms WHERE name LIKE 'Sala Reminder Test %'`);
  await pool.end();
});

test('el scheduler encola el recordatorio una sola vez y el worker lo envía', async () => {
  setNow('2030-01-12', 8 * 60 + 59); // 08:59; recordatorio a las 09:00
  const bookingId = await createAndConfirm('2030-01-14', '09:00', 'envio');
  await drainBeforeReminder();

  const first = await enqueueDueReminders({
    pool,
    clock,
    leadHours: 48,
    catchupHours: 24,
    lookaheadMs: 60_000,
  });
  const second = await enqueueDueReminders({
    pool,
    clock,
    leadHours: 48,
    catchupHours: 24,
    lookaheadMs: 60_000,
  });
  assert.equal(first, 1, 'el primer tick crea el recordatorio');
  assert.equal(second, 0, 'el segundo tick no duplica');

  const reminder = (await outboxRows(bookingId)).find((row) => row.kind === 'reminder_2d');
  assert.ok(reminder, 'debe existir la fila reminder_2d');
  assert.equal(reminder.status, 'pending');
  assert.match(reminder.subject, /Recordatorio/);

  setNow('2030-01-12', 9 * 60);
  const sender = new CountingSender();
  assert.equal(await processOne(workerDeps(sender)), true);
  assert.equal(sender.messages.length, 1, 'sale exactamente un recordatorio');
  assert.match(sender.messages[0]!.subject, /Recordatorio/);
  assert.equal((await outboxRows(bookingId)).find((row) => row.kind === 'reminder_2d')?.status, 'sent');
});

test('si la reserva se cancela después de encolar, el recordatorio se omite sin enviar', async () => {
  setNow('2030-01-14', 8 * 60 + 59);
  const bookingId = await createAndConfirm('2030-01-16', '09:00', 'cancelado');
  await drainBeforeReminder();

  assert.equal(
    await enqueueDueReminders({ pool, clock, leadHours: 48, catchupHours: 24, lookaheadMs: 60_000 }),
    1,
  );
  const cancel = await post(`/api/bookings/${bookingId}/cancel`, { reason: 'Prueba de recordatorio' });
  assert.equal(cancel.status, 200);

  setNow('2030-01-14', 9 * 60);
  const sender = new CountingSender();
  assert.equal(await processOne(workerDeps(sender)), true);
  assert.equal(sender.messages.length, 0, 'no debe salir correo de una reserva cancelada');
  assert.equal((await outboxRows(bookingId)).find((row) => row.kind === 'reminder_2d')?.status, 'skipped');
});

test('un fallo de un recordatorio no repite ni bloquea el resto de la cola', async () => {
  setNow('2030-01-16', 8 * 60 + 59);
  const failingId = await createAndConfirm('2030-01-18', '09:00', 'falla');
  // Misma hora de inicio en OTRA sala: ambos recordatorios vencen a la vez
  // (sin solape porque son salas distintas).
  const okId = await createAndConfirm('2030-01-18', '09:00', 'ok', roomBId);
  await drainBeforeReminder();

  assert.equal(
    await enqueueDueReminders({ pool, clock, leadHours: 48, catchupHours: 24, lookaheadMs: 60_000 }),
    2,
  );

  setNow('2030-01-16', 9 * 60);
  const sender = new SelectiveFailingSender('falla');
  const processed = await drain(workerDeps(sender, 1_000), 10);
  assert.equal(processed, 2, 'se intentan los dos: el fallo no corta la cola');
  assert.equal(sender.messages.length, 1, 'solo sale el que no falló');

  const failing = (await outboxRows(failingId)).find((row) => row.kind === 'reminder_2d');
  const ok = (await outboxRows(okId)).find((row) => row.kind === 'reminder_2d');
  assert.equal(failing?.status, 'pending', 'el fallido se reprograma solo a sí mismo');
  assert.equal(failing?.attempts, 1);
  assert.equal(ok?.status, 'sent', 'el otro recordatorio no se ve afectado');
});

test('no se envía recordatorio si la reserva se confirmó después del corte de 48 h', async () => {
  setNow('2030-01-20', 8 * 60 + 59);
  const bookingId = await createAndConfirm('2030-01-22', '09:00', 'tardia');
  await drainBeforeReminder();

  // Simula que la reserva se confirmó 24 h antes del inicio, es decir, después
  // del corte de 48 h. El scheduler no debe encolar un recordatorio tardío.
  await pool.query(
    `UPDATE bookings SET confirmed_at = starts_at - interval '24 hours' WHERE id = $1`,
    [bookingId],
  );

  assert.equal(
    await enqueueDueReminders({ pool, clock, leadHours: 48, catchupHours: 24, lookaheadMs: 60_000 }),
    0,
  );
  assert.equal(
    (await outboxRows(bookingId)).some((row) => row.kind === 'reminder_2d'),
    false,
  );
});
