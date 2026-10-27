import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import type { AiLimits } from '../../config.js';
import type { Clock } from '../../core/clock.js';
import { BOGOTA_TZ, bogotaDateStr, formatMinutes } from '../../core/time.js';
import { SERVICE_CATALOG, serviceLabel } from '../bookings/pricing.js';
import { saveDraft, DraftRuleError } from '../bookings/service.js';
import { listRooms, quoteRoom, UnknownRoomError } from '../quotes/service.js';
import {
  CLOSE_MINUTES,
  MAX_DURATION_MINUTES,
  MIN_DURATION_MINUTES,
  OPEN_MINUTES,
  SLOT_MINUTES,
  type Slot as SuggestedSlot,
} from '../quotes/quote.js';
import type { AiClient, AiUsage, ChatTurn } from './aiClient.js';
import { resolveSlot, type DayRef, type PartOfDay } from './dateResolver.js';
import { parseActionValue, parseAssistantAction, type AssistantAction } from './schema.js';

/**
 * Chat con IA (Parte 2.2). Implementa "el modelo propone, la app ejecuta"
 * (docs/03 §6.2):
 *
 *   historial → prompt + contexto (salas, hoy) → modelo → **zod** → despacho de
 *   la acción → datos REALES (cotizador / servicio de reservas) → persistencia.
 *
 * Todo lo que toca datos reales pasa por el servicio de otro módulo; aquí no
 * hay SQL de salas ni de reservas (docs/02 §4). La única SQL propia es la de
 * `chat_sessions` y `chat_messages`.
 *
 * **Fase 5b (docs/03 §6.3):** antes de llamar al modelo se comprueban los
 * límites de uso (por sesión y presupuesto mensual) y el `usage` de cada
 * llamada se guarda en el mensaje: de ahí cuelga la trazabilidad del panel.
 */
export interface ChatDeps {
  readonly pool: Pool;
  readonly clock: Clock;
  readonly ai: AiClient;
  readonly limits: AiLimits;
}

/** Límite por sesión alcanzado: la ruta lo traduce a 429 + `Retry-After`. */
export class RateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(message);
    this.name = 'RateLimitError';
  }
}

/** Tarjeta que ve la UI. Los precios son REALES: los calcula el cotizador. */
export interface ChatCard {
  readonly kind: 'quote' | 'suggest' | 'create_draft';
  readonly roomId: number;
  readonly roomName: string;
  readonly capacity: number;
  readonly date: string;
  readonly startTime: string;
  readonly durationMinutes: number;
  readonly base: number;
  readonly discount: number;
  readonly discountPercent: number;
  readonly surcharge: number;
  /** Servicios adicionales (proyector/café); 0 en una cotización de sala. */
  readonly services: number;
  readonly total: number;
  readonly canBook: boolean;
  readonly reason: string | null;
  readonly suggestedSlot: SuggestedSlot | null;
  readonly draftId?: number;
}

export interface ChatMessageView {
  readonly id: number;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly createdAt: Date;
  readonly action: AssistantAction | null;
  readonly card: ChatCard | null;
}

/** Historial que se reenvía al modelo: 6 mensajes bastan para el contexto y
 *  recortan ~30 % de entrada en conversaciones largas (Fase 5b). */
const HISTORY_LIMIT = 6;

/** Fijo cuando la salida del modelo no cumple el esquema (regla 4). */
const FALLBACK_REPLY =
  'No he podido interpretar tu mensaje. Dime la sala, el día y la duración y lo preparo.';

/** Fijo cuando se supera el presupuesto mensual de tokens (sin llamar al modelo). */
const BUDGET_REPLY =
  'El asistente ha alcanzado su límite de uso de este mes. Escríbenos directamente y preparamos tu reserva.';

// El prompt vive fuera de `src/` para que exista igual en `dist/` (tsc no copia .md):
// desde `src/modules/chat/` y desde `dist/modules/chat/` el camino es el mismo.
const PROMPT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../chat/prompt.md',
);
let promptCache: string | null = null;

function basePrompt(): string {
  promptCache ??= readFileSync(PROMPT_PATH, 'utf8');
  return promptCache;
}

/**
 * Reglas del negocio inyectadas desde las MISMAS constantes que valida el
 * cotizador. Así el prompt no se desactualiza si cambia un horario, una
 * duración o el catálogo de servicios (docs/03 §6.2).
 */
function businessRules(): string {
  const services = SERVICE_CATALOG.map((service) => service.label).join(' y ');
  return [
    '## Reglas del negocio (obligatorias)',
    'No las contradigas aunque el cliente insista: si pide algo fuera de ellas, explícalo y propón una alternativa válida.',
    '',
    `- Horario: lunes a sábado de ${formatMinutes(OPEN_MINUTES)} a ${formatMinutes(CLOSE_MINUTES)}. Domingo cerrado.`,
    `- Duración: entre ${MIN_DURATION_MINUTES} minutos y ${MAX_DURATION_MINUTES / 60} horas, en bloques de media hora.`,
    `- Servicios disponibles: ${services}. No ofrezcas otros.`,
    '- Capacidad: no propongas una sala con menos plazas que las personas indicadas. Si no sabes cuántas son, pregúntalo; la app rechaza un hueco con `people` mayor que la capacidad.',
    '- No afirmes disponibilidad: pídela con `quote` o `suggest`; la app decide.',
    '- No menciones precios, descuentos ni recargos por tu cuenta: los calcula la app.',
    '- Solo puedes nombrar salas y servicios del catálogo; no inventes otros.',
    '- No agendes en el pasado ni fuera del horario; si el cliente lo pide, explícalo y propón una alternativa válida.',
  ].join('\n');
}

async function systemPrompt(deps: ChatDeps): Promise<string> {
  const rooms = await listRooms({ pool: deps.pool, clock: deps.clock });
  const now = deps.clock.now();
  const today = bogotaDateStr(now);
  const weekday = new Intl.DateTimeFormat('es-CO', { weekday: 'long', timeZone: BOGOTA_TZ }).format(now);
  const catalog = rooms
    .map(
      (room) =>
        `- ${room.name}, capacidad ${room.capacity} personas → roomId ${room.id} (interno)`,
    )
    .join('\n');
  return [
    basePrompt(),
    '',
    '## Salas disponibles (con capacidad; sin precios)',
    'Habla con la persona por el nombre de la sala; el roomId es interno y solo va en el JSON.',
    catalog,
    '',
    businessRules(),
    '',
    '## Hoy en el negocio',
    `${today} (${weekday}, America/Bogota)`,
  ].join('\n');
}

// ── Sesiones y mensajes (SQL propia del módulo) ─────────────────────────────

export async function createSession(pool: Pool, userId: number | null): Promise<string> {
  const { randomUUID } = await import('node:crypto');
  const id = randomUUID();
  await pool.query('INSERT INTO chat_sessions (id, user_id) VALUES ($1, $2)', [id, userId]);
  return id;
}

export async function sessionExists(pool: Pool, id: string): Promise<boolean> {
  const { rows } = await pool.query('SELECT 1 FROM chat_sessions WHERE id = $1', [id]);
  return rows.length > 0;
}

/**
 * Limpia el historial VISIBLE: marca la sesión y el chat solo lee lo posterior
 * al marcador. No se borran filas porque son la fuente de los límites de uso,
 * el presupuesto mensual y la trazabilidad del admin (docs/03 §6.3).
 */
export async function clearVisibleHistory(pool: Pool, sessionId: string): Promise<void> {
  await pool.query('UPDATE chat_sessions SET cleared_at = now() WHERE id = $1', [sessionId]);
}

/** Revalida lo guardado: nunca se confía lo que hay en la BD. */
function parseStoredAction(raw: unknown): { action: AssistantAction; card: ChatCard | null } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const holder = raw as { action?: unknown; card?: unknown };
  try {
    const action = parseActionValue(holder.action);
    const card =
      typeof holder.card === 'object' && holder.card !== null ? (holder.card as ChatCard) : null;
    return { action, card };
  } catch {
    return null;
  }
}

/** Historial completo con sus acciones revalidadas. */
export async function history(pool: Pool, sessionId: string): Promise<ChatMessageView[]> {
  const { rows } = await pool.query<{
    id: number;
    role: string;
    content: string;
    created_at: Date;
    action_json: unknown;
  }>(
    `SELECT m.id, m.role, m.content, m.created_at, m.action_json
       FROM chat_messages m
       JOIN chat_sessions s ON s.id = m.session_id
      WHERE m.session_id = $1
        AND m.created_at > COALESCE(s.cleared_at, '-infinity'::timestamptz)
      ORDER BY m.id ASC`,
    [sessionId],
  );
  return rows.map((row) => {
    const stored = parseStoredAction(row.action_json);
    return {
      id: row.id,
      role: row.role === 'assistant' ? 'assistant' : 'user',
      content: row.content,
      createdAt: row.created_at,
      action: stored?.action ?? null,
      card: stored?.card ?? null,
    };
  });
}

async function appendMessage(
  pool: Pool,
  sessionId: string,
  role: 'user' | 'assistant',
  content: string,
  action: { action: AssistantAction; card: ChatCard | null } | null,
  usage?: AiUsage | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO chat_messages
       (session_id, role, content, action_json, prompt_tokens, completion_tokens, reasoning_tokens, cost_usd, model)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      sessionId,
      role,
      content,
      action === null ? null : JSON.stringify(action),
      usage?.promptTokens ?? 0,
      usage?.completionTokens ?? 0,
      usage?.reasoningTokens ?? 0,
      usage?.costUsd ?? 0,
      usage?.model ?? null,
    ],
  );
}

// ── Límites de uso (Fase 5b, docs/03 §6.3) ──────────────────────────────────

/** Suma el consumo de dos llamadas (el reintento del esquema también gasta). */
function mergeUsage(a: AiUsage, b: AiUsage): AiUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    costUsd: a.costUsd + b.costUsd,
    model: b.model || a.model,
  };
}

/**
 * Ventanas móviles sobre los mensajes propios de la sesión (5/min y 50/24 h).
 * Se calcula TODO en la BD con `now()`: la misma referencia que usa
 * `created_at`, así no hay relojes en desacuerdo. El `Retry-After` sale de la
 * fila más antigua de la ventana (segundos que faltan para que salga de ella).
 */
async function assertWithinRate(deps: ChatDeps, sessionId: string): Promise<void> {
  const { rows } = await deps.pool.query<{
    last_minute: number;
    last_day: number;
    retry_minute: number | null;
    retry_day: number | null;
  }>(
    `SELECT count(*) FILTER (WHERE created_at > now() - interval '1 minute')::int AS last_minute,
            count(*) FILTER (WHERE created_at > now() - interval '1 day')::int AS last_day,
            ceil(60 - extract(epoch FROM (now() - min(created_at)
              FILTER (WHERE created_at > now() - interval '1 minute'))))::int AS retry_minute,
            ceil(86400 - extract(epoch FROM (now() - min(created_at)
              FILTER (WHERE created_at > now() - interval '1 day'))))::int AS retry_day
       FROM chat_messages
      WHERE session_id = $1 AND role = 'user'`,
    [sessionId],
  );
  const row = rows[0];
  if (!row) return;
  if (row.last_minute >= deps.limits.perMinute) {
    const seconds = Math.max(1, row.retry_minute ?? 60);
    throw new RateLimitError(
      `Has enviado demasiados mensajes seguidos. Espera ${seconds} s y vuelve a escribir.`,
      seconds,
    );
  }
  if (row.last_day >= deps.limits.perDay) {
    const seconds = Math.max(1, row.retry_day ?? 3600);
    throw new RateLimitError(
      'Has alcanzado el límite diario de mensajes del asistente. Vuelve más tarde.',
      seconds,
    );
  }
}

/**
 * Presupuesto global mensual de tokens (entrada + salida). Vacío en `.env` =
 * sin límite; si está activo y se supera, se contesta con el mensaje fijo
 * **sin llamar al modelo** (corte de coste real, no solo un aviso).
 */
async function isBudgetExhausted(deps: ChatDeps): Promise<boolean> {
  const budget = deps.limits.monthlyTokenBudget;
  if (budget === undefined) return false;
  const { rows } = await deps.pool.query<{ used: string }>(
    `SELECT COALESCE(sum(prompt_tokens + completion_tokens), 0)::bigint AS used
       FROM chat_messages
      WHERE created_at >= date_trunc('month', now() AT TIME ZONE $1) AT TIME ZONE $1`,
    [BOGOTA_TZ],
  );
  return Number(rows[0]?.used ?? 0) >= budget;
}

// ── Acciones: el registro es el que se amplía (docs/03 §7-O) ────────────────

interface HandlerOutcome {
  readonly reply: string;
  readonly card: ChatCard | null;
}

/** Tarjeta a partir de la respuesta REAL del cotizador (solo sala: sin servicios). */
function cardFrom(kind: ChatCard['kind'], quote: Awaited<ReturnType<typeof quoteRoom>>): ChatCard {
  return {
    kind,
    roomId: quote.room.id,
    roomName: quote.room.name,
    capacity: quote.room.capacity,
    date: quote.date,
    startTime: quote.startTime,
    durationMinutes: quote.durationMinutes,
    base: quote.base,
    discount: quote.discount,
    discountPercent: quote.discountPercent,
    surcharge: quote.surcharge,
    services: 0,
    total: quote.total,
    canBook: quote.canBook,
    reason: quote.reason,
    suggestedSlot: quote.suggestedSlot,
  };
}

/**
 * Capa dura de capacidad (D-01/D-03 de la auditoría del chat). Solo actúa si la
 * persona dijo cuántas son (`people`); el prompt sigue pidiendo el dato. Si la
 * sala elegida no cabe, no se presenta como válida ni se crea un borrador.
 */
async function capacityOutcome(
  deps: ChatDeps,
  action: { readonly people?: number },
  room: { readonly name: string; readonly capacity: number },
): Promise<HandlerOutcome | null> {
  const people = action.people;
  if (people === undefined || room.capacity >= people) return null;

  const rooms = await listRooms({ pool: deps.pool, clock: deps.clock });
  const fitting = rooms.filter((candidate) => candidate.capacity >= people);
  if (fitting.length === 0) {
    const largest = rooms.reduce((best, candidate) => Math.max(best, candidate.capacity), 0);
    return {
      reply: `Ninguna sala admite ${people} personas (la mayor tiene ${largest}). ¿Puedes ajustar el número de personas?`,
      card: null,
    };
  }

  const options = fitting
    .map((candidate) => `${candidate.name} (hasta ${candidate.capacity})`)
    .join(', ');
  return {
    reply: `${room.name} solo admite ${room.capacity} personas y sois ${people}. Puedo usar ${options}. ¿Cuál prefieres?`,
    card: null,
  };
}

/** Resuelve el hueco del modelo y lo cotiza con los datos reales. */
async function quoteFor(
  deps: ChatDeps,
  action: {
    roomId: number;
    dayRef: DayRef;
    partOfDay: PartOfDay;
    durationMinutes: number;
    startTime?: string;
  },
): ReturnType<typeof quoteRoom> {
  const slot = resolveSlot({
    dayRef: action.dayRef,
    partOfDay: action.partOfDay,
    ...(action.startTime !== undefined ? { startTime: action.startTime } : {}),
    now: deps.clock.now(),
  });
  return quoteRoom(
    { pool: deps.pool, clock: deps.clock },
    {
      roomId: action.roomId,
      date: slot.date,
      startTime: slot.startTime,
      durationMinutes: action.durationMinutes,
    },
  );
}

async function handleAsk(_deps: ChatDeps, action: AssistantAction): Promise<HandlerOutcome> {
  if (action.action !== 'ask') throw new Error('handleAsk con otra acción');
  return { reply: action.text, card: null };
}

async function handleQuote(deps: ChatDeps, action: AssistantAction): Promise<HandlerOutcome> {
  if (action.action !== 'quote') throw new Error('handleQuote con otra acción');
  const quote = await quoteFor(deps, action);
  const capacity = await capacityOutcome(deps, action, quote.room);
  if (capacity) return capacity;
  const card = cardFrom('quote', quote);
  if (quote.canBook) {
    return {
      reply: `${quote.room.name} está libre el ${quote.date} de ${quote.startTime} a ${quote.endTime}: ${card.total} por la sala. ¿Te va bien a las ${quote.startTime}?`,
      card,
    };
  }
  // Regla 1: la alternativa la calcula el backend, no el modelo.
  const alternative = quote.suggestedSlot
    ? ` ¿Te va el mismo día a las ${quote.suggestedSlot.startTime}?`
    : '';
  return { reply: `Por ahora no se puede: ${quote.reason}.${alternative}`, card };
}

async function handleSuggest(deps: ChatDeps, action: AssistantAction): Promise<HandlerOutcome> {
  if (action.action !== 'suggest') throw new Error('handleSuggest con otra acción');
  const first = await quoteFor(deps, action);
  const capacity = await capacityOutcome(deps, action, first.room);
  if (capacity) return capacity;

  // Si ese hueco no va, se cotiza el siguiente libre que ya calculó el backend.
  const usable =
    first.canBook || !first.suggestedSlot
      ? first
      : await quoteRoom(
          { pool: deps.pool, clock: deps.clock },
          {
            roomId: action.roomId,
            date: first.suggestedSlot.date,
            startTime: first.suggestedSlot.startTime,
            durationMinutes: action.durationMinutes,
          },
        );

  const card = cardFrom('suggest', usable);
  if (usable.canBook) {
    return {
      reply: `Te propongo ${usable.room.name} el ${usable.date} de ${usable.startTime} a ${usable.endTime}: ${card.total} por la sala. ¿Te va bien a las ${usable.startTime}?`,
      card,
    };
  }
  return { reply: `Tampoco hay hueco disponible: ${usable.reason}`, card };
}

async function handleCreateDraft(deps: ChatDeps, action: AssistantAction): Promise<HandlerOutcome> {
  if (action.action !== 'create_draft') throw new Error('handleCreateDraft con otra acción');

  // 1) La app cotiza ANTES de crear nada. `saveDraft` permite un borrador para
  //    un hueco ocupado (un draft no reserva), pero el chat no debe presentarlo
  //    como reserva preparada: sería "ofrecer algo que no va".
  const quote = await quoteFor(deps, action);
  const capacity = await capacityOutcome(deps, action, quote.room);
  if (capacity) return capacity;
  if (!quote.canBook) {
    const alternative = quote.suggestedSlot
      ? ` ¿Te va el mismo día a las ${quote.suggestedSlot.startTime}?`
      : '';
    return {
      reply: `No puedo dejar preparada la reserva: ${quote.reason}.${alternative}`,
      card: cardFrom('quote', quote),
    };
  }

  // 2) Sin hora exacta no se crea NADA: se propone la hora por defecto de la
  //    franja y se pide confirmación. La elección de la hora no es del modelo.
  if (action.startTime === undefined) {
    const servicesNote =
      action.services.length > 0
        ? ` Añadiré ${action.services.map((service) => serviceLabel(service)).join(' y ')} al preparar el borrador; el total mostrado es solo la sala.`
        : '';
    return {
      reply:
        `Antes de dejarla preparada, te propongo ${quote.room.name} el ${quote.date} de ${quote.startTime} a ${quote.endTime}: ${quote.total}.` +
        `${servicesNote} ¿Te va bien a las ${quote.startTime}?`,
      card: cardFrom('suggest', quote),
    };
  }

  let draftId: number;
  let draftLines: readonly { kind: string; amount: number }[];
  let draftTotal: number | null;
  let draftDate: string | null;
  let draftStart: string | null;
  let draftDuration: number | null;
  let roomName: string | null;
  try {
    const draft = await saveDraft(
      { pool: deps.pool, clock: deps.clock },
      {
        roomId: action.roomId,
        date: quote.date,
        startTime: quote.startTime,
        durationMinutes: action.durationMinutes,
        services: action.services,
        ...(action.customerName !== undefined ? { customerName: action.customerName } : {}),
        ...(action.customerEmail !== undefined ? { customerEmail: action.customerEmail } : {}),
      },
    );
    draftId = draft.id;
    draftLines = draft.lines;
    draftTotal = draft.total;
    draftDate = draft.date;
    draftStart = draft.startTime;
    draftDuration = draft.durationMinutes;
    roomName = draft.roomName;
  } catch (error) {
    // Regla 2: no se improvisa; se explica el motivo real que dio el dominio.
    const message =
      error instanceof DraftRuleError ? error.message : 'No se pudo preparar la reserva.';
    return { reply: `No he podido prepararlo: ${message}`, card: null };
  }

  // El cotizador aporta capacidad y disponibilidad; el IMPORTE sale de las
  // líneas del borrador, que es lo que incluye los servicios y ya cuadra con
  // el total congelado (si no, la tarjeta y la reserva dirían importes distintos).
  // Suma por tipo de línea (los servicios pueden ser varios), en valor absoluto:
  // los descuentos se guardan en negativo para que SUM(líneas) = total.
  const sumOf = (kind: string): number =>
    draftLines
      .filter((item) => item.kind === kind)
      .reduce((total, item) => total + Math.abs(item.amount), 0);
  const base = sumOf('base');
  const discount = sumOf('discount');
  const finalDate = draftDate ?? quote.date;
  const finalStart = draftStart ?? quote.startTime;
  const card: ChatCard = {
    kind: 'create_draft',
    roomId: quote.room.id,
    roomName: quote.room.name,
    capacity: quote.room.capacity,
    date: finalDate,
    startTime: finalStart,
    durationMinutes: draftDuration ?? action.durationMinutes,
    base,
    discount,
    discountPercent: base > 0 && discount > 0 ? Math.round((discount / base) * 100) : 0,
    surcharge: sumOf('surcharge'),
    services: sumOf('service'),
    total: draftTotal ?? 0,
    canBook: quote.canBook,
    reason: quote.reason,
    suggestedSlot: quote.suggestedSlot,
    draftId,
  };

  return {
    reply:
      `He dejado preparada la reserva #${draftId}: ${roomName ?? 'sala'} el ${finalDate} a las ${finalStart}. ` +
      'Entra en "Reservar" y confírmala con el botón: yo no puedo confirmar por ti.',
    card,
  };
}

/**
 * Despachador exhaustivo: el registro mantiene la extensibilidad (añadir una
 * acción = añadir una entrada) y el `switch` da el estrechamiento de tipos.
 * `assertNever` obliga a cubrir toda acción nueva.
 */
type Handlers = {
  [K in AssistantAction['action']]: (deps: ChatDeps, action: AssistantAction) => Promise<HandlerOutcome>;
};

const handlers: Handlers = {
  ask: handleAsk,
  quote: handleQuote,
  suggest: handleSuggest,
  create_draft: handleCreateDraft,
};

function assertNever(value: never): never {
  throw new Error(`Acción no soportada: ${JSON.stringify(value)}`);
}

async function dispatch(deps: ChatDeps, action: AssistantAction): Promise<HandlerOutcome> {
  switch (action.action) {
    case 'ask':
      return handlers.ask(deps, action);
    case 'quote':
      return handlers.quote(deps, action);
    case 'suggest':
      return handlers.suggest(deps, action);
    case 'create_draft':
      return handlers.create_draft(deps, action);
    default:
      return assertNever(action);
  }
}

// ── Envío de un mensaje ─────────────────────────────────────────────────────

function tryParseAction(
  raw: string,
): { ok: true; action: AssistantAction } | { ok: false; error: string } {
  try {
    return { ok: true, action: parseAssistantAction(raw) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'JSON inválido' };
  }
}

export async function sendMessage(
  deps: ChatDeps,
  sessionId: string,
  content: string,
): Promise<ChatMessageView[]> {
  // 0) Límites ANTES de tocar el modelo y ANTES de persistir nada: un 429 no
  //    gasta tokens y deja la conversación intacta para un reintento limpio.
  await assertWithinRate(deps, sessionId);

  // 1) historial para el modelo (sin el mensaje actual: se añade abajo en turno)
  const { rows: previous } = await deps.pool.query<{ role: string; content: string }>(
    `SELECT m.role, m.content
       FROM chat_messages m
       JOIN chat_sessions s ON s.id = m.session_id
      WHERE m.session_id = $1
        AND m.created_at > COALESCE(s.cleared_at, '-infinity'::timestamptz)
      ORDER BY m.id DESC LIMIT $2`,
    [sessionId, HISTORY_LIMIT],
  );
  const previousTurns: ChatTurn[] = previous
    .reverse()
    .map((row) => ({ role: row.role === 'assistant' ? 'assistant' : 'user', content: row.content }));

  // 2) Presupuesto mensual agotado → respuesta fija SIN llamar al modelo.
  if (await isBudgetExhausted(deps)) {
    await appendMessage(deps.pool, sessionId, 'user', content, null);
    await appendMessage(deps.pool, sessionId, 'assistant', BUDGET_REPLY, null);
    return history(deps.pool, sessionId);
  }

  const turns: ChatTurn[] = [
    { role: 'system', content: await systemPrompt(deps) },
    ...previousTurns,
    { role: 'user', content },
  ];

  // 3-4) modelo (+ 1 reintento si zod falla); el consumo se acumula porque las
  //      dos llamadas gastan. Si el proveedor falla o corta la cuota, PROPAGA
  //      sin haber persistido nada → el reintento del cliente no duplica.
  const first = await deps.ai.complete(turns, sessionId);
  let usage = first.usage;
  let raw = first.content;
  let parsed = tryParseAction(raw);

  if (!parsed.ok) {
    // 1 reintento con el motivo del esquema (docs/04 §6).
    const second = await deps.ai.complete(
      [
        ...turns,
        { role: 'assistant', content: raw.slice(0, 500) },
        {
          role: 'user',
          content: `Tu respuesta no cumplía el esquema: ${parsed.error}. Responde SOLO con un objeto JSON válido de una de estas acciones: ask, quote, suggest, create_draft.`,
        },
      ],
      sessionId,
    );
    usage = mergeUsage(usage, second.usage);
    raw = second.content;
    parsed = tryParseAction(raw);
  }

  await appendMessage(deps.pool, sessionId, 'user', content, null);

  if (!parsed.ok) {
    // 5) salida fuera del esquema → mensaje fijo; nada se ejecuta.
    await appendMessage(deps.pool, sessionId, 'assistant', FALLBACK_REPLY, null, usage);
    return history(deps.pool, sessionId);
  }

  // 6) despacho con datos reales. Si el modelo inventó una sala (o se
  //    desactivó entre turnos), se responde sin romper la conversación.
  let outcome: HandlerOutcome;
  try {
    outcome = await dispatch(deps, parsed.action);
  } catch (error) {
    if (error instanceof UnknownRoomError) {
      outcome = {
        reply:
          'Esa sala ya no está disponible. Dime para cuántas personas y qué día es, y te propongo otra.',
        card: null,
      };
    } else {
      throw error;
    }
  }

  // 7) persistir con el consumo real y devolver la conversación completa
  await appendMessage(
    deps.pool,
    sessionId,
    'assistant',
    outcome.reply,
    {
      action: parsed.action,
      card: outcome.card,
    },
    usage,
  );
  return history(deps.pool, sessionId);
}
