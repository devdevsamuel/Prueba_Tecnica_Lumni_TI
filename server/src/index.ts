import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { systemClock } from './core/clock.js';
import { createPool } from './db/pool.js';
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

process.on('SIGTERM', () => {
  stopWorker();
  void pool.end().then(() => process.exit(0));
});
