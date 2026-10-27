import type { CSSProperties } from 'react';

/**
 * Esqueleto de carga (docs/06 §3). Ocupa un alto parecido al contenido real
 * para que, al llegar los datos, el contenedor no salte. Es decorativo
 * (`aria-hidden`) y el estado se anuncia una sola vez con `role="status"`.
 */
export type SkeletonVariant = 'text' | 'fields' | 'table' | 'card' | 'bubble' | 'stats';

export interface SkeletonProps {
  readonly variant?: SkeletonVariant;
  readonly rows?: number;
  readonly columns?: number;
  readonly label?: string;
}

function bars(count: number, widths: readonly string[]) {
  return Array.from({ length: count }, (_, index) => (
    <span
      key={index}
      className={`skeleton__bar ${widths[index % widths.length] ?? ''}`}
      aria-hidden="true"
    />
  ));
}

export function Skeleton({
  variant = 'text',
  rows = 3,
  columns = 5,
  label = 'Cargando…',
}: SkeletonProps) {
  const body = (() => {
    switch (variant) {
      case 'fields':
        return Array.from({ length: rows }, (_, index) => (
          <div className="skeleton__field" key={index} aria-hidden="true">
            <span className="skeleton__bar skeleton__bar--short" />
            <span className="skeleton__block" />
          </div>
        ));
      case 'table':
        return (
          <div
            className="skeleton__table"
            style={{ '--skeleton-columns': columns } as CSSProperties}
            aria-hidden="true"
          >
            <div className="skeleton__table-row">
              {Array.from({ length: columns }, (_, index) => (
                <span className="skeleton__bar skeleton__bar--medium" key={index} />
              ))}
            </div>
            {Array.from({ length: rows }, (_, rowIndex) => (
              <div className="skeleton__table-row" key={rowIndex}>
                {Array.from({ length: columns }, (_, columnIndex) => (
                  <span className="skeleton__bar" key={columnIndex} />
                ))}
              </div>
            ))}
          </div>
        );
      case 'card':
        return (
          <div
            aria-hidden="true"
            style={{ display: 'grid', gap: 'var(--space-3)' }}
          >
            {bars(rows, ['', 'skeleton__bar--medium', 'skeleton__bar--short'])}
            <span className="skeleton__block" style={{ height: 120 }} />
          </div>
        );
      case 'bubble':
        return (
          <div aria-hidden="true" style={{ display: 'grid', gap: 'var(--space-3)' }}>
            {Array.from({ length: rows }, (_, index) => (
              <span
                key={index}
                className={`skeleton__bubble${index % 2 === 1 ? ' skeleton__bubble--right' : ''}`}
              />
            ))}
          </div>
        );
      case 'stats':
        return (
          <div className="skeleton__stats" aria-hidden="true">
            {Array.from({ length: rows }, (_, index) => (
              <span className="skeleton__stat" key={index} />
            ))}
          </div>
        );
      case 'text':
      default:
        return <div aria-hidden="true">{bars(rows, ['', 'skeleton__bar--medium', 'skeleton__bar--short'])}</div>;
    }
  })();

  return (
    <div className="skeleton" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      {body}
    </div>
  );
}
