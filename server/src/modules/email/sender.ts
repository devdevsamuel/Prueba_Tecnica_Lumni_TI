/**
 * Transporte de correo (Parte 2.1). Interfaz estrecha para poder sustituir la
 * implementación sin tocar el worker ni la bandeja (open/closed, docs/02 §2):
 * `DbEmailSender` captura en local, un futuro `SmtpEmailSender` solo cambiaría
 * esta clase.
 */
export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}

export type SendResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

export interface EmailSender {
  send(message: EmailMessage): Promise<SendResult>;
}

/**
 * Captura local: **nada sale de la máquina**. El correo ya queda visible en
 * `email_outbox` (asunto, cuerpo, destinatario vía la reserva y timestamps),
 * que es lo que la vista de administración enseña.
 *
 * Los tests de fallo inyectan su propio doble (inyección de dependencias,
 * docs/03 §7-D), así que esta clase no necesita modo "fallar".
 */
export class DbEmailSender implements EmailSender {
  async send(message: EmailMessage): Promise<SendResult> {
    if (!message.to.trim()) return { ok: false, error: 'Sin destinatario.' };
    if (!message.subject.trim()) return { ok: false, error: 'Sin asunto.' };
    if (!message.body.trim()) return { ok: false, error: 'Sin cuerpo.' };
    return { ok: true };
  }
}
