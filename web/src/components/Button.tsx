import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * Button con variantes y estado de carga (docs/06 §5).
 * `loading` no deshabilita el botón (docs/05 §3): sigue enfocable y anuncia
 * con `aria-busy`, evitando el "deshabilitado silencioso".
 *
 * El texto sigue en el DOM (oculto con opacidad) y el spinner se superpone:
 * el ancho no cambia y el nombre accesible no se convierte en "…".
 */
export type ButtonVariant = 'primary' | 'secondary' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly loading?: boolean;
  readonly children: ReactNode;
}

export function Button({ variant = 'primary', loading = false, children, className, type, ...rest }: ButtonProps) {
  const classes = ['btn', `btn--${variant}`, className].filter(Boolean).join(' ');
  return (
    <button
      type={type ?? 'button'}
      className={classes}
      aria-busy={loading || undefined}
      data-loading={loading || undefined}
      {...rest}
    >
      <span className="btn__label">{children}</span>
      {loading && <span className="btn__spinner" aria-hidden="true" />}
    </button>
  );
}
