import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import type { Clock } from '../../core/clock.js';
import { BOGOTA_TZ, bogotaDateStr } from '../../core/time.js';
import { saveDraft, DraftRuleError } from '../bookings/service.js';
import { listRooms, quoteRoom } from '../quotes/service.js';
import type { Slot as SuggestedSlot } from '../quotes/quote.js';
import type { AiClient, ChatTurn } from './aiClient.js';
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
 */
export interface ChatDeps {
  readonly pool: Pool;
  readonly clock: Clock;
  readonly ai: AiClient;
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

const HISTORY_LIMIT = 10;

/** Fijo cuando la salida del modelo no cumple el esquema (regla 4). */
const FALLBACK_REPLY =
  'No he podido interpretar tu mensaje. Dime la sala, el día y la duración y lo preparo.';

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

async function systemPrompt(deps: ChatDeps): Promise<string> {
  const rooms = await listRooms({ pool: deps.pool, clock: deps.clock });
  const now = deps.clock.now();
  const today = bogotaDateStr(now);
  const weekday = new Intl.DateTimeFormat('es-CO', { weekday: 'long', timeZone: BOGOTA_TZ }).format(now);
  const catalog = rooms
    .map((room) => `- id ${room.id}: ${room.name}, capacidad ${room.capacity} personas`)
    .join('\n');
  return [
    basePrompt(),
    '',
    '## Salas disponibles (con capacidad; sin precios)',
    catalog,
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
    `SELECT id, role, content, created_at, action_json
       FROM chat_messages WHERE session_id = $1 ORDER BY id ASC`,
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
): Promise<void> {
  await pool.query(
    `INSERT INTO chat_messages (session_id, role, content, action_json) VALUES ($1, $2, $3, $4)`,
    [sessionId, role, content, action === null ? null : JSON.stringify(action)],
  );
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

/** Resuelve el hueco del modelo y lo cotiza con los datos reales. */
async function quoteFor(
  deps: ChatDeps,
  action: { roomId: number; dayRef: DayRef; partOfDay: PartOfDay; durationMinutes: number },
): ReturnType<typeof quoteRoom> {
  const slot = resolveSlot({ dayRef: action.dayRef, partOfDay: action.partOfDay, now: deps.clock.now() });
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
  const card = cardFrom('quote', quote);
  if (quote.canBook) {
    return {
      reply: `${quote.room.name} está libre el ${quote.date} de ${quote.startTime} a ${quote.endTime}: ${card.total} en total.`,
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
      reply: `Te propongo ${usable.room.name} el ${usable.date} de ${usable.startTime} a ${usable.endTime}: ${card.total}.`,
      card,
    };
  }
  return { reply: `Tampoco hay hueco disponible: ${usable.reason}`, card };
}

async function handleCreateDraft(deps: ChatDeps, action: AssistantAction): Promise<HandlerOutcome> {
  if (action.action !== 'create_draft') throw new Error('handleCreateDraft con otra acción');

  const slot = resolveSlot({
    dayRef: action.dayRef,
    partOfDay: action.partOfDay,
    now: deps.clock.now(),
  });

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
        date: slot.date,
        startTime: slot.startTime,
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
  const quote = await quoteFor(deps, action);
  // Suma por tipo de línea (los servicios pueden ser varios), en valor absoluto:
  // los descuentos se guardan en negativo para que SUM(líneas) = total.
  const sumOf = (kind: string): number =>
    draftLines
      .filter((item) => item.kind === kind)
      .reduce((total, item) => total + Math.abs(item.amount), 0);
  const base = sumOf('base');
  const discount = sumOf('discount');
  const card: ChatCard = {
    kind: 'create_draft',
    roomId: quote.room.id,
    roomName: quote.room.name,
    capacity: quote.room.capacity,
    date: draftDate ?? slot.date,
    startTime: draftStart ?? slot.startTime,
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
      `He dejado preparada la reserva #${draftId}: ${roomName ?? 'sala'} el ${slot.date} a las ${slot.startTime}. ` +
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
  // 1) historial (ANTES de guardar el mensaje nuevo, para que no se repita)
  const { rows: previous } = await deps.pool.query<{ role: string; content: string }>(
    `SELECT role, content FROM chat_messages
      WHERE session_id = $1 ORDER BY id DESC LIMIT $2`,
    [sessionId, HISTORY_LIMIT],
  );
  const previousTurns: ChatTurn[] = previous
    .reverse()
    .map((row) => ({ role: row.role === 'assistant' ? 'assistant' : 'user', content: row.content }));

  await appendMessage(deps.pool, sessionId, 'user', content, null);

  const turns: ChatTurn[] = [
    { role: 'system', content: await systemPrompt(deps) },
    ...previousTurns,
    { role: 'user', content },
  ];

  // 2-3) modelo
  let raw = await deps.ai.complete(turns, sessionId);
  let parsed = tryParseAction(raw);

  if (!parsed.ok) {
    // 1 reintento con el motivo del esquema (docs/04 §6).
    raw = await deps.ai.complete(
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
    parsed = tryParseAction(raw);
  }

  if (!parsed.ok) {
    // 4) salida fuera del esquema → mensaje fijo; nada se ejecuta.
    await appendMessage(deps.pool, sessionId, 'assistant', FALLBACK_REPLY, null);
    return history(deps.pool, sessionId);
  }

  // 5-6) despacho con datos reales
  const outcome = await dispatch(deps, parsed.action);

  // 7) persistir y devolver la conversación completa (la UI solo reemplaza)
  await appendMessage(deps.pool, sessionId, 'assistant', outcome.reply, {
    action: parsed.action,
    card: outcome.card,
  });
  return history(deps.pool, sessionId);
}
