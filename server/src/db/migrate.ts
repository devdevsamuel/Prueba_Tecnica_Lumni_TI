import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { ConfigError, loadConfig } from '../config.js';
import { createPool } from './pool.js';

/**
 * Runner de migraciones propio (docs/02 §2, 0 dependencias):
 *  - lee `db/migrations/*.sql` ordenados por nombre (0001_, 0002_, …);
 *  - crea `schema_migrations(name, hash, applied_at)` si no existe;
 *  - toma un advisory lock para que dos procesos no migren a la vez;
 *  - aplica cada migración pendiente dentro de una transacción y guarda el
 *    sha256 de su contenido: si una migración ya aplicada cambió, aborta;
 *  - es idempotente: re-ejecutarlo no vuelve a aplicar nada.
 */
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations',
);

/** Clave arbitraria y estable del advisory lock de migraciones. */
const MIGRATION_LOCK_KEY = 727_510_001;

export async function migrate(pool: Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (' +
        'name text PRIMARY KEY, hash text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    for (const file of files) {
      const sql = await readFile(path.join(dir, file), 'utf8');
      const hash = createHash('sha256').update(sql).digest('hex');
      const { rows } = await client.query<{ hash: string }>(
        'SELECT hash FROM schema_migrations WHERE name = $1',
        [file],
      );
      if (rows.length > 0) {
        if (rows[0]?.hash !== hash) {
          throw new Error(
            `La migración ya aplicada "${file}" cambió después de ejecutarse. ` +
              'Crea una nueva migración numerada en vez de editarla.',
          );
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, hash) VALUES ($1, $2)', [file, hash]);
        await client.query('COMMIT');
        applied.push(file);
        console.log(`✔ migración aplicada: ${file}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    if (applied.length === 0) console.log('Migraciones al día (nada por aplicar).');
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

/** Punto de entrada: `node server/dist/db/migrate.js` (o vía tsx en desarrollo). */
async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const pool = createPool(config.databaseUrl);
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
}

const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error: unknown) => {
    if (error instanceof ConfigError) console.error(`✗ ${error.message}`);
    else console.error('✗ Falló la migración:', error);
    process.exitCode = 1;
  });
}
