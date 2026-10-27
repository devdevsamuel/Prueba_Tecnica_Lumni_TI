import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { systemClock } from './core/clock.js';
import { createPool } from './db/pool.js';
import { startReminderScheduler } from './modules/email/reminderScheduler.js';
import { DbEmailSender } from './modules/email/sender.js';
import { startWorker } from './modules/email/worker.js';

/** Arranque: valida env → crea pool → compone la app → escucha + worker. */
const config = loadConfig(process.env);
const pool = createPool(config.databaseUrl);
const app = createApp({ config, pool, clock: systemClock });

app.listen(config.port, () => {
  console.log(`API escuchando en http://localhost:${config.port} (TZ: ${config.tz})`);
});

// Correo en segundo plano (Parte 2.1): la confirmación nunca espera el envío.
// Captura local: DbEmailSender no saca nada de la máquina; lo visible queda en
// email_outbox y en la bandeja del admin. Cada 5 s vacía la cola.
const stopWorker = startWorker({ pool, sender: new DbEmailSender(), clock: systemClock });
console.log('Email worker: activo (captura local cada 5 s).');

// Recordatorios (extensión posterior): el scheduler analiza la BD y encola en
// el mismo outbox; el worker de arriba es quien envía. Si está desactivado,
// la cola de confirmaciones sigue funcionando igual.
const stopReminders = config.reminders.enabled
  ? startReminderScheduler(
      {
        pool,
        clock: systemClock,
        leadHours: config.reminders.leadHours,
        catchupHours: config.reminders.catchupHours,
      },
      config.reminders.scanIntervalMs,
    )
  : () => undefined;
if (config.reminders.enabled) {
  console.log(
    `Recordatorios: activo (cada ${config.reminders.scanIntervalMs / 1_000} s, ` +
      `${config.reminders.leadHours} h antes).`,
  );
}

process.on('SIGTERM', () => {
  stopWorker();
  stopReminders();
  void pool.end().then(() => process.exit(0));
});

process.on('SIGINT', () => {
  stopWorker();
  stopReminders();
  void pool.end().then(() => process.exit(0));
});
