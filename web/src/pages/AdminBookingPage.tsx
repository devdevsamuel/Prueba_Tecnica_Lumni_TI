import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { AdminGate } from '../components/AdminGate';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Collapse } from '../components/Collapse';
import { Textarea } from '../components/Input';
import { Modal } from '../components/Modal';
import { isStatusKind, StatusBadge } from '../components/StatusBadge';
import { Skeleton } from '../components/Skeleton';
import { ErrorState } from '../components/states';
import { ApiError } from '../lib/api';
import { adminCancelBooking, adminFetchBooking } from '../lib/admin';
import { useSession } from '../lib/auth';
import { formatCop } from '../lib/quotes';
import type { Booking } from '../lib/bookings';

/**
 * Detalle de reserva del admin (docs/01 §2.3): líneas del precio y cancelación
 * con motivo obligatorio **en un modal** con trampa de foco (docs/05 §2).
 * El botón "Volver" recupera la URL del listado para no perder filtros ni página.
 */
export function AdminBookingPage() {
  const params = useParams<{ id?: string }>();
  const location = useLocation();
  const session = useSession();

  const bookingId = Number(params.id);
  const state = location.state as { from?: string } | null;
  const backTo = state?.from ? `/admin?${state.from}` : '/admin';

  const [booking, setBooking] = useState<Booking | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [modalOpen, setModalOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonTouched, setReasonTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const isAdmin = session.user?.role === 'admin';

  useEffect(() => {
    if (!isAdmin || !Number.isInteger(bookingId) || bookingId <= 0) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    adminFetchBooking(bookingId, controller.signal)
      .then(setBooking)
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof ApiError ? cause.message : 'No se pudo cargar la reserva.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [isAdmin, bookingId, reloadKey]);

  async function confirmCancel(): Promise<void> {
    const trimmed = reason.trim();
    setReasonTouched(true);
    if (!trimmed || !booking) return;

    setSaving(true);
    setSaveError(null);
    try {
      const updated = await adminCancelBooking(booking.id, trimmed);
      setBooking(updated);
      setModalOpen(false);
      setReason('');
      setReasonTouched(false);
    } catch (cause: unknown) {
      setSaveError(cause instanceof ApiError ? cause.message : 'No se pudo cancelar la reserva.');
    } finally {
      setSaving(false);
    }
  }

  // ── Contenido (la puerta de sesión la resuelve AdminGate) ─────────────────
  let content: ReactNode;
  if (loading) {
    content = (
      <Card>
        <Skeleton variant="card" rows={4} label="Cargando reserva…" />
      </Card>
    );
  } else if (error || !booking) {
    content = (
      <Card>
        <ErrorState
          message={error ?? 'Reserva no encontrada.'}
          onRetry={() => setReloadKey((key) => key + 1)}
        />
        <div className="form-actions">
          <Link className="btn btn--secondary" to={backTo}>
            Volver al listado
          </Link>
        </div>
      </Card>
    );
  } else {
    const cancellable = booking.status === 'draft' || booking.status === 'confirmed';
    const reasonError = reasonTouched && !reason.trim() ? 'El motivo es obligatorio.' : undefined;

    content = (
      <>
        <Card title="Resumen">
          <dl className="breakdown">
            <dt>Estado</dt>
            <dd>
              {booking.status && isStatusKind(booking.status) ? (
                <StatusBadge status={booking.status} />
              ) : (
                booking.status
              )}
            </dd>
            <dt>Cliente</dt>
            <dd>
              {booking.customerName ?? '—'} · {booking.customerEmail ?? '—'}
            </dd>
            <dt>Sala</dt>
            <dd>{booking.roomName ?? '—'}</dd>
            <dt>Horario</dt>
            <dd>
              {booking.date && booking.startTime ? (
                <time dateTime={`${booking.date}T${booking.startTime}`}>
                  {booking.date} · {booking.startTime} – {booking.endTime}
                </time>
              ) : (
                'Sin horario'
              )}
            </dd>
            {booking.cancelReason && (
              <>
                <dt>Motivo de cancelación</dt>
                <dd>{booking.cancelReason}</dd>
              </>
            )}
          </dl>
        </Card>

        <Card title="Desglose">
          <dl className="breakdown">
            {booking.lines.map((line) => (
              <div key={`${line.kind}-${line.concept}`} className="breakdown__row">
                <dt className={line.amount < 0 ? 'breakdown__discount' : undefined}>{line.concept}</dt>
                <dd className={line.amount < 0 ? 'breakdown__discount' : undefined}>
                  {line.amount < 0 ? `−${formatCop(Math.abs(line.amount))}` : formatCop(line.amount)}
                </dd>
              </div>
            ))}
            <div className="breakdown__row breakdown__total-row">
              <dt className="breakdown__total-label">Total</dt>
              <dd className="breakdown__total-value">{formatCop(booking.total ?? 0)}</dd>
            </div>
          </dl>
        </Card>

        <div className="form-actions">
          <Link className="btn btn--secondary" to={backTo}>
            Volver al listado
          </Link>
          {cancellable && (
            <Button variant="danger" onClick={() => setModalOpen(true)}>
              Cancelar reserva
            </Button>
          )}
        </div>

        <Modal
          title={`Cancelar la reserva #${booking.id}`}
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setModalOpen(false)}>
                Volver
              </Button>
              <Button variant="danger" loading={saving} onClick={() => void confirmCancel()}>
                Confirmar cancelación
              </Button>
            </>
          }
        >
          <Collapse open={Boolean(saveError)}>
            {saveError && (
              <p className="alert" role="alert">
                {saveError}
              </p>
            )}
          </Collapse>
          <p>
            El motivo es obligatorio. Esta acción pasará la reserva a <strong>cancelada</strong> y no
            se puede deshacer.
          </p>
          <Textarea
            label="Motivo de la cancelación"
            value={reason}
            maxLength={500}
            error={reasonError}
            onBlur={() => setReasonTouched(true)}
            onChange={(event) => setReason(event.target.value)}
          />
        </Modal>
      </>
    );
  }

  return (
    <AdminGate session={session} title={`Reserva #${bookingId}`} intro="Detalle de la reserva">
      <div key={loading ? 'loading' : 'ready'} className={loading ? undefined : 'rise-in'}>
        {content}
      </div>
    </AdminGate>
  );
}
