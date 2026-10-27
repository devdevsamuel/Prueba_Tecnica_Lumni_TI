import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Collapse } from '../components/Collapse';
import { DateBadge } from '../components/DateBadge';
import { Skeleton } from '../components/Skeleton';
import { ErrorState } from '../components/states';
import { ApiError } from '../lib/api';
import { formatCop, formatDuration } from '../lib/quotes';
import { formatBogota } from '../lib/datetime';
import { clearChat, fetchChat, sendChat, type ChatCard, type ChatMessage } from '../lib/chat';

/**
 * Pantalla 5 — Chat con IA (Parte 2.2, docs/01 §9, docs/06 §4).
 *
 * La UI solo pinta y llama a `lib/chat`: los precios de las tarjetas los calcula
 * el backend, no el modelo ni esta página. La confirmación NUNCA está aquí:
 * `create_draft` deja el borrador y el botón "Confirmar reserva" lleva al wizard.
 */

const EXAMPLE = 'Necesito una sala para 6 personas el sábado en la mañana, con proyector';

/** Mensaje local solo cuando el envío falla → se reintenta sin duplicar (06 §4). */
interface FailedMessage {
  readonly id: string;
  readonly content: string;
}

export function ChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [failed, setFailed] = useState<FailedMessage | null>(null);

  const listRef = useRef<HTMLOListElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** Solo se autodesplaza si la persona ya estaba al final de la conversación. */
  const stickToBottom = useRef(true);

  const focusInput = useCallback(() => {
    // `preventScroll`: el foco vuelve al campo sin arrastrar la página.
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  // Retoma la conversación al entrar (docs/01 §9: se recupera al recargar).
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    stickToBottom.current = true;
    fetchChat(controller.signal)
      .then((data) => setMessages(data.messages))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(cause instanceof ApiError ? cause.message : 'No se pudo cargar la conversación.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reloadKey]);

  useEffect(() => {
    const list = listRef.current;
    if (!list || !stickToBottom.current) return;
    // Desplaza SOLO la conversación: la página no salta (docs/06 §4).
    list.scrollTop = list.scrollHeight;
  }, [messages.length, sending, failed, loading]);

  /** Envía un contenido; el servidor manda la lista completa (fuente de verdad). */
  const push = useCallback(async (content: string) => {
    setSending(true);
    setSendError(null);
    try {
      const result = await sendChat(content);
      setMessages(result.messages);
      setFailed(null);
    } catch (cause: unknown) {
      // No se pierde lo escrito: se marca como fallido y se puede reintentar.
      setFailed({ id: `local-${Date.now()}`, content });
      setSendError(cause instanceof ApiError ? cause.message : 'No se pudo enviar el mensaje.');
    } finally {
      setSending(false);
    }
  }, []);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const content = draft.trim();
    if (!content || sending) return;
    stickToBottom.current = true;
    setDraft('');
    focusInput();
    void push(content);
  }

  function retry(): void {
    if (!failed) return;
    const content = failed.content;
    stickToBottom.current = true;
    setFailed(null);
    focusInput();
    void push(content);
  }

  function handleListScroll(): void {
    const list = listRef.current;
    if (!list) return;
    const distanceToBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    stickToBottom.current = distanceToBottom < 48;
  }

  async function clearConversation(): Promise<void> {
    if (clearing || sending) return;
    if (
      !window.confirm(
        '¿Quieres limpiar el historial visible? El consumo se conserva para trazabilidad y límites.',
      )
    ) {
      return;
    }
    setClearing(true);
    setSendError(null);
    try {
      const result = await clearChat();
      setMessages(result.messages);
      setFailed(null);
      setDraft('');
      stickToBottom.current = true;
      focusInput();
    } catch (cause: unknown) {
      setSendError(cause instanceof ApiError ? cause.message : 'No se pudo limpiar el historial.');
    } finally {
      setClearing(false);
    }
  }

  const body = (() => {
    if (loading) return <Skeleton variant="bubble" rows={3} label="Abriendo la conversación…" />;
    if (loadError) {
      return <ErrorState message={loadError} onRetry={() => setReloadKey((key) => key + 1)} />;
    }
    if (messages.length === 0 && !failed && !sending) {
      return (
        <div className="chat-empty fade-in">
          <p>
            Puedo ayudarte a elegir sala, día y duración. Prueba con:
          </p>
          <Button
            variant="secondary"
            onClick={() => {
              setDraft(EXAMPLE);
              focusInput();
            }}
          >
            «{EXAMPLE}»
          </Button>
        </div>
      );
    }
    return (
      <ol
        ref={listRef}
        className="chat-messages"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Mensajes de la conversación"
        tabIndex={0}
        onScroll={handleListScroll}
      >
        {messages.map((message) => (
          <li key={message.id} className={`bubble bubble--${message.role} rise-in`}>
            <p className="bubble__meta">
              {message.role === 'user' ? 'Tú' : 'Asistente'} · {formatBogota(message.createdAt)}
            </p>
            <p className="bubble__text">{message.content}</p>
            {message.card && <QuoteCard card={message.card} />}
          </li>
        ))}
        {failed && (
          <li className="bubble bubble--user bubble--failed rise-in">
            <p className="bubble__meta">No se pudo enviar</p>
            <p className="bubble__text">{failed.content}</p>
          </li>
        )}
        {sending && (
          <li className="bubble bubble--assistant rise-in" aria-live="polite">
            <p className="bubble__meta">Asistente</p>
            <p className="bubble__text bubble__text--typing">
              <span className="sr-only">El asistente está escribiendo…</span>
              <span className="chat-typing" aria-hidden="true">
                <span className="chat-typing__dot" />
                <span className="chat-typing__dot" />
                <span className="chat-typing__dot" />
              </span>
            </p>
          </li>
        )}
      </ol>
    );
  })();

  return (
    <div className="stack-lg">
      <div className="chat-header">
        <div>
          <h1>Asistente</h1>
          <p className="page-intro">
            Te guío hasta dejar la reserva preparada. Los precios los calcula la aplicación y la
            confirmación siempre es un botón fuera de este chat.
          </p>
        </div>
        <div className="chat-header__actions">
          <Collapse open={messages.length > 0 || Boolean(failed)}>
            <Button variant="secondary" loading={clearing} onClick={() => void clearConversation()}>
              Limpiar historial
            </Button>
          </Collapse>
        </div>
      </div>

      <Card title="Conversación">
        <div className="chat-body">
          {body}
          <Collapse open={Boolean(sendError)}>
            {sendError && (
              <div className="alert" role="alert">
                <p>{sendError}</p>
                {failed && (
                  <Button variant="secondary" onClick={retry}>
                    Reintentar «{failed.content.slice(0, 40)}
                    {failed.content.length > 40 ? '…' : ''}»
                  </Button>
                )}
              </div>
            )}
          </Collapse>
        </div>
      </Card>

      <Card title="Escribe un mensaje">
        <form onSubmit={handleSubmit} noValidate className="chat-form">
          <label className="field__label" htmlFor="chat-input">
            Mensaje
          </label>
          <textarea
            id="chat-input"
            ref={inputRef}
            className="field__control chat-input"
            value={draft}
            rows={3}
            maxLength={2000}
            placeholder="Ej.: Necesito una sala para 6 personas el sábado en la mañana…"
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="form-actions">
            <Button type="submit" variant="primary" loading={sending}>
              Enviar
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

/** Tarjeta con el desglose REAL y el enlace de confirmación (fuera del chat). */
function QuoteCard({ card }: { readonly card: ChatCard }) {
  const lines: { label: string; value: string; negative?: boolean }[] = [
    { label: `Base · ${formatDuration(card.durationMinutes)}`, value: formatCop(card.base) },
  ];
  if (card.discount > 0) {
    lines.push({
      label: `Descuento (${card.discountPercent} %)`,
      value: `−${formatCop(card.discount)}`,
      negative: true,
    });
  }
  if (card.surcharge > 0) {
    lines.push({ label: 'Recargo sábado (25 %)', value: `+${formatCop(card.surcharge)}` });
  }
  if (card.services > 0) {
    lines.push({ label: 'Servicios', value: `+${formatCop(card.services)}` });
  }

  const endDate = new Date(`${card.date}T${card.startTime}`);
  endDate.setMinutes(endDate.getMinutes() + card.durationMinutes);
  const endTime = endDate.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });

  return (
    <div className={`chat-card ${card.canBook ? '' : 'chat-card--blocked'}`}>
      <div className="chat-card__header">
        <DateBadge date={card.date} />
        <div>
          <p className="chat-card__title">
            {card.roomName} · {card.capacity} personas
            {card.kind === 'create_draft' ? ' · borrador preparado' : ''}
          </p>
          <p className="chat-card__when">
            <time dateTime={`${card.date}T${card.startTime}`}>
              {card.startTime} – {endTime}
            </time>
          </p>
        </div>
      </div>

      <dl className="breakdown">
        {lines.map((line) => (
          <div key={line.label} className="breakdown__row">
            <dt className={line.negative ? 'breakdown__discount' : undefined}>{line.label}</dt>
            <dd className={line.negative ? 'breakdown__discount' : undefined}>{line.value}</dd>
          </div>
        ))}
        <div className="breakdown__row breakdown__total-row">
          <dt className="breakdown__total-label">Total</dt>
          <dd className="breakdown__total-value">{formatCop(card.total)}</dd>
        </div>
      </dl>

      {!card.canBook && card.reason && <p className="chat-card__reason">{card.reason}</p>}
      {card.kind === 'create_draft' && card.draftId !== undefined && (
        <p className="chat-card__action">
          <Link className="btn btn--primary" to={`/reserva?borrador=${card.draftId}`}>
            Confirmar reserva
          </Link>
        </p>
      )}
    </div>
  );
}
