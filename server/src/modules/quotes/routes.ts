import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { sendError } from '../../core/http.js';
import { parseHm, parseYmd } from '../../core/time.js';
import { listRooms, quoteRoom, UnknownRoomError, type QuoteDeps } from './service.js';

/**
 * Rutas del cotizador (Fase 1). Solo traducen HTTP ↔ servicio: validan la
 * entrada con zod y mapean errores del dominio a códigos HTTP (docs/01 §5).
 */
const QuoteBodySchema = z.object({
  roomId: z.number().int().positive('roomId debe ser un identificador positivo'),
  date: z
    .string()
    .refine((value) => parseYmd(value) !== null, 'date debe ser una fecha YYYY-MM-DD válida'),
  startTime: z
    .string()
    .refine((value) => parseHm(value) !== null, 'startTime debe ser una hora HH:MM válida'),
  durationMinutes: z.number().int('durationMinutes debe ser un número entero de minutos'),
});

export function quotesRouter(deps: QuoteDeps): Router {
  const router = Router();

  router.get('/rooms', (_req: Request, res: Response, next: NextFunction) => {
    listRooms(deps)
      .then((rooms) => res.json({ rooms }))
      .catch(next);
  });

  router.post('/quotes', (req: Request, res: Response, next: NextFunction) => {
    const parsed = QuoteBodySchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(
        res,
        400,
        'validation_error',
        'Datos de cotización inválidos.',
        parsed.error.issues.map((issue) => ({
          field: issue.path.join('.') || '(cuerpo)',
          message: issue.message,
        })),
      );
      return;
    }

    quoteRoom(deps, parsed.data)
      .then((result) => res.json(result))
      .catch((error: unknown) => {
        if (error instanceof UnknownRoomError) {
          sendError(res, 404, 'unknown_room', `No existe la sala ${error.roomId}.`);
          return;
        }
        next(error);
      });
  });

  return router;
}
