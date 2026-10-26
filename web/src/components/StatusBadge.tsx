/**
 * Badge de estado (docs/06 §5): SIEMPRE con texto, nunca solo color
 * (docs/05 §5). Cubre los estados de reservas y de la bandeja de correos.
 */
export type StatusKind =
  | 'draft'
  | 'confirmed'
  | 'completed'
  | 'cancelled'
  | 'pending'
  | 'sending'
  | 'sent'
  | 'failed';

const STATUS_LABELS: Record<StatusKind, string> = {
  draft: 'Borrador',
  confirmed: 'Confirmada',
  completed: 'Completada',
  cancelled: 'Cancelada',
  pending: 'Pendiente',
  sending: 'Enviando',
  sent: 'Enviado',
  failed: 'Fallido',
};

export interface StatusBadgeProps {
  readonly status: StatusKind;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  return <span className={`badge badge--${status}`}>{STATUS_LABELS[status]}</span>;
}
