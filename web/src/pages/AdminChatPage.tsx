import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AdminGate } from '../components/AdminGate';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Table, type Column } from '../components/Table';
import { Skeleton } from '../components/Skeleton';
import { EmptyState, ErrorState } from '../components/states';
import { ApiError } from '../lib/api';
import { fetchChatUsage, type ChatUsageItem, type ChatUsageResponse } from '../lib/admin';
import { formatBogotaFull } from '../lib/datetime';
import { useSession } from '../lib/auth';

/**
 * Trazabilidad del asistente (Fase 5b, docs/04 §7): cuánto consume el chat y en
 * qué. Es la pestaña que permite vigilar la cuota del proveedor sin entrar a la
 * base de datos.
 *
 * `completionTokens` **ya incluye** `reasoningTokens` (el proveedor los cuenta
 * ahí); se muestran por separado para ver el gasto de razonamiento, no se suman.
 */

const PAGE_SIZE = 20;

const NUMBER = new Intl.NumberFormat('es-CO');
const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

function percent(used: number, budget: number): number {
  if (budget <= 0) return 0;
  return Math.min(100, Math.round((used / budget) * 100));
}

export function AdminChatPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const session = useSession();

  const [data, setData] = useState<ChatUsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1);
  const isAdmin = session.user?.role === 'admin';

  useEffect(() => {
    if (!isAdmin) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchChatUsage(page, PAGE_SIZE, controller.signal)
      .then(setData)
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof ApiError ? cause.message : 'No se pudo cargar la trazabilidad.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [isAdmin, page, reloadKey]);

  // Una página fuera de rango vuelve a la última real (el total ya es global).
  useEffect(() => {
    if (data && data.totalPages > 0 && page > data.totalPages) {
      applyPage(data.totalPages);
    }
  }, [data, page]);

  function applyPage(value: number): void {
    const next = new URLSearchParams(searchParams);
    if (value > 1) next.set('page', String(value));
    else next.delete('page');
    setSearchParams(next);
  }

  const summary = data?.summary;
  const usedPercent = summary?.monthBudget ? percent(summary.monthTokens, summary.monthBudget) : null;
  const initialLoading = loading && data === null;
  const refreshing = loading && data !== null;

  const columns: Column<ChatUsageItem>[] = [
    {
      key: 'createdAt',
      header: 'Fecha',
      render: (item) => <time dateTime={item.createdAt}>{formatBogotaFull(item.createdAt)}</time>,
    },
    {
      key: 'session',
      header: 'Conversación',
      render: (item) => (
        <code title={item.sessionId}>{item.sessionId.slice(0, 8)}</code>
      ),
    },
    {
      key: 'role',
      header: 'Turno',
      render: (item) => (item.role === 'assistant' ? 'Asistente' : 'Usuario'),
    },
    {
      key: 'prompt',
      header: 'Entrada',
      render: (item) => NUMBER.format(item.promptTokens),
    },
    {
      key: 'completion',
      header: 'Salida',
      render: (item) => NUMBER.format(item.completionTokens),
    },
    {
      key: 'reasoning',
      header: 'Razonamiento',
      render: (item) => NUMBER.format(item.reasoningTokens),
    },
    {
      key: 'cost',
      header: 'Coste',
      render: (item) => USD.format(item.costUsd),
    },
    {
      key: 'model',
      header: 'Modelo',
      render: (item) => item.model ?? '—',
    },
    {
      key: 'preview',
      header: 'Vista previa',
      render: (item) => <span className="usage-preview">{item.preview}</span>,
    },
  ];

  return (
    <AdminGate
      session={session}
      title="Asistente"
      intro="Consumo del chat con IA (tokens, coste y modelo) para vigilar la cuota"
    >
      {error ? (
        <Card>
          <ErrorState message={error} onRetry={() => setReloadKey((key) => key + 1)} />
        </Card>
      ) : (
        <>
          <Card title="Resumen">
            {initialLoading || !summary ? (
              <Skeleton variant="stats" rows={6} label="Cargando el consumo…" />
            ) : (
              <div className={refreshing ? 'is-refreshing' : undefined} aria-busy={refreshing || undefined}>
                <dl className="usage-grid">
                  <div className="usage-stat">
                    <dt>Entrada</dt>
                    <dd>{NUMBER.format(summary.promptTokens)}</dd>
                  </div>
                  <div className="usage-stat">
                    <dt>Salida</dt>
                    <dd>{NUMBER.format(summary.completionTokens)}</dd>
                  </div>
                  <div className="usage-stat">
                    <dt>Razonamiento</dt>
                    <dd>{NUMBER.format(summary.reasoningTokens)}</dd>
                  </div>
                  <div className="usage-stat">
                    <dt>Coste acumulado</dt>
                    <dd>{USD.format(summary.costUsd)}</dd>
                  </div>
                  <div className="usage-stat">
                    <dt>Turnos</dt>
                    <dd>{NUMBER.format(summary.turns)}</dd>
                  </div>
                  <div className="usage-stat">
                    <dt>Conversaciones</dt>
                    <dd>{NUMBER.format(summary.sessions)}</dd>
                  </div>
                </dl>

                <div className="usage-month">
                  <p>
                    <strong>Mes en curso:</strong> {NUMBER.format(summary.monthTokens)} tokens de
                    entrada + salida
                    {summary.monthBudget === null
                      ? ' · sin presupuesto configurado'
                      : ` · presupuesto ${NUMBER.format(summary.monthBudget)} (${usedPercent} %)`}
                  </p>
                  {summary.monthBudget !== null && (
                    <progress
                      className="usage-progress"
                      value={summary.monthTokens}
                      max={summary.monthBudget}
                      aria-label={`Presupuesto mensual usado: ${usedPercent} %`}
                    />
                  )}
                  <p className="usage-note">
                    Modelo: <code>{summary.model}</code> · la salida ya incluye el razonamiento.
                  </p>
                </div>
              </div>
            )}
          </Card>

          <Card title="Mensajes">
            {initialLoading || !data ? (
              <Skeleton variant="table" rows={PAGE_SIZE} columns={columns.length} label="Cargando los mensajes…" />
            ) : (
              <>
                {refreshing && <div className="refresh-bar" role="status" aria-label="Actualizando la trazabilidad" />}
                <div className={refreshing ? 'is-refreshing' : undefined} aria-busy={refreshing || undefined}>
                  {data.total === 0 ? (
                    <EmptyState
                      title="Todavía no hay conversaciones"
                      description="El consumo aparece aquí en cuanto un cliente escribe al asistente."
                    />
                  ) : (
                    <>
                      <Table
                        caption={`Consumo por mensaje (página ${data.page} de ${Math.max(1, data.totalPages)}, ${data.total} en total)`}
                        columns={columns}
                        rows={data.items}
                        rowKey={(item) => item.id}
                      />

                      {data.totalPages > 1 && (
                        <nav className="pagination" aria-label="Paginación de la trazabilidad">
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
        </>
      )}
    </AdminGate>
  );
}
