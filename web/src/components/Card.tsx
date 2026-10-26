import type { ReactNode } from 'react';

/** Card: contenedor con borde 1 px + sombra tenue (docs/06 §5). */
export interface CardProps {
  readonly title?: string;
  readonly children: ReactNode;
  readonly className?: string;
}

export function Card({ title, children, className }: CardProps) {
  const classes = ['card', className].filter(Boolean).join(' ');
  return (
    <section className={classes}>
      {title && <h2 className="card__title">{title}</h2>}
      {children}
    </section>
  );
}
