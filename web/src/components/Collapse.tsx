import type { ReactNode } from 'react';

/**
 * Colapso de altura sin JS (docs/06 §3): los avisos aparecen y desaparecen
 * empujando el layout de forma suave en vez de "popping". Cuando está cerrado
 * el contenido queda `inert`, así no recibe foco ni se anuncia.
 */
export interface CollapseProps {
  readonly open: boolean;
  readonly children: ReactNode;
}

export function Collapse({ open, children }: CollapseProps) {
  return (
    <div className="collapse" data-open={open ? 'true' : 'false'} inert={!open}>
      <div className="collapse__inner">{children}</div>
    </div>
  );
}
