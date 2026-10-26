import { Router, type NextFunction, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Clock } from '../../core/clock.js';
import { sendError } from '../../core/http.js';
import { parseCookies } from '../auth/session.js';
import { AiUnavailableError, type AiClient } from './aiClient.js';
import { createSession, history, sendMessage, sessionExists } from './service.js';

/**
 * Rutas del chat (Parte 2.2): `POST /api/chat` para conversar y `GET /api/chat`
 * para retomar la conversación al recargar (docs/04 §6).
 *
 * La sesión viaja en la cookie `chat_sid` (httpOnly). Ese valor es el id de la
 * conversación y también el que se manda en `x-opencode-session`: una conversación
 * por cookie, 1:1 con `chat_sessions.id` (docs/03 §6.1).
 */
export interface ChatRoutesDeps {
  readonly pool: Pool;
  readonly clock: Clock;
  readonly ai: AiClient;
  readonly isProduction: boolean;
}

export const CHAT_COOKIE = 'chat_sid';

const MessageSchema = z.object({
  content: z
    .string({ error: 'Escribe un mensaje.' })
    .trim()
    .min(1, 'Escribe un mensaje.')
    .max(2000, 'El mensaje es demasiado largo (máximo 2000 caracteres).'),
});

function chatCookie(value: string, isProduction: boolean): string {
  const parts = [
    `${CHAT_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${60 * 60 * 24 * 30}`, // 30 días: la conversación se retoma
  ];
  if (isProduction) parts.push('Secure');
  return parts.join('; ');
}

/** ¿Hay cookie y sigue viva la conversación? */
async function currentSession(deps: ChatRoutesDeps, req: Request): Promise<string | null> {
  const cookie = parseCookies(req.headers.cookie)[CHAT_COOKIE];
  if (!cookie) return null;
  return (await sessionExists(deps.pool, cookie)) ? cookie : null;
}

export function chatRouter(deps: ChatRoutesDeps): Router {
  const router = Router();

  // Historial (vacío si aún no hay sesión: no se crean filas de más).
  router.get('/', (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      const sessionId = await currentSession(deps, req);
      res.json({ messages: sessionId ? await history(deps.pool, sessionId) : [] });
    })().catch(next);
  });

  router.post('/', (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      const parsed = MessageSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(
          res,
          400,
          'validation_error',
          'Mensaje inválido.',
          parsed.error.issues.map((issue) => ({
            field: issue.path.join('.') || '(cuerpo)',
            message: issue.message,
          })),
        );
        return;
      }

      let sessionId = await currentSession(deps, req);
      if (!sessionId) {
        sessionId = await createSession(deps.pool, req.auth?.user.id ?? null);
        res.setHeader('Set-Cookie', chatCookie(sessionId, deps.isProduction));
      }

      const messages = await sendMessage(
        { pool: deps.pool, clock: deps.clock, ai: deps.ai },
        sessionId,
        parsed.data.content,
      );
      res.json({ messages });
    })().catch((error: unknown) => {
      // El proveedor no responde: 502 con mensaje claro (la UI ofrece reintento).
      if (error instanceof AiUnavailableError) {
        sendError(res, 502, 'ai_unavailable', error.message);
        return;
      }
      next(error);
    });
  });

  return router;
}
