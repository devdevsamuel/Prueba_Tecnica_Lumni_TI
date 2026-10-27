import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { LoginLimits } from '../../config.js';

/**
 * Límite de intentos de login (extensión posterior, docs/03 §10).
 *
 * No guarda correos ni IPs en claro: la clave es sha256(`email:<normalizado>`) o
 * sha256(`ip:<origen>`). La ventana móvil se consulta en PostgreSQL, así que
 * funciona con varios procesos (no es un Map en memoria que se pierde al
 * reiniciar). La inyección SQL no depende de esto: todas las consultas usan
 * parámetros `$1`.
 */
export function loginAttemptKeys(email: string, ip: string | undefined): readonly string[] {
  const keys = [digest('email', email.trim().toLowerCase())];
  const normalizedIp = ip?.trim();
  if (normalizedIp) keys.push(digest('ip', normalizedIp));
  return keys;
}

function digest(prefix: string, value: string): string {
  return createHash('sha256').update(`${prefix}:${value}`).digest('hex');
}

/**
 * ¿ALGUNA de las claves (correo o IP) superó el máximo de fallos dentro de la
 * ventana? Se agrupa por clave: sumar los contadores de correo e IP sería
 * incorrecto, porque cada fallo inserta las dos filas y un solo intento duplicaría
 * el conteo.
 */
export async function isLoginLimited(
  pool: Pool,
  keys: readonly string[],
  limits: LoginLimits,
): Promise<boolean> {
  const { rows } = await pool.query<{ attempt_key: string; count: number }>(
    `SELECT attempt_key, count(*)::int AS count
       FROM login_attempts
      WHERE attempt_key = ANY($1::text[])
        AND attempted_at > now() - ($2::int * interval '1 minute')
      GROUP BY attempt_key`,
    [[...keys], limits.windowMinutes],
  );
  return rows.some((row) => row.count >= limits.maxAttempts);
}

/** Registra un fallo para todas las claves (correo e IP). */
export async function recordLoginFailure(pool: Pool, keys: readonly string[]): Promise<void> {
  await pool.query(
    `INSERT INTO login_attempts (attempt_key)
     SELECT unnest($1::text[])`,
    [[...keys]],
  );
  // Mantenimiento barato: la tabla no crece sin límite.
  await pool
    .query(`DELETE FROM login_attempts WHERE attempted_at < now() - interval '1 day'`)
    .catch(() => undefined);
}

/** Un login correcto limpia los fallos de ese correo/IP. */
export async function clearLoginFailures(pool: Pool, keys: readonly string[]): Promise<void> {
  await pool.query(`DELETE FROM login_attempts WHERE attempt_key = ANY($1::text[])`, [[...keys]]);
}
