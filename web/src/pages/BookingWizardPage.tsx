import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Collapse } from '../components/Collapse';
import { Input, Select, Textarea } from '../components/Input';
import { Skeleton } from '../components/Skeleton';
import { Stepper } from '../components/Stepper';
import { EmptyState, ErrorState } from '../components/states';
import { ApiError } from '../lib/api';
import {
  cancelBooking,
  confirmBooking,
  fetchBooking,
  saveDraft,
  SERVICE_OPTIONS,
  type Booking,
  type DraftInput,
  type ServiceCode,
} from '../lib/bookings';
import {
  DURATION_OPTIONS,
  fetchRooms,
  formatCop,
  formatDuration,
  START_OPTIONS,
  type Room,
} from '../lib/quotes';

/**
 * Pantalla 2 — Reserva por pasos (docs/01 §2.2, docs/06 §4).
 * La página pinta y llama a `lib/bookings`; las reglas (horario, transiciones,
 * precio) las decide el backend. El borrador se guarda en CADA paso y se retoma
 * por `?borrador=` (URL) o `localStorage` (si se cerró el navegador).
 */

const STEPS = ['Datos del cliente', 'Sala y horario', 'Servicios y resumen'] as const;
const STORAGE_KEY = 'coworking:borrador';

interface Form {
  customerName: string;
  customerEmail: string;
  roomId: string;
  date: string;
  startTime: string;
  durationMinutes: string;
  services: ServiceCode[];
}

const EMPTY_FORM: Form = {
  customerName: '',
  customerEmail: '',
  roomId: '',
  date: '',
  startTime: '',
  durationMinutes: '',
  services: [],
};

type FormField = 'customerName' | 'customerEmail' | 'roomId' | 'date' | 'startTime' | 'durationMinutes';
type Touched = Partial<Record<FormField, boolean>>;

const STEP_FIELDS: readonly FormField[][] = [
  ['customerName', 'customerEmail'],
  ['roomId', 'date', 'startTime', 'durationMinutes'],
  [],
];

/** Validación de formato/presencia. Las reglas de negocio (horario…) son del servidor. */
function validate(form: Form): Partial<Record<FormField, string>> {
  const errors: Partial<Record<FormField, string>> = {};
  if (!form.customerName.trim()) errors.customerName = 'Escribe tu nombre.';
  if (!form.customerEmail.trim()) errors.customerEmail = 'Escribe tu correo.';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.customerEmail.trim())) {
    errors.customerEmail = 'Escribe un correo válido.';
  }
  if (!form.roomId) errors.roomId = 'Selecciona una sala.';
  if (!form.date) errors.date = 'Indica la fecha.';
  if (!form.startTime) errors.startTime = 'Indica la hora de inicio.';
  if (!form.durationMinutes) errors.durationMinutes = 'Indica la duración.';
  return errors;
}

/** El servidor manda la sugerencia dentro de `error.details`. */
function readSuggestedSlot(details: unknown): { date: string; startTime: string } | null {
  if (typeof details !== 'object' || details === null || !('suggestedSlot' in details)) return null;
  const slot = (details as { suggestedSlot?: unknown }).suggestedSlot;
  if (typeof slot !== 'object' || slot === null || !('date' in slot) || !('startTime' in slot)) return null;
  return slot as { date: string; startTime: string };
}

function stepFor(booking: Booking): number {
  if (!booking.customerName || !booking.customerEmail) return 0;
  if (booking.roomId === null || booking.date === null || booking.startTime === null) return 1;
  return 2;
}

export function BookingWizardPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [roomsError, setRoomsError] = useState<string | null>(null);
  const [roomsKey, setRoomsKey] = useState(0);

  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [touched, setTouched] = useState<Touched>({});
  const [booking, setBooking] = useState<Booking | null>(null);
  const [step, setStep] = useState(0);
  const [done, setDone] = useState(false);
  /** Hasta terminar de leer URL/localStorage no se pinta el formulario. */
  const [booted, setBooted] = useState(false);

  const [busy, setBusy] = useState<'idle' | 'saving' | 'confirming'>('idle');
  const [pendingService, setPendingService] = useState<ServiceCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [suggested, setSuggested] = useState<{ date: string; startTime: string } | null>(null);
  const [showCancel, setShowCancel] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelTouched, setCancelTouched] = useState(false);
  const retryRef = useRef<(() => Promise<void>) | null>(null);

  const errors = validate(form);
  const roomsList = rooms ?? [];

  const fail = useCallback((message: string, retry: () => Promise<void>) => {
    setError(message);
    retryRef.current = retry;
  }, []);

  const applyBooking = useCallback((next: Booking) => {
    setBooking(next);
    setForm({
      customerName: next.customerName ?? '',
      customerEmail: next.customerEmail ?? '',
      roomId: next.roomId === null ? '' : String(next.roomId),
      date: next.date ?? '',
      startTime: next.startTime ?? '',
      durationMinutes: next.durationMinutes === null ? '' : String(next.durationMinutes),
      services: [...next.services],
    });
    // Solo un borrador editable se retoma al recargar. Una reserva confirmada
    // o cancelada es un resultado final: guardarla aquí hacía que el wizard
    // resurrecta sus datos viejos y ofreciera sugerencias inválidas.
    if (next.status === 'draft') {
      localStorage.setItem(STORAGE_KEY, String(next.id));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  // Carga de salas (estado carga / error / éxito).
  useEffect(() => {
    const controller = new AbortController();
    setRoomsError(null);
    fetchRooms(controller.signal)
      .then((data) => setRooms(data.rooms))
      .catch((error_: unknown) => {
        if (controller.signal.aborted) return;
        setRooms([]);
        setRoomsError(error_ instanceof ApiError ? error_.message : 'No se pudieron cargar las salas.');
      });
    return () => controller.abort();
  }, [roomsKey]);

  // Retomado + rellenado desde la cotización (una sola vez).
  useEffect(() => {
    let cancelled = false;

    async function restore(): Promise<void> {
      try {
        const params = new URLSearchParams(window.location.search);
        const id = params.get('borrador') ?? localStorage.getItem(STORAGE_KEY);

        if (id && /^\d+$/.test(id)) {
          try {
            const existing = await fetchBooking(Number(id));
            if (cancelled) return;
            applyBooking(existing);
            setStep(stepFor(existing));
            if (existing.status === 'confirmed') {
              setDone(true);
              setNotice(`La reserva #${existing.id} ya estaba confirmada.`);
            } else if (existing.status === 'cancelled') {
              setDone(true);
              setNotice(`La reserva #${existing.id} está cancelada.`);
            } else {
              setNotice(`Borrador retomado #${existing.id}, continúa donde lo dejaste.`);
            }
            return;
          } catch {
            if (cancelled) return;
            // Id caducado, inexistente o ya finalizado: no se debe retomar como
            // borrador editable. Se empieza uno nuevo sin romper la UI.
            localStorage.removeItem(STORAGE_KEY);
          }
        }

        // Sin borrador: rellena el horario que venía de la cotización.
        const sala = params.get('sala');
        const fecha = params.get('fecha');
        const hora = params.get('hora');
        const duracion = params.get('duracion');
        if (sala || fecha || hora || duracion) {
          setForm((current) => ({
            ...current,
            roomId: sala ?? current.roomId,
            date: fecha ?? current.date,
            startTime: hora ?? current.startTime,
            durationMinutes: duracion ?? current.durationMinutes,
          }));
          setNotice('Datos de tu cotización cargados en el paso 2.');
        }
      } finally {
        // También con un id caducado: la UI deja de mostrar el esqueleto.
        if (!cancelled) setBooted(true);
      }
    }

    void restore();
    return () => {
      cancelled = true;
    };
  }, [applyBooking]);

  function payload(nextForm: Form = form): DraftInput {
    return {
      id: booking?.id,
      customerName: nextForm.customerName.trim() || undefined,
      customerEmail: nextForm.customerEmail.trim() || undefined,
      roomId: nextForm.roomId ? Number(nextForm.roomId) : undefined,
      date: nextForm.date || undefined,
      startTime: nextForm.startTime || undefined,
      durationMinutes: nextForm.durationMinutes ? Number(nextForm.durationMinutes) : undefined,
      services: nextForm.services,
    };
  }

  async function persist(nextForm: Form = form): Promise<Booking> {
    const saved = await saveDraft(payload(nextForm));
    applyBooking(saved);
    setSearchParams({ borrador: String(saved.id) });
    return saved;
  }

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy('saving');
    setError(null);
    try {
      await action();
    } catch (error_) {
      const message =
        error_ instanceof ApiError ? error_.message : 'No se pudo guardar. Comprueba tu conexión.';
      fail(message, action);
    } finally {
      setBusy('idle');
    }
  }

  function markTouched(fields: readonly FormField[]): void {
    setTouched((current) => {
      const next = { ...current };
      for (const field of fields) next[field] = true;
      return next;
    });
  }

  function hasErrors(fields: readonly FormField[]): boolean {
    return fields.some((field) => Boolean(errors[field]));
  }

  async function goToStep(target: number): Promise<void> {
    const fields = STEP_FIELDS[step] ?? [];
    markTouched(fields);
    if (hasErrors(fields)) return;
    if (target > step) {
      // `setStep` va DENTRO de la acción: si el guardado falla (p. ej. 422 del
      // servidor) no se avanza de paso y queda el error visible con reintento.
      await run(async () => {
        await persist();
        setStep(target);
      });
    } else {
      setStep(target);
    }
  }

  async function toggleService(code: ServiceCode): Promise<void> {
    const services = form.services.includes(code)
      ? form.services.filter((item) => item !== code)
      : [...form.services, code];
    const nextForm = { ...form, services };
    setForm(nextForm);
    setBusy('saving');
    setPendingService(code);
    setError(null);
    try {
      await persist(nextForm);
    } catch (error_) {
      const message = error_ instanceof ApiError ? error_.message : 'No se pudieron guardar los servicios.';
      fail(message, () => toggleService(code));
    } finally {
      setBusy('idle');
      setPendingService(null);
    }
  }

  async function handleConfirm(): Promise<void> {
    await run(async () => {
      const saved = await persist();
      try {
        const confirmed = await confirmBooking(saved.id);
        applyBooking(confirmed);
        setDone(true);
        setSuggested(null);
        localStorage.removeItem(STORAGE_KEY);
        setSearchParams({});
      } catch (error_) {
        // 409 = la sala se ocupó entre medias: se ofrece el siguiente hueco.
        if (error_ instanceof ApiError && error_.status === 409) {
          setSuggested(readSuggestedSlot(error_.details));
        }
        throw error_;
      }
    });
  }

  async function useSuggested(slot: { date: string; startTime: string }): Promise<void> {
    // Una reserva cancelada no se puede editar: la sugerencia crea un borrador
    // NUEVO con el horario alternativo, conservando los datos del cliente.
    if (booking?.status === 'cancelled') {
      const nextForm: Form = {
        ...EMPTY_FORM,
        customerName: booking.customerName ?? '',
        customerEmail: booking.customerEmail ?? '',
        roomId: booking.roomId === null ? '' : String(booking.roomId),
        date: slot.date,
        startTime: slot.startTime,
        durationMinutes: booking.durationMinutes === null ? '' : String(booking.durationMinutes),
        services: [...booking.services],
      };
      setBooking(null);
      setForm(nextForm);
      setTouched({});
      setDone(false);
      setSuggested(null);
      setNotice('Borrador nuevo creado con el horario sugerido.');
      await run(async () => {
        const created = await saveDraft({
          customerName: nextForm.customerName,
          customerEmail: nextForm.customerEmail,
          roomId: nextForm.roomId ? Number(nextForm.roomId) : undefined,
          date: nextForm.date,
          startTime: nextForm.startTime,
          durationMinutes: nextForm.durationMinutes ? Number(nextForm.durationMinutes) : undefined,
          services: nextForm.services,
        });
        applyBooking(created);
        setSearchParams({ borrador: String(created.id) });
        setStep(2);
      });
      return;
    }

    if (booking?.status !== 'draft') return;
    const nextForm = { ...form, date: slot.date, startTime: slot.startTime };
    setForm(nextForm);
    setSuggested(null);
    await run(async () => {
      await persist(nextForm);
      setStep(2);
    });
  }

  /** Cancela con motivo obligatorio (también validado en el servidor). */
  async function handleCancel(): Promise<void> {
    if (!booking) return;
    setCancelTouched(true);
    const reason = cancelReason.trim();
    if (!reason) return;
    const id = booking.id;
    await run(async () => {
      const cancelled = await cancelBooking(id, reason);
      applyBooking(cancelled);
      setDone(true);
      setShowCancel(false);
      // La sugerencia se recalcula en el servidor: tras cancelar, el turno
      // queda libre y `availability` vuelve a traer el hueco alternativo.
      setSuggested(null);
      localStorage.removeItem(STORAGE_KEY);
      setSearchParams({});
    });
  }

  /**
   * Empieza una cotización nueva desde cero. Borra el borrador local para que
   * el wizard no retome una reserva ya confirmada o cancelada.
   */
  function handleNewQuote(): void {
    try {
      localStorage.removeItem(STORAGE_KEY);
      sessionStorage.removeItem('coworking:cotizacion');
    } catch {
      // Sin storage la aplicación sigue funcionando.
    }
    setBooking(null);
    setForm(EMPTY_FORM);
    setTouched({});
    setStep(0);
    setDone(false);
    setSuggested(null);
    setError(null);
    setNotice(null);
    setShowCancel(false);
    setCancelReason('');
    setCancelTouched(false);
    setSearchParams({});
    navigate('/', { replace: true });
  }

  /** Continúa un borrador guardado sin crear otra reserva. */
  function handleResumeDraft(): void {
    setDone(false);
    setStep(booking ? stepFor(booking) : 0);
    setNotice(null);
  }

  /** Un borrador solo se marca como "guardado" si el usuario lo deja a medias. */
  function handleDraftSaved(): void {
    if (!booking) return;
    setDone(true);
    setNotice(`Borrador #${booking.id} guardado.`);
  }

  /** Persiste el borrador y vuelve al resumen para que pueda cancelarse. */
  async function handleSaveDraft(): Promise<void> {
    await run(async () => {
      await persist();
      handleDraftSaved();
    });
  }

  /** Hueco a ofrecer: el del último 409 o el aviso de disponibilidad del servidor. */
  const slotToOffer =
    booking?.status === 'draft' || booking?.status === 'cancelled'
      ? suggested ?? booking.availability?.suggestedSlot ?? null
      : null;

  function handleBack(): void {
    setStep((current) => Math.max(0, current - 1));
    setError(null);
  }

  function submitStep(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void goToStep(step + 1);
  }

  const fieldError = (field: FormField): string | undefined =>
    touched[field] ? errors[field] : undefined;

  /**
   * Cancelación con motivo obligatorio (docs/04 Fase 2). Se pinta fuera de los
   * `<form>` para que su botón nunca dispare el envío del paso.
   */
  function cancelSection(): ReactNode {
    if (!booking || (booking.status !== 'draft' && booking.status !== 'confirmed')) return null;

    const reasonError = cancelTouched && !cancelReason.trim() ? 'El motivo es obligatorio.' : undefined;
    return (
      <>
        <Collapse open={!showCancel}>
          <div className="form-actions">
            <Button variant="danger" onClick={() => setShowCancel(true)}>
              Cancelar reserva
            </Button>
          </div>
        </Collapse>
        <Collapse open={showCancel}>
          <div className="cancel-panel">
            <h3>Cancelar la reserva</h3>
            <p>El motivo es obligatorio y este cambio no se puede deshacer.</p>
            <Textarea
              label="Motivo de la cancelación"
              value={cancelReason}
              maxLength={500}
              error={reasonError}
              onBlur={() => setCancelTouched(true)}
              onChange={(event) => setCancelReason(event.target.value)}
            />
            <div className="form-actions">
              <Button
                variant="secondary"
                onClick={() => {
                  setShowCancel(false);
                  setCancelTouched(false);
                }}
              >
                Volver
              </Button>
              <Button variant="danger" loading={busy === 'saving'} onClick={() => void handleCancel()}>
                Confirmar cancelación
              </Button>
            </div>
          </div>
        </Collapse>
      </>
    );
  }

  if (!booted) {
    return (
      <div className="stack-lg">
        <h1>Reserva por pasos</h1>
        <Card>
          <Skeleton variant="fields" rows={3} label="Recuperando tu borrador…" />
        </Card>
      </div>
    );
  }

  if (done && booking) {
    const confirmed = booking.status === 'confirmed';
    const cancelled = booking.status === 'cancelled';
    return (
      <div className="stack-lg rise-in">
        <div>
          <h1>{confirmed ? 'Reserva confirmada' : cancelled ? 'Reserva cancelada' : 'Reserva guardada'}</h1>
          <p className="page-intro">
            {confirmed ? (
              <>
                Todo listo. Reserva <strong>#{booking.id}</strong> de {booking.roomName}.
              </>
            ) : cancelled ? (
              <>
                La reserva <strong>#{booking.id}</strong> quedó cancelada y el turno vuelve a estar
                libre.
              </>
            ) : (
              <>
                La reserva <strong>#{booking.id}</strong> sigue en borrador. Puedes cancelarla con un
                motivo o empezar otra cotización.
              </>
            )}
          </p>
        </div>
        <Card title="Resumen">
          <div
            className={`quote-result ${confirmed ? 'quote-result--available' : 'quote-result--blocked'}`}
            role="status"
            aria-live="polite"
          >
            <h3>{confirmed ? 'Confirmada' : cancelled ? 'Cancelada' : 'Borrador'}</h3>
            <p>
              <time dateTime={`${booking.date}T${booking.startTime}`}>
                {booking.date} de {booking.startTime} a {booking.endTime}
              </time>
            </p>
            <p>
              A nombre de {booking.customerName} · {booking.customerEmail}
            </p>
            {confirmed ? (
              <p className="breakdown__total-value">{formatCop(booking.total ?? 0)}</p>
            ) : cancelled ? (
              <p>Motivo: {booking.cancelReason}</p>
            ) : (
              <p>El borrador se puede retomar o cancelar.</p>
            )}
          </div>
          {cancelSection()}
          {cancelled && (
            <div className="alert" role="alert">
              <p>
                {booking.availability && !booking.availability.canBook
                  ? booking.availability.reason
                  : 'El horario quedó libre. Puedes crear un borrador nuevo con otra fecha u hora.'}
              </p>
              {slotToOffer ? (
                <Button variant="secondary" onClick={() => void useSuggested(slotToOffer)}>
                  Usar {slotToOffer.date} a las {slotToOffer.startTime}
                </Button>
              ) : (
                <Button variant="secondary" onClick={handleNewQuote}>
                  Cotizar otra sala
                </Button>
              )}
            </div>
          )}
          <div className="form-actions">
            {!confirmed && !cancelled && (
              <Button variant="secondary" onClick={handleResumeDraft}>
                Continuar en el wizard
              </Button>
            )}
            <Button variant="primary" onClick={handleNewQuote}>
              Cotizar otra sala
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="stack-lg">
      <div>
        <h1>Reserva por pasos</h1>
        <p className="page-intro">
          Tres pasos: tus datos, la sala y horario elegidos, y los servicios adicionales.
        </p>
      </div>

      <Collapse open={Boolean(notice)}>
        {notice && (
          <p className="notice" role="status" aria-live="polite">
            {notice}
          </p>
        )}
      </Collapse>

      <Card title={`Paso ${step + 1} de 3`}>
        <Stepper steps={STEPS} currentStep={step} label="Progreso de la reserva" />

        <Collapse open={Boolean(error)}>
          {error && <ErrorState message={error} onRetry={() => { const action = retryRef.current; setError(null); if (action) void action(); }} />}
        </Collapse>

        <div key={step} className="step-panel rise-in" aria-busy={busy === 'saving' || undefined}>
        {step === 0 && (
          <form onSubmit={submitStep} noValidate>
            <Input
              label="Nombre completo"
              value={form.customerName}
              autoComplete="name"
              error={fieldError('customerName')}
              onBlur={() => markTouched(['customerName'])}
              onChange={(event) => setForm((current) => ({ ...current, customerName: event.target.value }))}
            />
            <Input
              label="Correo electrónico"
              type="email"
              value={form.customerEmail}
              autoComplete="email"
              error={fieldError('customerEmail')}
              onBlur={() => markTouched(['customerEmail'])}
              onChange={(event) => setForm((current) => ({ ...current, customerEmail: event.target.value }))}
            />
            <div className="form-actions">
              <Button type="submit" variant="primary" loading={busy === 'saving'}>
                Continuar
              </Button>
            </div>
          </form>
        )}

        {step === 1 && (
          <form onSubmit={submitStep} noValidate>
            {roomsError ? (
              <ErrorState message={roomsError} onRetry={() => setRoomsKey((key) => key + 1)} />
            ) : rooms === null ? (
              <Skeleton variant="fields" rows={4} label="Cargando salas…" />
            ) : roomsList.length === 0 ? (
              <EmptyState
                title="No hay salas disponibles"
                description="En este momento no hay ninguna sala activa. Vuelve a intentarlo en unos minutos."
                action={
                  <Button variant="secondary" onClick={() => setRoomsKey((key) => key + 1)}>
                    Reintentar
                  </Button>
                }
              />
            ) : (
              <>
                <Select
                  label="Sala"
                  value={form.roomId}
                  error={fieldError('roomId')}
                  onBlur={() => markTouched(['roomId'])}
                  onChange={(event) => setForm((current) => ({ ...current, roomId: event.target.value }))}
                >
                  <option value="" disabled>
                    Selecciona una sala…
                  </option>
                  {roomsList.map((room) => (
                    <option key={room.id} value={room.id}>
                      {room.name} · hasta {room.capacity} personas · {formatCop(room.hourlyRate)}/h
                    </option>
                  ))}
                </Select>
                <fieldset className="fieldset">
                  <legend className="fieldset__legend">Horario de la reserva</legend>
                  <Input
                    label="Fecha"
                    type="date"
                    value={form.date}
                    error={fieldError('date')}
                    onBlur={() => markTouched(['date'])}
                    onChange={(event) => setForm((current) => ({ ...current, date: event.target.value }))}
                  />
                  <Select
                    label="Hora de inicio"
                    value={form.startTime}
                    error={fieldError('startTime')}
                    onBlur={() => markTouched(['startTime'])}
                    onChange={(event) => setForm((current) => ({ ...current, startTime: event.target.value }))}
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
                    error={fieldError('durationMinutes')}
                    onBlur={() => markTouched(['durationMinutes'])}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, durationMinutes: event.target.value }))
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
              </>
            )}
            <div className="form-actions">
              <Button variant="secondary" onClick={handleBack}>
                Atrás
              </Button>
              <Button type="submit" variant="primary" loading={busy === 'saving'}>
                Continuar
              </Button>
            </div>
          </form>
        )}

        {step === 2 && (
          <div>
            <fieldset className="fieldset" aria-busy={pendingService !== null || undefined}>
              <legend className="fieldset__legend">Servicios adicionales</legend>
              {SERVICE_OPTIONS.map((service) => {
                const pending = pendingService === service.code;
                return (
                  <label
                    key={service.code}
                    className={`check${pending ? ' check--busy' : ''}`}
                    aria-busy={pending || undefined}
                  >
                    <input
                      type="checkbox"
                      checked={form.services.includes(service.code)}
                      disabled={pendingService !== null}
                      onChange={() => void toggleService(service.code)}
                    />
                    <span>
                      {service.label} · {formatCop(service.price)}
                    </span>
                    {pending && <span className="inline-spinner" aria-hidden="true" />}
                    {pending && <span className="sr-only">Guardando…</span>}
                  </label>
                );
              })}
            </fieldset>

            <h3>Resumen</h3>
            <dl className="breakdown">
              {booking?.lines.map((line) => (
                <Fragment key={`${line.kind}-${line.concept}`}>
                  <dt className={line.amount < 0 ? 'breakdown__discount' : undefined}>{line.concept}</dt>
                  <dd className={line.amount < 0 ? 'breakdown__discount' : undefined}>
                    {line.amount < 0 ? `−${formatCop(Math.abs(line.amount))}` : formatCop(line.amount)}
                  </dd>
                </Fragment>
              ))}
              <dt className="breakdown__total-label">Total</dt>
              <dd className="breakdown__total-value">{formatCop(booking?.total ?? 0)}</dd>
            </dl>

            <Collapse
              open={Boolean(
                (booking?.status === 'draft' || booking?.status === 'cancelled') &&
                  booking?.availability &&
                  !booking.availability.canBook,
              )}
            >
              {(booking?.status === 'draft' || booking?.status === 'cancelled') &&
                booking.availability &&
                !booking.availability.canBook && (
                  <div className="alert" role="alert">
                    <p>{booking.availability.reason}</p>
                    {slotToOffer && (
                      <Button variant="secondary" onClick={() => void useSuggested(slotToOffer)}>
                        Usar {slotToOffer.date} a las {slotToOffer.startTime}
                      </Button>
                    )}
                  </div>
                )}
            </Collapse>

            <div className="form-actions">
              <Button variant="secondary" onClick={handleBack}>
                Atrás
              </Button>
              <Button
                variant="secondary"
                loading={busy === 'saving'}
                onClick={() => void handleSaveDraft()}
              >
                Guardar borrador
              </Button>
              <Button
                variant="primary"
                loading={busy === 'saving'}
                onClick={() => void handleConfirm()}
              >
                Confirmar reserva
              </Button>
            </div>
          </div>
        )}
        </div>
      </Card>
      {cancelSection()}
    </div>
  );
}
