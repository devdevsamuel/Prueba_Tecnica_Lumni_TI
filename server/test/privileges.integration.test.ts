import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPool } from '../src/db/pool.js';
import { loadConfig } from '../src/config.js';

/**
 * Rol de menor privilegio de la aplicación (docs/03 §12).
 *
 * Este test comprueba que el rol con el que corre la API NO puede hacer DDL.
 * Es la garantía que motiva todo el mecanismo: aunque una inyección SQL
 * lograra ejecutar una sentencia, no podría borrar el esquema ni eliminar el
 * constraint de exclusión que evita el solape de reservas confirmadas.
 *
 * Es un test de integración contra la BD real: necesita que el rol
 * `coworking_app` exista con los permisos de `db/roles.sql` (los deja
 * `npm run db:roles`). Si el rol no existe, el test se salta con un mensaje
 * explícito en vez de fallar: en un entorno de CI limpio todavía no se ha
 * creado el rol.
 */

/** Rol y contraseña de la aplicación (los deja `npm run db:roles`). */
const APP_ROLE = 'coworking_app';
const APP_PASSWORD = process.env.COWORKING_APP_PASSWORD ?? '';

const config = loadConfig(process.env);

test('el pool de la app tiene tiempos de vida acotados', () => {
  const pool = createPool(config.databaseUrl);
  // `pg` deja `connectionTimeoutMillis` en 0 (esperar para siempre) y
  // `idleTimeoutMillis` en 10 s: los valores se fijan a propósito para que
  // una BD caída haga fallar la petición en lugar de colgarla.
  assert.equal(pool.options.connectionTimeoutMillis, 5_000);
  assert.equal(pool.options.idleTimeoutMillis, 10_000);
  assert.equal(pool.options.max, 10);
  assert.ok(
    (pool.options.maxLifetimeSeconds ?? 0) > 0,
    'las conexiones deben reciclarse (maxLifetimeSeconds) para no quedar con sockets muertos',
  );
});

test('el rol de la aplicación no puede ejecutar DDL', async (t) => {
  if (!APP_PASSWORD) {
    t.skip('sin COWORKING_APP_PASSWORD no se puede autenticar como coworking_app');
    return;
  }

  // Se conecta con el PROPIO rol de la aplicación (no con el dueño): así se
  // comprueban los permisos reales, no los heredados de otro usuario.
  const url = new URL(config.databaseUrl);
  url.username = APP_ROLE;
  url.password = APP_PASSWORD;
  const pool = createPool(url.toString());

  try {
    // Comprobación previa: si el rol no existe o no tiene permisos, el test
    // no es válido (no se puede afirmar nada sobre DDL).
    const canSelect = await pool.query('SELECT count(*)::int AS n FROM rooms');
    assert.equal(typeof canSelect.rows[0]?.n, 'number', 'el rol debe poder leer rooms');

    // DDL que el rol NO puede ejecutar. Cada sentencia debe fallar con
    // "permission denied"; si alguna pasara, el test falla.
    const forbidden: ReadonlyArray<readonly [string, string]> = [
      ['TRUNCATE bookings', 'TRUNCATE bookings'],
      ['CREATE TABLE', 'CREATE TABLE hacker (id integer)'],
      ['DROP TABLE', 'DROP TABLE rooms'],
      ['ALTER TABLE', 'ALTER TABLE bookings DROP CONSTRAINT no_room_overlap'],
      ['CREATE en el esquema', 'CREATE SCHEMA hacker'],
    ];

    for (const [label, sql] of forbidden) {
      await assert.rejects(
        () => pool.query(sql),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          return /permission denied|must be owner/i.test(message);
        },
        `el rol de la aplicación no debería poder: ${label}`,
      );
    }
  } finally {
    await pool.end();
  }
});

test('el rol de la aplicación sí puede escribir (DML)', async (t) => {
  if (!APP_PASSWORD) {
    t.skip('sin COWORKING_APP_PASSWORD no se puede autenticar como coworking_app');
    return;
  }

  const url = new URL(config.databaseUrl);
  url.username = APP_ROLE;
  url.password = APP_PASSWORD;
  const pool = createPool(url.toString());

  try {
    // INSERT con IDENTITY: exige `USAGE` sobre la secuencia, que es el
    // privilegio que suele olvidarse al conceder permisos.
    const inserted = await pool.query(
      `INSERT INTO rooms (name, size, capacity, hourly_rate)
       VALUES ($1, 'small', 1, 1) RETURNING id`,
      [`test-privilegios-${Date.now()}`],
    );
    const id = inserted.rows[0]?.id;
    assert.ok(typeof id === 'number', 'el INSERT debe devolver la id generada');

    await pool.query('DELETE FROM rooms WHERE id = $1', [id]);
  } finally {
    await pool.end();
  }
});
