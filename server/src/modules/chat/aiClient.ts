import type { AiConfig } from '../../config.js';

/**
 * Cliente del proveedor de IA (Parte 2.2). Interfaz estrecha para poder
 * sustituirlo por un doble en los tests o por otro proveedor más adelante
 * (la capa es agnóstica: base URL + clave + modelo por env, docs/03 §6.1).
 */
export interface ChatTurn {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface AiClient {
  /** Devuelve el contenido crudo de la respuesta del modelo. */
  complete(turns: readonly ChatTurn[], sessionId: string): Promise<string>;
}

/** El proveedor está caído o rechazó la llamada (la ruta lo traduce a 502). */
export class AiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiUnavailableError';
  }
}

// Modelos de razonamiento: consumen tokens "pensando" (vienen en
// `reasoning_content`), así que el tope debe dejar sitio al JSON de la
// respuesta; con 1500 en conversaciones largas el `content` salía vacío
// (verificado con el modelo real). La respuesta pedida es un JSON corto.
const MAX_TOKENS = 4_000;
const REQUEST_TIMEOUT_MS = 45_000;

export class OpenCodeAiClient implements AiClient {
  constructor(private readonly config: AiConfig) {}

  async complete(turns: readonly ChatTurn[], sessionId: string): Promise<string> {
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
        body: JSON.stringify({ model: this.config.model, messages: turns, max_tokens: MAX_TOKENS }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new AiUnavailableError(
        `No se pudo contactar con el proveedor de IA: ${error instanceof Error ? error.message : 'error desconocido'}`,
      );
    }

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new AiUnavailableError(`El proveedor de IA respondió ${response.status}: ${detail}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    // Vacío NO es caída del proveedor (HTTP 200): los modelos de razonamiento
    // pueden agotar el tope "pensando". Se devuelve '' y el servicio reintenta
    // pidiendo JSON; si vuelve vacío, el mensaje fijo de respaldo.
    return typeof content === 'string' ? content : '';
  }
}
