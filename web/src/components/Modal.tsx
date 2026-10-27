import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Modal con trampa de foco, cierre con **Esc** y devolución del foco al
 * disparador (docs/05 §2, docs/06 §5). `role="dialog"` + `aria-modal` y el
 * título enlazado con `aria-labelledby`.
 */
export interface ModalProps {
  readonly title: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ title, open, onClose, children, footer }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  /**
   * `onClose` puede cambiar en cada render (por ejemplo, al pasar un inline
   * al modal). Guardamos la última versión en una ref para que el listener de
   * teclado no se reinicie ni capture el foco al escribir en los campos.
   */
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const handleClose = useCallback((): void => {
    onCloseRef.current();
  }, []);

  useEffect(() => {
    if (!open) return undefined;

    // Se guarda quién abrió para devolverle el foco al cerrar.
    openerRef.current = document.activeElement as HTMLElement | null;

    const dialog = dialogRef.current;
    const firstFocusable = dialog?.querySelector<HTMLElement>(FOCUSABLE);
    (firstFocusable ?? dialog)?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        handleClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const node = dialogRef.current;
      if (!node) return;
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.offsetParent !== null,
      );
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0] as HTMLElement;
      const last = items[items.length - 1] as HTMLElement;
      const active = document.activeElement;

      // El Tab nunca sale del diálogo: del último vuelve al primero y viceversa.
      if (event.shiftKey && (active === first || active === node)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown, true);

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.body.style.overflow = previousOverflow;
      openerRef.current?.focus();
    };
  }, [open, handleClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) handleClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        tabIndex={-1}
      >
        <div className="modal__header">
          <h2 className="modal__title" id={titleId}>
            {title}
          </h2>
          <button type="button" className="modal__close" onClick={handleClose} aria-label="Cerrar diálogo">
            <span aria-hidden="true">✕</span>
          </button>
        </div>
        <div className="modal__body">{children}</div>
        {footer && <div className="modal__footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
