import { Card } from '../components/Card';
import { StatusBadge } from '../components/StatusBadge';
import { Table } from '../components/Table';

/**
 * Pantalla 3 — Admin (docs/01 §3): tabla de ejemplo con datos estáticos que
 * demuestra el componente Table con todos los StatusBadge (sirve para revisar
 * contraste real de badges). Login, paginación y filtros llegan en la Fase 3.
 */
interface BookingRow {
  id: number;
  cliente: string;
  sala: string;
  horario: string;
  estado: 'confirmed' | 'draft' | 'completed' | 'cancelled';
}

const EXAMPLE_ROWS: readonly BookingRow[] = [
  { id: 101, cliente: 'Laura Gómez', sala: 'Sala Mediana', horario: 'sáb 25 oct · 09:00–13:00', estado: 'confirmed' },
  { id: 102, cliente: 'Andrés Ruiz', sala: 'Sala Pequeña', horario: 'lun 27 oct · 14:00–15:30', estado: 'draft' },
  { id: 103, cliente: 'María Pérez', sala: 'Sala Grande', horario: 'mié 22 oct · 08:00–18:00', estado: 'completed' },
  { id: 104, cliente: 'Jorge Díaz', sala: 'Sala Pequeña', horario: 'vie 24 oct · 16:00–17:00', estado: 'cancelled' },
];

const COLUMNS = [
  { key: 'id', header: 'ID', render: (row: BookingRow) => row.id },
  { key: 'cliente', header: 'Cliente', render: (row: BookingRow) => row.cliente },
  { key: 'sala', header: 'Sala', render: (row: BookingRow) => row.sala },
  { key: 'horario', header: 'Horario', render: (row: BookingRow) => row.horario },
  { key: 'estado', header: 'Estado', render: (row: BookingRow) => <StatusBadge status={row.estado} /> },
] as const;

export function AdminPage() {
  return (
    <div className="stack-lg">
      <div>
        <h1>Administración</h1>
        <p className="page-intro">Listado de reservas con paginación y filtros.</p>
      </div>
      <Card title="Reservas (datos de ejemplo)">
        <Table caption="Ejemplo del listado de reservas" columns={COLUMNS} rows={EXAMPLE_ROWS} rowKey={(row) => row.id} />
      </Card>
    </div>
  );
}
