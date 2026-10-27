import type { AiConfig } from '../../config.js';

/**
 * Cliente del proveedor de IA (Parte 2.2). Interfaz estrecha para poder
 * sustituirlo por un doble en los tests o por otro proveedor más adelante
 * (la capa es agnóstica: base URL + clave + modelo por env, docs/03 §6.1).
 *
 * Devuelve además el `usage` de la respuesta: es la trazabilidad de consumo
 * que se persiste por mensaje y de la que cuelga el presupuesto mensual
 * (Fase 5b, docs/03 §6.3).
 */
export interface ChatTurn {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

/** Consumo de UNA llamada al modelo, tal y como lo reporta el proveedor. */
export interface AiUsage {
  readonly promptTokens: number;
  /** Incluye los de razonamiento (convención OpenAI). */
  readonly completionTokens: number;
  readonly reasoningTokens: number;
  /** Coste en USD (0 con modelos gratuitos como `beam-free`). */
  readonly costUsd: number;
  readonly model: string;
}

export interface AiCompletion {
  readonly content: string;
  readonly usage: AiUsage;
}

export interface AiClient {
  /** Devuelve el contenido crudo de la respuesta y lo que ha consumido. */
  complete(turns: readonly ChatTurn[], sessionId: string): Promise<AiCompletion>;
}

/** El proveedor está caído o rechazó la llamada (la ruta lo traduce a 502). */
export class AiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiUnavailableError';
  }
}

/**
 * El proveedor ha agotado la cuota del plan (429/402). La ruta lo traduce a
 * 429 con mensaje propio: no es una caída del servicio, es un tope alcanzado.
 */
export class AiQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiQuotaError';
  }
}

const REQUEST_TIMEOUT_MS = 45_000;

/** Extrae un entero no negativo de un campo numérico opcional del proveedor. */
function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

export class OpenCodeAiClient implements AiClient {
  constructor(private readonly config: AiConfig) {}

  async complete(turns: readonly ChatTurn[], sessionId: string): Promise<AiCompletion> {
    if (!this.config.apiKey) {
      throw new AiUnavailableError('Falta AI_API_KEY en .env: el chat no puede llamar al modelo.');
    }

    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
          // Obligatoria para este proveedor; 1:1 con chat_sessions.id (docs/03 §6.1).
          'x-opencode-session': sessionId,
          'User-Agent': 'coworking-chat/1.0',
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: turns,
          max_tokens: this.config.maxTokens,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new AiUnavailableError(
        `No se pudo contactar con el proveedor de IA: ${error instanceof Error ? error.message : 'error desconocido'}`,
      );
    }

    if (response.status === 429 || response.status === 402) {
      // Cuota del plan agotada: no es un error de red ni del proveedor caído.
      const detail = (await response.text()).slice(0, 300);
      throw new AiQuotaError(`El proveedor de IA ha agotado la cuota (${response.status}): ${detail}`);
    }

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new AiUnavailableError(`El proveedor de IA respondió ${response.status}: ${detail}`);
    }

    const data = (await response.json()) as {
      model?: unknown;
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: {
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
        completion_tokens_details?: { reasoning_tokens?: unknown };
        cost?: unknown;
      };
    };
    const content = data.choices?.[0]?.message?.content;
    // Vacío NO es caída del proveedor (HTTP 200): los modelos de razonamiento
    // pueden agotar el tope "pensando". Se devuelve '' y el servicio reintenta
    // pidiendo JSON; si vuelve vacío, el mensaje fijo de respaldo.
    return {
      content: typeof content === 'string' ? content : '',
      usage: {
        promptTokens: asCount(data.usage?.prompt_tokens),
        completionTokens: asCount(data.usage?.completion_tokens),
        reasoningTokens: asCount(data.usage?.completion_tokens_details?.reasoning_tokens),
        costUsd: typeof data.usage?.cost === 'number' && data.usage.cost >= 0 ? data.usage.cost : 0,
        model: typeof data.model === 'string' && data.model ? data.model : this.config.model,
      },
    };
  }
}
