import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';

/**
 * Sesiones de servidor (docs/01 §7, docs/03 §8): cookie `httpOnly` firmada con
 * HMAC-SHA256 + tabla `sessions` que aporta expiración y **revocación** (sin
 * tabla, un cookie robado seguiría válido y "cerrar sesión" no cortaría nada).
 *
 * Sin librerías: `node:crypto` para firmar y `pg` para la tabla.
 */
export const SESSION_COOKIE = 'sid';
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

export interface AuthUser {
  readonly id: number;
  readonly email: string;
  readonly fullName: string;
  readonly role: 'client' | 'admin';
}

export interface AuthContext {
  readonly sessionId: string;
  readonly user: AuthUser;
}

/** `base64(sid).firma` — la firma cubre el payload, no se puede fabricar sin SECRET. */
function sign(payload: string, secret: string): string {
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

/** Devuelve el sid si la cookie está bien formada y firmada; si no, `null`. */
function verify(cookie: string, secret: string): string | null {
  const [payload, signature] = cookie.split('.');
  if (!payload || !signature) return null;
  const expected = Buffer.from(createHmac('sha256', secret).update(payload).digest('base64url'));
  const given = Buffer.from(signature);
  // `timingSafeEqual` exige igual longitud: un atacante no debe distinguir el fallo.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const decoded = Buffer.from(payload, 'base64url').toString('utf8');
  return decoded.length > 0 ? decoded : null;
}

function buildCookie(value: string, secure: boolean, maxAgeSeconds: number): string {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** Cabecera `Set-Cookie` para abrir la sesión. */
export function sessionCookie(cookie: string, isProduction: boolean): string {
  return buildCookie(cookie, isProduction, Math.floor(SESSION_TTL_MS / 1000));
}

/** Cabecera `Set-Cookie` para cerrarla (Max-Age=0 la borra en el cliente). */
export function clearedCookie(isProduction: boolean): string {
  return buildCookie('', isProduction, 0);
}

/** Parsea la cabecera `Cookie` sin dependencias (no hay cookie-parser). */
export function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (!key || key in result) continue;
    result[key] = decodeURIComponent(part.slice(separator + 1).trim());
  }
  return result;
}

/** Crea la fila de sesión y devuelve la cookie firmada. Limpia las caducadas. */
export async function createSession(
  pool: Pool,
  secret: string,
  userId: number,
): Promise<{ cookie: string; sessionId: string }> {
  const sessionId = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query('INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)', [
    sessionId,
    userId,
    expiresAt,
  ]);
  // Mantenimiento barato: no acumular sesiones ya caducadas.
  await pool.query('DELETE FROM sessions WHERE expires_at < now()');
  const payload = Buffer.from(sessionId, 'utf8').toString('base64url');
  return { cookie: sign(payload, secret), sessionId };
}

/** Valida la cookie y carga la sesión con su usuario; `null` si no es válida. */
export async function loadSession(
  pool: Pool,
  secret: string,
  cookieValue: string | undefined,
): Promise<AuthContext | null> {
  if (!cookieValue) return null;
  const sessionId = verify(cookieValue, secret);
  if (!sessionId) return null;

  const { rows } = await pool.query<{
    session_id: string;
    id: number;
    email: string;
    full_name: string;
    role: string;
  }>(
    `SELECT s.id AS session_id, u.id, u.email, u.full_name, u.role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now()`,
    [sessionId],
  );
  const row = rows[0];
  if (!row) return null;

  return {
    sessionId: row.session_id,
    user: {
      id: row.id,
      email: row.email,
      fullName: row.full_name,
      role: row.role === 'admin' ? 'admin' : 'client',
    },
  };
}

/** Revoca la sesión en el servidor (logout real, no solo borrar la cookie). */
export async function destroySession(
  pool: Pool,
  secret: string,
  cookieValue: string | undefined,
): Promise<void> {
  if (!cookieValue) return;
  const sessionId = verify(cookieValue, secret);
  if (!sessionId) return;
  await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
}
