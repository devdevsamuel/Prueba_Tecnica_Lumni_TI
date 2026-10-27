import express, { type NextFunction, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import type { Config } from './config.js';
import type { Clock } from './core/clock.js';
import { adminRouter } from './modules/admin/routes.js';
import { attachSession, requireRole } from './modules/auth/middleware.js';
import { authRouter } from './modules/auth/routes.js';
import { bookingsRouter } from './modules/bookings/routes.js';
import { OpenCodeAiClient, type AiClient } from './modules/chat/aiClient.js';
import { chatRouter } from './modules/chat/routes.js';
import { quotesRouter } from './modules/quotes/routes.js';

/**
 * Composición raíz (docs/03 §7-D): único lugar que cablea dependencias
 * concretas. Todo módulo recibe lo que necesita por parámetro → testeable
 * sin BD ni red, y el ensamblaje es explícito (sin framework de DI).
 *
 * `ai` es opcional: los tests inyectan un doble del modelo; en producción usa
 * `OpenCodeAiClient` con la configuración de `.env`.
 */
export interface AppDeps {
  readonly config: Config;
  readonly pool: Pool;
  readonly clock: Clock;
  readonly ai?: AiClient;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.use(express.json());

  // Sesión: adjunta `req.auth` si la cookie es válida (solo consulta si hay cookie).
  app.use(attachSession(deps.pool, deps.config.sessionSecret));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', tz: deps.config.tz, now: deps.clock.now().toISOString() });
  });

  // Sesiones (Fase 3).
  app.use(
    '/api/auth',
    authRouter({
      pool: deps.pool,
      secret: deps.config.sessionSecret,
      isProduction: deps.config.isProduction,
    }),
  );

  // Chat con IA (Fase 5).
  app.use(
    '/api/chat',
    chatRouter({
      pool: deps.pool,
      clock: deps.clock,
      ai: deps.ai ?? new OpenCodeAiClient(deps.config.ai),
      limits: deps.config.ai.limits,
      isProduction: deps.config.isProduction,
    }),
  );

  // Panel de administración (Fase 3): 401 sin sesión, 403 si no es admin.
  // Lleva la config de IA para la trazabilidad de consumo (Fase 5b).
  app.use(
    '/api/admin',
    requireRole('admin'),
    adminRouter({ pool: deps.pool, clock: deps.clock, ai: deps.config.ai }),
  );

  // Reservas (Fase 2) — antes que el cotizador por ser más específico.
  app.use('/api/bookings', bookingsRouter({ pool: deps.pool, clock: deps.clock }));

  // Cotizador y salas (Fase 1).
  app.use('/api', quotesRouter({ pool: deps.pool, clock: deps.clock }));

  // 404 en el contrato de errores de docs/01 §5.
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Recurso no encontrado.' } });
  });

  // Error handler (Express reconoce los handlers de 4 parámetros).
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Error no controlado:', error);
    res.status(500).json({ error: { code: 'internal_error', message: 'Error interno del servidor.' } });
  });

  return app;
}
