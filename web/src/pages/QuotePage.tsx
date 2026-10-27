import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Collapse } from '../components/Collapse';
import { Input, Select } from '../components/Input';
import { Skeleton } from '../components/Skeleton';
import { EmptyState, ErrorState } from '../components/states';
import { ApiError } from '../lib/api';
import { todayBogota } from '../lib/datetime';
import {
  DURATION_OPTIONS,
  fetchRooms,
  formatCop,
  formatDuration,
  postQuote,
  START_OPTIONS,
  type QuoteResult,
  type Room,
  type SuggestedSlot,
} from '../lib/quotes';

/**
 * Pantalla 1 — Cotizador (docs/01 §3, docs/06 §4).
 * La UI no contiene reglas de negocio: solo pinta y llama a `lib/quotes`
 * (S + D del front). La validación del cliente es solo de formato/presencia;
 * las reglas (horario, domingo, disponibilidad) las decide el backend y vuelven
 * como `canBook=false` + motivo + sugerencia.
 */

interface FormValues {
  roomId: string;
  date: string;
  startTime: string;
  durationMinutes: string;
}

const EMPTY_FORM: FormValues = { roomId: '', date: '', startTime: '', durationMinutes: '' };

/**
 * Snapshot de la pantalla: formulario + último resultado.
 *
 * Vive en `sessionStorage` (por pestaña, muere al cerrarla) para que ir a
 * "Reservar esta sala" y volver (atrás del navegador o nav) **no borre lo
 * rellenado**. No contiene datos personales, solo sala/fecha/hora/duración.
 */
const SNAPSHOT_KEY = 'coworking:cotizacion';

interface QuoteSnapshot {
  readonly form: FormValues;
  readonly result: QuoteResult | null;
}

/** Guard mínima de lo que la UI pinta: si el esquema cambió, se ignora el dato. */
function isFormValues(value: unknown): value is FormValues {
  if (typeof value !== 'object' || value === null) return false;
  const fields = value as Record<string, unknown>;
  return (
    typeof fields.roomId === 'string' &&
    typeof fields.date === 'string' &&
    typeof fields.startTime === 'string' &&
    typeof fields.durationMinutes === 'string'
  );
}

function isQuoteResult(value: unknown): value is QuoteResult {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const room = candidate.room;
  if (typeof room !== 'object' || room === null) return false;
  const roomFields = room as Record<string, unknown>;
  const slot = candidate.suggestedSlot;
  return (
    typeof candidate.canBook === 'boolean' &&
    (candidate.reason === null || typeof candidate.reason === 'string') &&
    typeof candidate.date === 'string' &&
    typeof candidate.startTime === 'string' &&
    typeof candidate.endTime === 'string' &&
    typeof candidate.durationMinutes === 'number' &&
    typeof candidate.isSaturday === 'boolean' &&
    typeof candidate.base === 'number' &&
    typeof candidate.discountPercent === 'number' &&
    typeof candidate.discount === 'number' &&
    typeof candidate.surcharge === 'number' &&
    typeof candidate.total === 'number' &&
    typeof roomFields.id === 'number' &&
    typeof roomFields.name === 'string' &&
    (slot === null ||
      (typeof slot === 'object' &&
        slot !== null &&
        typeof (slot as Record<string, unknown>).date === 'string' &&
        typeof (slot as Record<string, unknown>).startTime === 'string'))
  );
}

/** Devuelve lo guardado o un vacío; cualquier error de lectura → vacío. */
function readSnapshot(): QuoteSnapshot {
  const empty: QuoteSnapshot = { form: EMPTY_FORM, result: null };
  try {
    const raw = sessionStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return empty;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return empty;
    const { form, result } = parsed as { form?: unknown; result?: unknown };
    if (!isFormValues(form)) return empty;
    return { form, result: isQuoteResult(result) ? result : null };
  } catch {
    return empty;
  }
}

/** Escritura defensiva: Safari privado o cuota llena no rompen la pantalla. */
function writeSnapshot(form: FormValues, result: QuoteResult | null): void {
  try {
    sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ form, result }));
  } catch {
    // Sin storage la app sigue funcionando; solo no sobrevive a la navegación.
  }
}

function requiredError(label: string, value: string): string | undefined {
  return value ? undefined : `Selecciona ${label}.`;
}

export function QuotePage() {
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [roomsError, setRoomsError] = useState<string | null>(null);
  const [loadKey, setLoadKey] = useState(0);

  // Al montar se recupera el snapshot: lo que había al salir hacia "Reservar".
  const [initial] = useState(readSnapshot);
  const [form, setForm] = useState<FormValues>(initial.form);
  const [touched, setTouched] = useState<Record<keyof FormValues, boolean>>({
    roomId: false,
    date: false,
    startTime: false,
    durationMinutes: false,
  });

  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<QuoteResult | null>(initial.result);
  const [submitError, setSubmitError] = useState<string | null>(null);
  /** Contador > 0 tras cada cotización nueva: reinicia el resaltado y dispara el foco. */
  const [flash, setFlash] = useState(0);
  const resultRef = useRef<HTMLDivElement>(null);

  // Snapshot continuo: formulario + resultado sobreviven a "Reservar → atrás"
  // (y a recargar la pestaña). Vive solo en esta pestaña (sessionStorage).
  useEffect(() => {
    writeSnapshot(form, result);
  }, [form, result]);

  // Carga de salas con reintentable (estado de carga / error / éxito).
  useEffect(() => {
    const controller = new AbortController();
    setRoomsError(null);
    fetchRooms(controller.signal)
      .then((data) => setRooms(data.rooms))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setRooms([]);
        setSubmitError(null);
        setRoomsError(error instanceof ApiError ? error.message : 'No se pudieron cargar las salas.');
      });
    return () => controller.abort();
  }, [loadKey]);

  // Tras cotizar (disponible o NO), el foco y la vista saltan al resultado:
  // no hace falta hacer scroll. El snapshot restaurado tiene flash=0 → al
  // volver desde el wizard no se roba el foco ni se centra nada (docs/06 §4).
  useEffect(() => {
    if (flash === 0) return;
    const node = resultRef.current;
    if (!node) return;
    node.focus({ preventScroll: true });
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    node.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
  }, [flash]);

  const fieldErrors: Record<keyof FormValues, string | undefined> = {
    roomId: requiredError('una sala', form.roomId),
    date: requiredError('la fecha', form.date),
    startTime: requiredError('la hora de inicio', form.startTime),
    durationMinutes: requiredError('la duración', form.durationMinutes),
  };

  const runQuote = useCallback(async (values: FormValues) => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const quoteResult = await postQuote({
        roomId: Number(values.roomId),
        date: values.date,
        startTime: values.startTime,
        durationMinutes: Number(values.durationMinutes),
      });
      setResult(quoteResult);
      setFlash((count) => count + 1);
    } catch (error: unknown) {
      // Lo escrito nunca se pierde (docs/06 §3): el error es reintenable.
      setResult(null);
      setSubmitError(error instanceof ApiError ? error.message : 'No se pudo cotizar.');
    } finally {
      setSubmitting(false);
    }
  }, []);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const missing = (Object.keys(fieldErrors) as Array<keyof FormValues>).filter(
      (key) => fieldErrors[key],
    );
    if (missing.length > 0) {
      setTouched({ roomId: true, date: true, startTime: true, durationMinutes: true });
      return;
    }
    void runQuote(form);
  }

  function applySuggestion(slot: SuggestedSlot): void {
    const next: FormValues = {
      ...form,
      date: slot.date,
      startTime: slot.startTime,
    };
    setForm(next);
    setResult(null);
    void runQuote(next);
  }

  /** Vacía el formulario y oculta el resultado de la cotización anterior. */
  function handleReset(): void {
    setForm(EMPTY_FORM);
    setTouched({ roomId: false, date: false, startTime: false, durationMinutes: false });
    setResult(null);
    setSubmitError(null);
    setFlash(0);
  }

  /** Reserva otra sala desde el resultado actual, sin arrastrar datos viejos. */
  function handleNewRoom(): void {
    try {
      sessionStorage.removeItem(SNAPSHOT_KEY);
      localStorage.removeItem('coworking:borrador');
    } catch {
      // Sin storage la aplicación sigue funcionando.
    }
    handleReset();
  }

  const today = todayBogota();

  return (
    <div className="stack-lg">
      <div>
        <h1>Cotizador de salas</h1>
        <p className="page-intro">
          Elige sala, fecha, hora y duración para ver el desglose y la disponibilidad.
        </p>
      </div>

      <Card title="Nueva cotización">
        {roomsError ? (
          <ErrorState message={roomsError} onRetry={() => setLoadKey((key) => key + 1)} />
        ) : rooms === null ? (
          <Skeleton variant="fields" rows={4} label="Cargando salas…" />
        ) : rooms.length === 0 ? (
          <EmptyState
            title="No hay salas disponibles"
            description="En este momento no hay ninguna sala activa. Vuelve a intentarlo en unos minutos."
            action={
              <Button variant="secondary" onClick={() => setLoadKey((key) => key + 1)}>
                Reintentar
              </Button>
            }
          />
        ) : (
          <form onSubmit={handleSubmit} noValidate>
            <Select
              label="Sala"
              value={form.roomId}
              error={touched.roomId ? fieldErrors.roomId : undefined}
              onBlur={() => setTouched((state) => ({ ...state, roomId: true }))}
              onChange={(event) => setForm((state) => ({ ...state, roomId: event.target.value }))}
            >
              <option value="" disabled>
                Selecciona una sala…
              </option>
              {rooms.map((room) => (
                <option key={room.id} value={room.id}>
                  {room.name} · hasta {room.capacity} personas · {formatCop(room.hourlyRate)}/h
                </option>
              ))}
            </Select>

            <Input
              label="Fecha"
              type="date"
              value={form.date}
              min={today}
              error={touched.date ? fieldErrors.date : undefined}
              onBlur={() => setTouched((state) => ({ ...state, date: true }))}
              onChange={(event) => setForm((state) => ({ ...state, date: event.target.value }))}
            />

            <fieldset className="fieldset">
              <legend className="fieldset__legend">Horario de la reserva</legend>
              <Select
                label="Hora de inicio"
                value={form.startTime}
                error={touched.startTime ? fieldErrors.startTime : undefined}
                onBlur={() => setTouched((state) => ({ ...state, startTime: true }))}
                onChange={(event) =>
                  setForm((state) => ({ ...state, startTime: event.target.value }))
                }
              >
                <option value="" disabled>
                  Selecciona una hora…
                </option>
                {START_OPTIONS.map((time) => (
                  <option key={time} value={time}>
                    {time}
                  </option>
                ))}
              </Select>

              <Select
                label="Duración"
                value={form.durationMinutes}
                error={touched.durationMinutes ? fieldErrors.durationMinutes : undefined}
                onBlur={() => setTouched((state) => ({ ...state, durationMinutes: true }))}
                onChange={(event) =>
                  setForm((state) => ({ ...state, durationMinutes: event.target.value }))
                }
              >
                <option value="" disabled>
                  Selecciona una duración…
                </option>
                {DURATION_OPTIONS.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {formatDuration(minutes)}
                  </option>
                ))}
              </Select>
            </fieldset>

            <div className="form-actions">
              <Button type="submit" variant="primary" loading={submitting}>
                Cotizar
              </Button>
              <Button type="button" variant="secondary" onClick={handleReset}>
                Limpiar
              </Button>
            </div>
          </form>
        )}
      </Card>

      <Collapse open={Boolean(submitError)}>
        {submitError && (
          <ErrorState message={submitError} onRetry={() => void runQuote(form)} />
        )}
      </Collapse>

      {result && (
        <Card className="rise-in">
          <div
            key={flash}
            ref={resultRef}
            tabIndex={-1}
            className={`quote-result ${
              result.canBook ? 'quote-result--available' : 'quote-result--blocked'
            }${flash > 0 ? ' quote-result--flash' : ''}`}
            role="status"
            aria-live="polite"
          >
            {result.canBook ? (
              <>
                <h3>Disponible</h3>
                <p>
                  {result.room.name} está libre el{' '}
                  <time dateTime={`${result.date}T${result.startTime}`}>
                    {result.date} de {result.startTime} a {result.endTime}
                  </time>
                  . Desglose:
                </p>
                <dl className="breakdown">
                  <dt>
                    Base ({result.durationMinutes} min)
                  </dt>
                  <dd>{formatCop(result.base)}</dd>
                  {result.discount > 0 && (
                    <>
                      <dt>Descuento ({result.discountPercent} %)</dt>
                      <dd>−{formatCop(result.discount)}</dd>
                    </>
                  )}
                  {result.surcharge > 0 && (
                    <>
                      <dt>Recargo sábado (25 %)</dt>
                      <dd>+{formatCop(result.surcharge)}</dd>
                    </>
                  )}
                  <dt className="breakdown__total-label">Total</dt>
                  <dd className="breakdown__total-value">{formatCop(result.total)}</dd>
                </dl>
                {/* Rellenado del wizard desde la cotización (docs/01 §2.2). */}
                <p className="quote-result__next">
                  <Link
                    className="btn btn--primary"
                    to={`/reserva?sala=${result.room.id}&fecha=${result.date}&hora=${result.startTime}&duracion=${result.durationMinutes}`}
                    onClick={() => {
                      try {
                        // El wizard empieza desde esta cotización, no desde el
                        // borrador guardado de una reserva anterior.
                        localStorage.removeItem('coworking:borrador');
                      } catch {
                        // Sin storage la aplicación sigue funcionando.
                      }
                    }}
                  >
                    Reservar esta sala
                  </Link>
                  <Button variant="secondary" onClick={handleNewRoom}>
                    Cotizar otra sala
                  </Button>
                </p>
              </>
            ) : (
              <>
                <h3>No se puede reservar</h3>
                <p className="quote-result__reason">{result.reason}</p>
                {result.suggestedSlot && (
                  <>
                    <p>Hay un horario libre ese mismo día:</p>
                    <Button variant="secondary" onClick={() => applySuggestion(result.suggestedSlot!)}>
                      Usar {result.suggestedSlot.date} a las {result.suggestedSlot.startTime}
                    </Button>
                  </>
                )}
              </>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
