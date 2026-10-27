import { Router, type NextFunction, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { LoginLimits } from '../../config.js';
import { sendError } from '../../core/http.js';
import { verifyPassword } from './password.js';
import { clearLoginFailures, isLoginLimited, loginAttemptKeys, recordLoginFailure } from './loginLimiter.js';
import {
  clearedCookie,
  createSession,
  destroySession,
  SESSION_COOKIE,
  sessionCookie,
  parseCookies,
} from './session.js';

/**
 * Rutas de sesión (Fase 3): login con `scrypt`, `me` y `logout`.
 * Misma respuesta y mismo mensaje para "usuario inexistente" y "contraseña
 * incorrecta" → no se puede enumerar cuentas.
 *
 * Extensión posterior: además del hash, el login tiene un límite de intentos
 * por correo/IP contra fuerza bruta (docs/03 §10).
 */
export interface AuthDeps {
  readonly pool: Pool;
  readonly secret: string;
  readonly isProduction: boolean;
  readonly login: LoginLimits;
}

const LoginSchema = z.object({
  email: z.email({ error: 'Indica un correo válido.' }).max(254),
  password: z
    .string({ error: 'Escribe tu contraseña.' })
    .min(1, 'Escribe tu contraseña.')
    .max(200),
});

interface UserRow {
  readonly id: number;
  readonly email: string;
  readonly full_name: string;
  readonly password_hash: string;
  readonly role: string;
}

/**
 * Hash ficticio con el mismo formato (y coste de scrypt) que los reales. Se
 * verifica contra él cuando la cuenta **no existe**, para que la respuesta tarde
 * lo mismo que con una contraseña incorrecta: sin esto, el tiempo de respuesta
 * del 401 revelaría qué correos están registrados (enumeración por timing).
 */
const TIMING_DECOY_HASH =
  'scrypt$16384$8$1$IizACVGtvOwH8iaQIVF8dA==$' +
  '+JAwminefHJa9W5xo4Jb1i/yAAUAWw8oYqzYiS+6IdPou112/FUlG16jJY2UinVBtTvlMkPbKbVhhHCeQkHAKg==';

async function handleLogin(deps: AuthDeps, req: Request, res: Response): Promise<void> {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(
      res,
      400,
      'validation_error',
      'Datos de acceso inválidos.',
      parsed.error.issues.map((issue) => ({
        field: issue.path.join('.') || '(cuerpo)',
        message: issue.message,
      })),
    );
    return;
  }

  const { email, password } = parsed.data;
  const keys = loginAttemptKeys(email, req.ip);

  // Se comprueba antes de consultar el usuario: un ataque de fuerza bruta no
  // debe llegar ni siquiera a hacer el trabajo de scrypt.
  if (await isLoginLimited(deps.pool, keys, deps.login)) {
    res.setHeader('Retry-After', String(deps.login.windowMinutes * 60));
    sendError(
      res,
      429,
      'too_many_attempts',
      'Demasiados intentos de acceso. Espera unos minutos e inténtalo de nuevo.',
    );
    return;
  }

  const result = await deps.pool.query<UserRow>(
    'SELECT id, email, full_name, password_hash, role FROM users WHERE lower(email) = lower($1)',
    [email],
  );
  const user = result.rows[0];
  let valid = false;
  if (user) {
    valid = await verifyPassword(password, user.password_hash);
  } else {
    // Misma carga de scrypt que con un usuario real → timing uniforme.
    await verifyPassword(password, TIMING_DECOY_HASH);
  }
  if (!user || !valid) {
    await recordLoginFailure(deps.pool, keys);
    sendError(res, 401, 'invalid_credentials', 'Correo o contraseña incorrectos.');
    return;
  }

  await clearLoginFailures(deps.pool, keys);
  const { cookie } = await createSession(deps.pool, deps.secret, user.id);
  res.setHeader('Set-Cookie', sessionCookie(cookie, deps.isProduction));
  res.json({
    user: { id: user.id, email: user.email, fullName: user.full_name, role: user.role },
  });
}

export function authRouter(deps: AuthDeps): Router {
  const router = Router();

  router.post('/login', (req: Request, res: Response, next: NextFunction) => {
    void handleLogin(deps, req, res).catch(next);
  });

  router.get('/me', (req: Request, res: Response) => {
    const auth = req.auth;
    if (!auth) {
      sendError(res, 401, 'unauthorized', 'No hay sesión activa.');
      return;
    }
    res.json({ user: auth.user });
  });

  router.post('/logout', (req: Request, res: Response, next: NextFunction) => {
    const value = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    destroySession(deps.pool, deps.secret, value)
      .then(() => {
        res.setHeader('Set-Cookie', clearedCookie(deps.isProduction));
        res.json({ ok: true });
      })
      .catch(next);
  });

  return router;
}
