import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Clock } from '../../core/clock.js';
import { sendError, type ApiErrorDetail } from '../../core/http.js';
import { cancel, getBooking, type BookingDeps } from '../bookings/service.js';
import { mapBookingError } from '../bookings/routes.js';
import type { Pool } from 'pg';

/**
 * Rutas del panel de administración (Fase 3). Todas van tras `requireRole('admin')`
 * (se monta así en `app.ts`) y pasan por el servicio de reservas para leer y
 * cancelar: un módulo nunca copia el SQL de otro (docs/02 §4).
 *
 * Validación con zod: `status` o `room` inválidos → **400** (contrato `01` §2.3).
 */
export interface AdminDeps {
  readonly pool: Pool;
  readonly clock: Clock;
}

const STATUSES = ['draft', 'confirmed', 'completed', 'cancelled'] as const;

const ListQuerySchema = z.object({
  page: z.coerce.number().int('page debe ser un entero').min(1).default(1),
  pageSize: z.coerce.number().int('pageSize debe ser un entero').min(1).max(100).default(10),
  status: z.enum(STATUSES).optional(),
  room: z.coerce.number().int('room debe ser un entero').positive().optional(),
});

const CancelBodySchema = z.object({
  reason: z.string({ error: 'El motivo es obligatorio.' }).trim().min(1, 'El motivo es obligatorio.').max(500),
});

const IdParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'El identificador debe ser numérico').transform(Number),
});

interface ListItemRow {
  readonly id: number;
  readonly customer_name: string;
  readonly customer_email: string;
  readonly room_id: number | null;
  readonly room_name: string | null;
  readonly starts_at: Date | null;
  readonly ends_at: Date | null;
  readonly status: string;
  readonly cancel_reason: string | null;
  readonly total: string | null;
  readonly created_at: Date;
  readonly total_rows: number;
}

/** Errores de zod al formato del contrato `{ error: { details: [{field,…}] } }`. */
function validationDetails(issues: readonly { path?: readonly PropertyKey[]; message?: string }[]): ApiErrorDetail[] {
  return issues.map((issue) => ({
    field: issue.path?.join('.') || '(consulta)',
    message: issue.message ?? 'Valor inválido.',
  }));
}

export function adminRouter(deps: AdminDeps): Router {
  const router = Router();
  const bookingDeps: BookingDeps = { pool: deps.pool, clock: deps.clock };

  // Listado paginado con filtros por estado y sala.
  router.get('/bookings', (req: Request, res: Response, next: NextFunction) => {
    const parsed = ListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendError(
        res,
        400,
        'validation_error',
        'Filtros o paginación inválidos.',
        validationDetails(parsed.error.issues),
      );
      return;
    }

    const { page, pageSize, status, room } = parsed.data;
    const offset = (page - 1) * pageSize;

    deps.pool
      .query<ListItemRow>(
        `SELECT count(*) OVER()::int AS total_rows,
                b.id, b.customer_name, b.customer_email, b.room_id, r.name AS room_name,
                b.starts_at, b.ends_at, b.status, b.cancel_reason, b.total, b.created_at
           FROM bookings b
           LEFT JOIN rooms r ON r.id = b.room_id
          WHERE ($1::text IS NULL OR b.status = $1)
            AND ($2::int IS NULL OR b.room_id = $2)
          ORDER BY b.created_at DESC, b.id DESC
          LIMIT $3 OFFSET $4`,
        [status ?? null, room ?? null, pageSize, offset],
      )
      .then(({ rows }) => {
        const total = rows[0]?.total_rows ?? 0;
        res.json({
          items: rows.map((row) => ({
            id: row.id,
            customerName: row.customer_name,
            customerEmail: row.customer_email,
            roomId: row.room_id,
            roomName: row.room_name,
            startsAt: row.starts_at,
            endsAt: row.ends_at,
            status: row.status,
            cancelReason: row.cancel_reason,
            total: row.total === null ? null : Number(row.total),
            createdAt: row.created_at,
          })),
          page,
          pageSize,
          total,
          totalPages: Math.ceil(total / pageSize),
          filters: { status: status ?? null, room: room ?? null },
        });
      })
      .catch(next);
  });

  // Detalle con líneas.
  router.get('/bookings/:id', (req: Request, res: Response, next: NextFunction) => {
    const parsed = IdParamSchema.safeParse(req.params);
    if (!parsed.success) {
      sendError(res, 400, 'validation_error', 'Identificador de reserva inválido.');
      return;
    }
    getBooking(bookingDeps, parsed.data.id)
      .then((view) => res.json(view))
      .catch((error: unknown) => (mapBookingError(res, error) ? undefined : next(error)));
  });

  // Cancelar con motivo obligatorio (mismo servicio que usa el cliente).
  router.post('/bookings/:id/cancel', (req: Request, res: Response, next: NextFunction) => {
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
        'Falta el motivo de la cancelación.',
        validationDetails(body.error.issues),
      );
      return;
    }
    cancel(bookingDeps, id.data.id, body.data.reason)
      .then((view) => res.json(view))
      .catch((error: unknown) => (mapBookingError(res, error) ? undefined : next(error)));
  });

  return router;
}
