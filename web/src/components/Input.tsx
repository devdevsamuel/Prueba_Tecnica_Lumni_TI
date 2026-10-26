import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

/**
 * Campos de formulario con label visible y estado de error accesible
 * (docs/05 §3): `aria-invalid` + `aria-describedby` apuntando al mensaje.
 * El label es texto real, nunca placeholder.
 */
interface FieldShellProps {
  readonly label: string;
  readonly htmlFor: string;
  readonly describedBy: string | undefined;
  readonly invalid: boolean;
  readonly error?: string;
  readonly children: ReactNode;
}

function FieldShell({ label, htmlFor, describedBy, invalid, error, children }: FieldShellProps) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error && (
        <p className="field__error" id={describedBy}>
          {error}
        </p>
      )}
    </div>
  );
}

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  readonly label: string;
  readonly error?: string;
};

export function Input({ label, error, id, ...rest }: InputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const errorId = `${inputId}-error`;
  return (
    <FieldShell
      label={label}
      htmlFor={inputId}
      describedBy={error ? errorId : undefined}
      invalid={Boolean(error)}
      error={error}
    >
      <input
        id={inputId}
        className="field__control"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        {...rest}
      />
    </FieldShell>
  );
}

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  readonly label: string;
  readonly error?: string;
  readonly children: ReactNode;
};

export function Select({ label, error, id, children, ...rest }: SelectProps) {
  const generatedId = useId();
  const selectId = id ?? generatedId;
  const errorId = `${selectId}-error`;
  return (
    <FieldShell
      label={label}
      htmlFor={selectId}
      describedBy={error ? errorId : undefined}
      invalid={Boolean(error)}
      error={error}
    >
      <select
        id={selectId}
        className="field__control"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        {...rest}
      >
        {children}
      </select>
    </FieldShell>
  );
}

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  readonly label: string;
  readonly error?: string;
};

export function Textarea({ label, error, id, ...rest }: TextareaProps) {
  const generatedId = useId();
  const textareaId = id ?? generatedId;
  const errorId = `${textareaId}-error`;
  return (
    <FieldShell
      label={label}
      htmlFor={textareaId}
      describedBy={error ? errorId : undefined}
      invalid={Boolean(error)}
      error={error}
    >
      <textarea
        id={textareaId}
        className="field__control"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        {...rest}
      />
    </FieldShell>
  );
}
