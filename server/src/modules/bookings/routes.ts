import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { sendError } from '../../core/http.js';
import { parseHm, parseYmd } from '../../core/time.js';
import { UnknownRoomError } from '../quotes/service.js';
import { InvalidTransitionError } from './state.js';
import {
  BookingNotFoundError,
  cancel,
  confirm,
  DraftRuleError,
  getBooking,
  NotDraftError,
  OverlapError,
  saveDraft,
  type BookingDeps,
} from './service.js';

/**
 * Rutas de reservas (Fase 2). Solo traducen HTTP ↔ servicio: zod para la forma
 * de la entrada y mapeo de errores de dominio a códigos (docs/01 §5).
 */

/** La duración se valida como entera aquí; las reglas de horario (bloques, tope) las decide el dominio. */
const DraftBodySchema = z.object({
  id: z.number().int().positive().optional(),
  customerName: z.string().trim().min(1, 'Indica tu nombre.').max(120).optional(),
  customerEmail: z.email('Indica un correo válido.').max(254).optional(),
  roomId: z.number().int().positive('roomId debe ser un identificador positivo').optional(),
  date: z
    .string()
    .refine((value) => parseYmd(value) !== null, 'date debe ser una fecha YYYY-MM-DD válida')
    .optional(),
  startTime: z
    .string()
    .refine((value) => parseHm(value) !== null, 'startTime debe ser una hora HH:MM válida')
    .optional(),
  durationMinutes: z.number().int('durationMinutes debe ser entero').optional(),
  services: z.array(z.enum(['projector', 'coffee'])).optional(),
});

const CancelBodySchema = z.object({
  reason: z
    .string({ error: 'El motivo de la cancelación es obligatorio.' })
    .trim()
    .min(1, 'El motivo de la cancelación es obligatorio.')
    .max(500),
});

const IdParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'El identificador debe ser numérico').transform(Number),
});

/**
 * Mapea los errores de dominio de reservas a su código HTTP. Devuelve `true` si
 * ya respondió. Se reutiliza en `/api/admin/*` para no duplicar el contrato.
 */
export function mapBookingError(res: Response, error: unknown): boolean {
  if (error instanceof BookingNotFoundError) {
    sendError(res, 404, 'not_found', error.message);
    return true;
  }
  if (error instanceof UnknownRoomError) {
    sendError(res, 404, 'unknown_room', error.message);
    return true;
  }
  if (error instanceof NotDraftError) {
    sendError(res, 409, 'not_draft', error.message);
    return true;
  }
  if (error instanceof InvalidTransitionError) {
    sendError(res, 409, 'invalid_transition', error.message);
    return true;
  }
  if (error instanceof OverlapError) {
    res.status(409).json({
      error: {
        code: 'room_unavailable',
        message: error.message,
        ...(error.suggestedSlot ? { details: { suggestedSlot: error.suggestedSlot } } : {}),
      },
    });
    return true;
  }
  if (error instanceof DraftRuleError) {
    sendError(res, 422, 'business_rule', error.message);
    return true;
  }
  return false;
}

export function bookingsRouter(deps: BookingDeps): Router {
  const router = Router();

  // Crea (sin id) o actualiza por paso (con id) un borrador.
  router.post('/', (req: Request, res: Response, next: NextFunction) => {
    const parsed = DraftBodySchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(
        res,
        400,
        'validation_error',
        'Datos de la reserva inválidos.',
        parsed.error.issues.map((issue) => ({
          field: issue.path.join('.') || '(cuerpo)',
          message: issue.message,
        })),
      );
      return;
    }
    const isNew = parsed.data.id === undefined;
    saveDraft(deps, parsed.data)
      .then((view) => res.status(isNew ? 201 : 200).json(view))
      .catch((error: unknown) => (mapBookingError(res, error) ? undefined : next(error)));
  });

  // Retoma el borrador.
  router.get('/:id', (req: Request, res: Response, next: NextFunction) => {
    const parsed = IdParamSchema.safeParse(req.params);
    if (!parsed.success) {
      sendError(res, 400, 'validation_error', 'Identificador de reserva inválido.');
      return;
    }
    getBooking(deps, parsed.data.id)
      .then((view) => res.json(view))
      .catch((error: unknown) => (mapBookingError(res, error) ? undefined : next(error)));
  });

  // Confirmación idempotente: 201 si se creó, 200 si ya estaba confirmada.
  router.post('/:id/confirm', (req: Request, res: Response, next: NextFunction) => {
    const parsed = IdParamSchema.safeParse(req.params);
    if (!parsed.success) {
      sendError(res, 400, 'validation_error', 'Identificador de reserva inválido.');
      return;
    }
    confirm(deps, parsed.data.id)
      .then(({ view, created }) => res.status(created ? 201 : 200).json(view))
      .catch((error: unknown) => (mapBookingError(res, error) ? undefined : next(error)));
  });

  // Cancelación con motivo obligatorio.
  router.post('/:id/cancel', (req: Request, res: Response, next: NextFunction) => {
    const id = IdParamSchema.safeParse(req.params);
    if (!id.success) {
      sendError(res, 400, 'validation_error', 'Identificador de reserva inválido.');
      return;
    }
    const body = CancelBodySchema.safeParse(req.body);
    if (!body.success) {
      sendError(
        res,
        400,
        'validation_error',
        'Datos de cancelación inválidos.',
        body.error.issues.map((issue) => ({
          field: issue.path.join('.') || '(cuerpo)',
          message: issue.message,
        })),
      );
      return;
    }
    cancel(deps, id.data.id, body.data.reason)
      .then((view) => res.json(view))
      .catch((error: unknown) => (mapBookingError(res, error) ? undefined : next(error)));
  });

  return router;
}
