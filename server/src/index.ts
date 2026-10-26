import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { systemClock } from './core/clock.js';
import { createPool } from './db/pool.js';

/** Arranque: valida env → crea pool → compone la app → escucha. */
const config = loadConfig(process.env);
const pool = createPool(config.databaseUrl);
const app = createApp({ config, pool, clock: systemClock });

app.listen(config.port, () => {
  console.log(`API escuchando en http://localhost:${config.port} (TZ: ${config.tz})`);
});

process.on('SIGTERM', () => {
  void pool.end().then(() => process.exit(0));
});
