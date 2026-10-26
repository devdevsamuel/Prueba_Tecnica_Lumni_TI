import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AdminGate } from '../components/AdminGate';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Select } from '../components/Input';
import { isStatusKind, StatusBadge } from '../components/StatusBadge';
import { Table, type Column } from '../components/Table';
import { EmptyState, ErrorState, LoadingState } from '../components/states';
import { ApiError } from '../lib/api';
import { fetchBookings, type AdminListItem, type AdminListResponse } from '../lib/admin';
import { formatBogota } from '../lib/datetime';
import { useSession } from '../lib/auth';
import { fetchRooms, formatCop, type Room } from '../lib/quotes';

/**
 * Pantalla 3 — Listado del admin (docs/01 §2.3, docs/06 §4): filtros y página
 * viven en la URL (refrescables y compartibles) y los estados vacíos se
 * distinguen entre "sin reservas" y "sin resultados del filtro".
 * La puerta de sesión y las pestañas las aporta `AdminGate`.
 */

const PAGE_SIZE = 10;

const STATUS_OPTIONS = [
  { value: 'draft', label: 'Borrador' },
  { value: 'confirmed', label: 'Confirmada' },
  { value: 'completed', label: 'Completada' },
  { value: 'cancelled', label: 'Cancelada' },
] as const;

export function AdminPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const session = useSession();

  const [data, setData] = useState<AdminListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [rooms, setRooms] = useState<Room[]>([]);

  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1);
  const status = searchParams.get('status') ?? '';
  const room = searchParams.get('room') ?? '';
  const isAdmin = session.user?.role === 'admin';

  useEffect(() => {
    if (!isAdmin) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchBookings(
      { page, pageSize: PAGE_SIZE, status: status || undefined, room: room || undefined },
      controller.signal,
    )
      .then(setData)
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof ApiError ? cause.message : 'No se pudo cargar el listado.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [isAdmin, page, status, room, reloadKey]);

  // El selector de salas solo se pide una vez.
  useEffect(() => {
    if (!isAdmin) return;
    fetchRooms()
      .then((result) => setRooms(result.rooms))
      .catch(() => setRooms([]));
  }, [isAdmin]);

  function applyFilter(key: 'status' | 'room', value: string): void {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete('page'); // un filtro nuevo vuelve siempre a la página 1
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
    next.delete('room');
    next.delete('page');
    setSearchParams(next);
  }

  const hasFilters = Boolean(status || room);
  const columns: Column<AdminListItem>[] = [
    { key: 'id', header: 'ID', render: (item) => item.id },
    { key: 'customer', header: 'Cliente', render: (item) => item.customerName },
    { key: 'room', header: 'Sala', render: (item) => item.roomName ?? '—' },
    {
      key: 'schedule',
      header: 'Horario',
      render: (item) =>
        item.startsAt ? (
          <time dateTime={item.startsAt}>
            {formatBogota(item.startsAt)} – {formatBogota(item.endsAt)}
          </time>
        ) : (
          'Sin horario'
        ),
    },
    {
      key: 'status',
      header: 'Estado',
      render: (item) =>
        isStatusKind(item.status) ? <StatusBadge status={item.status} /> : item.status,
    },
    { key: 'total', header: 'Total', render: (item) => (item.total === null ? '—' : formatCop(item.total)) },
    {
      key: 'actions',
      header: 'Detalle',
      // Se guarda la URL actual para que "Volver" conserve filtros y página.
      render: (item) => (
        <Link
          to={{ pathname: `/admin/reserva/${item.id}` }}
          state={{ from: searchParams.toString() }}
        >
          Ver reserva {item.id}
        </Link>
      ),
    },
  ];

  return (
    <AdminGate session={session} title="Administración">
      <Card title="Filtros">
        <div className="filters">
          <Select
            label="Filtrar por estado"
            value={status}
            onChange={(event) => applyFilter('status', event.target.value)}
          >
            <option value="">Todos los estados</option>
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          <Select
            label="Filtrar por sala"
            value={room}
            onChange={(event) => applyFilter('room', event.target.value)}
          >
            <option value="">Todas las salas</option>
            {rooms.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </Select>
          {hasFilters && (
            <div className="filters__actions">
              <Button variant="secondary" onClick={clearFilters}>
                Limpiar filtros
              </Button>
            </div>
          )}
        </div>
      </Card>

      <Card title="Reservas">
        {error ? (
          <ErrorState message={error} onRetry={() => setReloadKey((key) => key + 1)} />
        ) : loading || !data ? (
          <LoadingState label="Cargando reservas…" />
        ) : data.total === 0 && hasFilters ? (
          <EmptyState
            title="Sin resultados para este filtro"
            description="Ninguna reserva coincide con los filtros seleccionados."
            action={
              <Button variant="secondary" onClick={clearFilters}>
                Limpiar filtros
              </Button>
            }
          />
        ) : data.total === 0 ? (
          <EmptyState
            title="Aún no hay reservas"
            description="Cuando alguien cotice y reserve, aparecerá aquí."
            action={
              <Link className="btn btn--secondary" to="/reserva">
                Ir al cotizador
              </Link>
            }
          />
        ) : (
          <>
            <Table
              caption={`Reservas (página ${data.page} de ${Math.max(1, data.totalPages)}, ${data.total} en total)`}
              columns={columns}
              rows={data.items}
              rowKey={(item) => item.id}
            />

            {data.totalPages > 1 && (
              <nav className="pagination" aria-label="Paginación de reservas">
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
      </Card>
    </AdminGate>
  );
}
