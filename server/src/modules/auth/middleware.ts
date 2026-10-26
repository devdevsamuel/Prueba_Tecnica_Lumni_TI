import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Pool } from 'pg';
import { loadSession, parseCookies, SESSION_COOKIE, type AuthContext } from './session.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Sesión válida que adjuntó `attachSession` (ausente si no hay cookie válida). */
    auth?: AuthContext;
  }
}

/**
 * Adjunta `req.auth` si la cookie `sid` es válida y no está caducada.
 * Solo consulta la BD cuando hay cookie, así las rutas públicas no pagan nada.
 */
export function attachSession(pool: Pool, secret: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const value = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    loadSession(pool, secret, value)
      .then((context) => {
        if (context) req.auth = context;
        next();
      })
      .catch(next);
  };
}

/**
 * Guardia de rol: **401** si no hay sesión y **403** si el rol no coincide
 * (docs/01 §2.3 y §7 — los dos códigos que pide el contrato).
 */
export function requireRole(role: 'admin'): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({
        error: { code: 'unauthorized', message: 'Inicia sesión para continuar.' },
      });
      return;
    }
    if (auth.user.role !== role) {
      res.status(403).json({
        error: { code: 'forbidden', message: 'Tu cuenta no tiene permiso para acceder aquí.' },
      });
      return;
    }
    next();
  };
}
