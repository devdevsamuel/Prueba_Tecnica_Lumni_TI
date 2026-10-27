import { apiDelete, apiGet, apiPost } from './api';

/**
 * Cliente del chat (Parte 2.2). Único punto de red de la pantalla (docs/03 §7 S).
 * La cookie `chat_sid` la gestiona el navegador: la petición es mismo origen
 * (pasa por el proxy de Vite), así que la conversación se retoma sola.
 */

/** Tarjeta con precios REALES calculados por el backend (el modelo no pinta). */
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
  readonly services: number;
  readonly total: number;
  readonly canBook: boolean;
  readonly reason: string | null;
  readonly suggestedSlot: { date: string; startTime: string } | null;
  readonly draftId?: number;
}

export type ChatAction =
  | { readonly action: 'ask'; readonly text: string }
  | { readonly action: 'quote' | 'suggest' | 'create_draft'; readonly [key: string]: unknown };

export interface ChatMessage {
  readonly id: number;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly createdAt: string;
  readonly action: ChatAction | null;
  readonly card: ChatCard | null;
}

export function fetchChat(signal?: AbortSignal): Promise<{ messages: ChatMessage[] }> {
  return apiGet<{ messages: ChatMessage[] }>('/api/chat', signal);
}

export function sendChat(content: string, signal?: AbortSignal): Promise<{ messages: ChatMessage[] }> {
  return apiPost<{ messages: ChatMessage[] }>('/api/chat', { content }, signal);
}

export function clearChat(signal?: AbortSignal): Promise<{ messages: ChatMessage[] }> {
  return apiDelete<{ messages: ChatMessage[] }>('/api/chat', signal);
}
