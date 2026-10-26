/**
 * Plantillas del correo de confirmación (Parte 2.1). Función pura: recibe los
 * datos ya congelados de la reserva y devuelve asunto y cuerpo. Sin I/O, así
 * que se testea directamente y el contenido no depende del transporte.
 */
export interface ConfirmationEmailInput {
  readonly bookingId: number;
  readonly customerName: string;
  readonly roomName: string;
  /** Fecha en Bogotá, 'YYYY-MM-DD'. */
  readonly date: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly total: number;
}

export interface RenderedEmail {
  readonly subject: string;
  readonly body: string;
}

const COP = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

export function renderConfirmation(input: ConfirmationEmailInput): RenderedEmail {
  const subject = `Reserva #${input.bookingId} confirmada · ${input.roomName} · ${input.date}`;
  const body = [
    `Hola ${input.customerName}:`,
    '',
    `Tu reserva #${input.bookingId} en ${input.roomName} está confirmada.`,
    `  Fecha:  ${input.date} de ${input.startTime} a ${input.endTime}`,
    `  Total:  ${COP.format(input.total)}`,
    '',
    'Si necesitas cambiar algo, responde a este mensaje o entra en la app.',
    '',
    'Coworking · Reserva de salas',
  ].join('\n');
  return { subject, body };
}
