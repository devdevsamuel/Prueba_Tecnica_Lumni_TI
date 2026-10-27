import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AdminGate } from '../components/AdminGate';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Select } from '../components/Input';
import { isStatusKind, StatusBadge } from '../components/StatusBadge';
import { Table, type Column } from '../components/Table';
import { Skeleton } from '../components/Skeleton';
import { EmptyState, ErrorState } from '../components/states';
import { ApiError } from '../lib/api';
import { fetchEmails, isEmailStatus, type EmailItem, type EmailListResponse } from '../lib/admin';
import { formatBogotaFull } from '../lib/datetime';
import { useSession } from '../lib/auth';

/**
 * Bandeja de correos del admin (Parte 2.1, docs/04 §5): muestra lo que salió
 * (y lo que no) con el filtro de estado en la URL. Cubre los 4 estados de
 * interfaz (docs/06 §3) y distingue "sin correos" de "sin resultados del filtro".
 */

const PAGE_SIZE = 10;

const STATUS_OPTIONS = [
  { value: 'pending', label: 'Pendiente' },
  { value: 'sending', label: 'Enviando' },
  { value: 'sent', label: 'Enviado' },
  { value: 'failed', label: 'Fallido' },
  { value: 'skipped', label: 'Omitido' },
] as const;

export function AdminEmailsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const session = useSession();

  const [data, setData] = useState<EmailListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1);
  // Un estado inventado en la URL se ignora (no debe provocar un 400).
  const statusParam = searchParams.get('status') ?? '';
  const status = isEmailStatus(statusParam) ? statusParam : undefined;
  const isAdmin = session.user?.role === 'admin';

  useEffect(() => {
    if (!isAdmin) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchEmails({ page, pageSize: PAGE_SIZE, status }, controller.signal)
      .then(setData)
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof ApiError ? cause.message : 'No se pudo cargar la bandeja.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [isAdmin, page, status, reloadKey]);

  // Igual que en reservas: una página fuera de rango vuelve a la última real.
  useEffect(() => {
    if (data && data.totalPages > 0 && page > data.totalPages) {
      applyPage(data.totalPages);
    }
  }, [data, page]);

  function applyFilter(value: string): void {
    const next = new URLSearchParams(searchParams);
    if (value) next.set('status', value);
    else next.delete('status');
    next.delete('page');
    setSearchParams(next);
  }

  function applyPage(value: number): void {
    const next = new URLSearchParams(searchParams);
    if (value > 1) next.set('page', String(value));
    else next.delete('page');
    setSearchParams(next);
  }

  function clearFilters(): void {
    const next = new URLSearchParams(searchParams);
    next.delete('status');
    next.delete('page');
    setSearchParams(next);
  }

  const hasFilter = Boolean(status);
  const initialLoading = loading && data === null;
  const refreshing = loading && data !== null;
  const columns: Column<EmailItem>[] = [
    { key: 'id', header: 'ID', render: (item) => item.id },
    { key: 'subject', header: 'Asunto', render: (item) => item.subject },
    { key: 'booking', header: 'Reserva', render: (item) => item.bookingId },
    { key: 'recipient', header: 'Destinatario', render: (item) => item.recipient },
    {
      key: 'status',
      header: 'Estado',
      render: (item) =>
        isStatusKind(item.status) ? <StatusBadge status={item.status} /> : item.status,
    },
    { key: 'attempts', header: 'Intentos', render: (item) => item.attempts },
    {
      key: 'timestamp',
      header: 'Enviado',
      render: (item) =>
        item.sentAt ? (
          <time dateTime={item.sentAt}>{formatBogotaFull(item.sentAt)}</time>
        ) : (
          '—'
        ),
    },
    {
      key: 'actions',
      header: 'Detalle',
      render: (item) => (
        <Link
          to={{ pathname: `/admin/correos/${item.id}` }}
          state={{ from: searchParams.toString() }}
        >
          Ver correo {item.id}
        </Link>
      ),
    },
  ];

  return (
    <AdminGate session={session} title="Correos" intro="Bandeja de salida de confirmaciones y recordatorios">
      <Card title="Filtros">
        <div className="filters">
          <Select
            label="Filtrar por estado"
            value={status ?? ''}
            onChange={(event) => applyFilter(event.target.value)}
          >
            <option value="">Todos los estados</option>
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          {hasFilter && (
            <div className="filters__actions">
              <Button variant="secondary" onClick={clearFilters}>
                Limpiar filtros
              </Button>
            </div>
          )}
        </div>
      </Card>

      <Card title="Bandeja">
        {error ? (
          <ErrorState message={error} onRetry={() => setReloadKey((key) => key + 1)} />
        ) : initialLoading ? (
          <Skeleton variant="table" rows={PAGE_SIZE} columns={columns.length} label="Cargando la bandeja…" />
        ) : !data ? null : (
          <>
            {refreshing && <div className="refresh-bar" role="status" aria-label="Actualizando la bandeja" />}
            <div className={refreshing ? 'is-refreshing' : undefined} aria-busy={refreshing || undefined}>
              {data.total === 0 && hasFilter ? (
                <EmptyState
                  title="Sin resultados para este filtro"
                  description="Ningún correo coincide con el estado seleccionado."
                  action={
                    <Button variant="secondary" onClick={clearFilters}>
                      Limpiar filtros
                    </Button>
                  }
                />
              ) : data.total === 0 ? (
                <EmptyState
                  title="Todavía no ha salido ningún correo"
                  description="Las confirmaciones y los recordatorios aparecen aquí en cuanto se encolan."
                />
              ) : (
                <>
                  <Table
                    caption={`Correos (página ${data.page} de ${Math.max(1, data.totalPages)}, ${data.total} en total)`}
                    columns={columns}
                    rows={data.items}
                    rowKey={(item) => item.id}
                  />

                  {data.totalPages > 1 && (
                    <nav className="pagination" aria-label="Paginación de correos">
                      {page > 1 ? (
                        <Button variant="secondary" onClick={() => applyPage(page - 1)}>
                          Página anterior
                        </Button>
                      ) : (
                        <span className="pagination__gap" aria-hidden="true" />
                      )}
                      <span className="pagination__current" aria-current="page">
                        Página {page} de {data.totalPages}
                      </span>
                      {page < data.totalPages ? (
                        <Button variant="secondary" onClick={() => applyPage(page + 1)}>
                          Página siguiente
                        </Button>
                      ) : (
                        <span className="pagination__gap" aria-hidden="true" />
                      )}
                    </nav>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </Card>
    </AdminGate>
  );
}
