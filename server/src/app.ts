import express, { type NextFunction, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import type { Config } from './config.js';
import type { Clock } from './core/clock.js';

/**
 * Composición raíz (docs/03 §7-D): único lugar que cablea dependencias
 * concretas. Todo módulo recibe lo que necesita por parámetro → testeable
 * sin BD ni red, y el ensamblaje es explícito (sin framework de DI).
 * Fase 0: solo `/api/health`, manejo de errores y 404 en formato `{ error }`.
 */
export interface AppDeps {
  readonly config: Config;
  readonly pool: Pool;
  readonly clock: Clock;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.use(express.json());

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', tz: deps.config.tz, now: deps.clock.now().toISOString() });
  });

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
