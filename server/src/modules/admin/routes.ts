import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { AiConfig } from '../../config.js';
import type { Clock } from '../../core/clock.js';
import { sendError, type ApiErrorDetail } from '../../core/http.js';
import { BOGOTA_TZ } from '../../core/time.js';
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
  /** Config de IA: aporta modelo y presupuesto a la trazabilidad (Fase 5b). */
  readonly ai: AiConfig;
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

const EMAIL_STATUSES = ['pending', 'sending', 'sent', 'failed', 'skipped'] as const;

const EmailListQuerySchema = z.object({
  status: z.enum(EMAIL_STATUSES).optional(),
  page: z.coerce.number().int('page debe ser un entero').min(1).default(1),
  pageSize: z.coerce.number().int('pageSize debe ser un entero').min(1).max(100).default(10),
});

const ChatUsageQuerySchema = z.object({
  page: z.coerce.number().int('page debe ser un entero').min(1).default(1),
  pageSize: z.coerce.number().int('pageSize debe ser un entero').min(1).max(100).default(20),
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

    // El total se cuenta aparte: `count(*) OVER()` devuelve 0 si la página
    // pedida queda fuera de rango (el contrato debe dar el total real).
    const filters = `WHERE ($1::text IS NULL OR b.status = $1)
                       AND ($2::int IS NULL OR b.room_id = $2)`;
    Promise.all([
      deps.pool.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM bookings b ${filters}`,
        [status ?? null, room ?? null],
      ),
      deps.pool.query<ListItemRow>(
        `SELECT b.id, b.customer_name, b.customer_email, b.room_id, r.name AS room_name,
                b.starts_at, b.ends_at, b.status, b.cancel_reason, b.total, b.created_at
           FROM bookings b
           LEFT JOIN rooms r ON r.id = b.room_id
           ${filters}
          ORDER BY b.created_at DESC, b.id DESC
          LIMIT $3 OFFSET $4`,
        [status ?? null, room ?? null, pageSize, offset],
      ),
    ])
      .then(([totalResult, itemsResult]) => {
        const total = totalResult.rows[0]?.total ?? 0;
        const rows = itemsResult.rows;
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

  // ── Bandeja de correos (Parte 2.1) ────────────────────────────────────────
  // Modelo de lectura del panel: cruza outbox + reserva + sala (igual que el
  // listado de reservas, la SQL de lectura vive en el módulo de admin).
  const EMAIL_COLUMNS = `
    o.id, o.booking_id, o.kind, o.status, o.attempts, o.next_attempt_at, o.last_error,
    o.rendered_subject, o.sent_at, o.created_at,
    b.customer_email AS recipient, b.customer_name, r.name AS room_name`;
  const EMAIL_FROM = `
    FROM email_outbox o
    JOIN bookings b ON b.id = o.booking_id
    LEFT JOIN rooms r ON r.id = b.room_id`;

  interface EmailRow {
    readonly id: number;
    readonly booking_id: number;
    readonly kind: string;
    readonly status: 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';
    readonly attempts: number;
    readonly next_attempt_at: Date;
    readonly last_error: string | null;
    readonly rendered_subject: string;
    readonly sent_at: Date | null;
    readonly created_at: Date;
    readonly recipient: string;
    readonly customer_name: string;
    readonly room_name: string | null;
    readonly body?: string;
  }

  /** El SQL usa snake_case (columnas reales); la API responde camelCase como
   *  el resto de endpoints, para que el contrato sea coherente. */
  function toEmailView(row: EmailRow) {
    return {
      id: row.id,
      bookingId: row.booking_id,
      kind: row.kind,
      status: row.status,
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at,
      lastError: row.last_error,
      subject: row.rendered_subject,
      sentAt: row.sent_at,
      createdAt: row.created_at,
      recipient: row.recipient,
      customerName: row.customer_name,
      roomName: row.room_name,
    };
  }

  router.get('/emails', (req: Request, res: Response, next: NextFunction) => {
    const parsed = EmailListQuerySchema.safeParse(req.query);
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
    const { status, page, pageSize } = parsed.data;
    const filters = `WHERE ($1::text IS NULL OR o.status = $1)`;
    Promise.all([
      deps.pool.query<{ total: number }>(
        `SELECT count(*)::int AS total ${EMAIL_FROM} ${filters}`,
        [status ?? null],
      ),
      deps.pool.query<EmailRow>(
        `SELECT ${EMAIL_COLUMNS}
         ${EMAIL_FROM}
         ${filters}
          ORDER BY o.created_at DESC, o.id DESC
          LIMIT $2 OFFSET $3`,
        [status ?? null, pageSize, (page - 1) * pageSize],
      ),
    ])
      .then(([totalResult, itemsResult]) => {
        const total = totalResult.rows[0]?.total ?? 0;
        const rows = itemsResult.rows;
        res.json({
          items: rows.map((row) => toEmailView(row)),
          page,
          pageSize,
          total,
          totalPages: Math.ceil(total / pageSize),
          filters: { status: status ?? null },
        });
      })
      .catch(next);
  });

  router.get('/emails/:id', (req: Request, res: Response, next: NextFunction) => {
    const parsed = IdParamSchema.safeParse(req.params);
    if (!parsed.success) {
      sendError(res, 400, 'validation_error', 'Identificador de correo inválido.');
      return;
    }
    deps.pool
      .query<EmailRow>(
        `SELECT ${EMAIL_COLUMNS}, o.rendered_body AS body
         ${EMAIL_FROM}
          WHERE o.id = $1`,
        [parsed.data.id],
      )
      .then(({ rows }) => {
        const row = rows[0];
        if (!row) {
          sendError(res, 404, 'not_found', `No existe el correo ${parsed.data.id}.`);
          return;
        }
        res.json({ ...toEmailView(row), body: row.body ?? '' });
      })
      .catch(next);
  });

  // ── Trazabilidad de consumo del asistente (Fase 5b) ───────────────────────
  // Lee chat_messages directamente (SQL de lectura del panel, igual que el
  // resto): totales + turno paginado con el consumo de CADA llamada al modelo.

  interface UsageRow {
    readonly id: number;
    readonly session_id: string;
    readonly role: string;
    readonly created_at: Date;
    readonly preview: string;
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly reasoning_tokens: number;
    readonly cost_usd: string;
    readonly model: string | null;
  }

  router.get('/chat/usage', (req: Request, res: Response, next: NextFunction) => {
    const parsed = ChatUsageQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendError(
        res,
        400,
        'validation_error',
        'Paginación inválida.',
        validationDetails(parsed.error.issues),
      );
      return;
    }
    const { page, pageSize } = parsed.data;
    const budget = deps.ai.limits.monthlyTokenBudget;

    const summary = deps.pool.query<{
      messages: number;
      turns: number;
      sessions: string;
      prompt_tokens: string;
      completion_tokens: string;
      reasoning_tokens: string;
      cost_usd: string;
      month_tokens: string;
    }>(
      `SELECT count(*)::int AS messages,
              count(*) FILTER (WHERE role = 'assistant')::int AS turns,
              count(DISTINCT session_id)::bigint AS sessions,
              COALESCE(sum(prompt_tokens), 0)::bigint AS prompt_tokens,
              COALESCE(sum(completion_tokens), 0)::bigint AS completion_tokens,
              COALESCE(sum(reasoning_tokens), 0)::bigint AS reasoning_tokens,
              COALESCE(sum(cost_usd), 0)::numeric AS cost_usd,
              COALESCE(sum(prompt_tokens + completion_tokens)
                FILTER (WHERE created_at >= date_trunc('month', now() AT TIME ZONE $1)
                                                 AT TIME ZONE $1), 0)::bigint AS month_tokens
         FROM chat_messages`,
      [BOGOTA_TZ],
    );

    const items = deps.pool.query<UsageRow>(
      `SELECT id, session_id, role, created_at, left(content, 140) AS preview,
              prompt_tokens, completion_tokens, reasoning_tokens, cost_usd, model
         FROM chat_messages
        ORDER BY created_at DESC, id DESC
        LIMIT $1 OFFSET $2`,
      [pageSize, (page - 1) * pageSize],
    );

    Promise.all([summary, items])
      .then(([summaryResult, itemsResult]) => {
        const s = summaryResult.rows[0];
        const rows = itemsResult.rows;
        // `summary.messages` cuenta toda la tabla, no la página: así el total
        // sigue siendo correcto aunque se pida una página fuera de rango.
        const total = s?.messages ?? 0;
        res.json({
          summary: {
            messages: s?.messages ?? 0,
            turns: s?.turns ?? 0,
            sessions: Number(s?.sessions ?? 0),
            promptTokens: Number(s?.prompt_tokens ?? 0),
            completionTokens: Number(s?.completion_tokens ?? 0),
            reasoningTokens: Number(s?.reasoning_tokens ?? 0),
            costUsd: Number(s?.cost_usd ?? 0),
            monthTokens: Number(s?.month_tokens ?? 0),
            monthBudget: budget ?? null,
            model: deps.ai.model,
          },
          items: rows.map((row) => ({
            id: row.id,
            sessionId: row.session_id,
            role: row.role === 'assistant' ? 'assistant' : 'user',
            createdAt: row.created_at,
            preview: row.preview,
            promptTokens: row.prompt_tokens,
            completionTokens: row.completion_tokens,
            reasoningTokens: row.reasoning_tokens,
            costUsd: Number(row.cost_usd),
            model: row.model,
          })),
          page,
          pageSize,
          total,
          totalPages: Math.ceil(total / pageSize),
        });
      })
      .catch(next);
  });

  return router;
}
