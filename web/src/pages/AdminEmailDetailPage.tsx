import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { AdminGate } from '../components/AdminGate';
import { Card } from '../components/Card';
import { isStatusKind, StatusBadge } from '../components/StatusBadge';
import { ErrorState, LoadingState } from '../components/states';
import { ApiError } from '../lib/api';
import { fetchEmail, type EmailDetail } from '../lib/admin';
import { formatBogotaFull } from '../lib/datetime';
import { useSession } from '../lib/auth';

/**
 * Detalle del correo (Parte 2.1): asunto, destinatario, cuerpo legible y todas
 * las marcas de tiempo (creado / próximo intento / enviado) más el último error,
 * que es lo que permite leer en vivo un reintento (docs/04 §5, docs/06 §4).
 */
export function AdminEmailDetailPage() {
  const params = useParams<{ id?: string }>();
  const location = useLocation();
  const session = useSession();

  const emailId = Number(params.id);
  const state = location.state as { from?: string } | null;
  const backTo = state?.from ? `/admin/correos?${state.from}` : '/admin/correos';

  const [email, setEmail] = useState<EmailDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const isAdmin = session.user?.role === 'admin';

  useEffect(() => {
    if (!isAdmin || !Number.isInteger(emailId) || emailId <= 0) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchEmail(emailId, controller.signal)
      .then(setEmail)
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof ApiError ? cause.message : 'No se pudo cargar el correo.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [isAdmin, emailId, reloadKey]);

  let content: ReactNode;
  if (loading) {
    content = (
      <Card>
        <LoadingState label="Cargando el correo…" />
      </Card>
    );
  } else if (error || !email) {
    content = (
      <Card>
        <ErrorState
          message={error ?? 'Correo no encontrado.'}
          onRetry={() => setReloadKey((key) => key + 1)}
        />
        <div className="form-actions">
          <Link className="btn btn--secondary" to={backTo}>
            Volver a la bandeja
          </Link>
        </div>
      </Card>
    );
  } else {
    content = (
      <>
        <Card title={email.subject}>
          <dl className="breakdown">
            <dt>Estado</dt>
            <dd>
              {isStatusKind(email.status) ? <StatusBadge status={email.status} /> : email.status}
            </dd>
            <dt>Destinatario</dt>
            <dd>
              {email.recipient} ({email.customerName})
            </dd>
            <dt>Sala</dt>
            <dd>{email.roomName ?? '—'}</dd>
            <dt>Reserva</dt>
            <dd>
              <Link to={{ pathname: `/admin/reserva/${email.bookingId}` }}>
                Ver reserva {email.bookingId}
              </Link>
            </dd>
            <dt>Intentos</dt>
            <dd>{email.attempts}</dd>
            <dt>Creado</dt>
            <dd>{formatBogotaFull(email.createdAt)}</dd>
            <dt>Próximo intento</dt>
            <dd>{formatBogotaFull(email.nextAttemptAt)}</dd>
            <dt>Enviado</dt>
            <dd>{formatBogotaFull(email.sentAt)}</dd>
            {email.lastError && (
              <>
                <dt>Último error</dt>
                <dd className="breakdown__discount">{email.lastError}</dd>
              </>
            )}
          </dl>
        </Card>

        <Card title="Cuerpo del correo">
          <pre className="email-body">{email.body}</pre>
        </Card>

        <div className="form-actions">
          <Link className="btn btn--secondary" to={backTo}>
            Volver a la bandeja
          </Link>
        </div>
      </>
    );
  }

  return (
    <AdminGate session={session} title={`Correo #${emailId}`} intro="Detalle del mensaje">
      {content}
    </AdminGate>
  );
}
