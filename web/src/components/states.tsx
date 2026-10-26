import type { ReactNode } from 'react';
import { Button } from './Button';

/**
 * Estados de interfaz (docs/06 §3): patrones únicos reutilizados por todas
 * las pantallas. El error es texto plano + botón Reintentar, con `role="alert"`.
 */
export interface EmptyStateProps {
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="state">
      <h3 className="state__title">{title}</h3>
      {description && <p className="state__description">{description}</p>}
      {action}
    </div>
  );
}

export interface LoadingStateProps {
  readonly label?: string;
}

export function LoadingState({ label = 'Cargando…' }: LoadingStateProps) {
  return (
    <div className="state" role="status">
      <span className="state__spinner" aria-hidden="true" />
      <p className="state__description">{label}</p>
    </div>
  );
}

export interface ErrorStateProps {
  readonly message: string;
  readonly onRetry?: () => void;
}

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div className="state state--error" role="alert">
      <h3 className="state__title">Algo salió mal</h3>
      <p className="state__description">{message}</p>
      {onRetry && (
        <Button variant="secondary" onClick={onRetry}>
          Reintentar
        </Button>
      )}
    </div>
  );
}
