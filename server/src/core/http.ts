import type { Response } from 'express';

/**
 * Respuestas de error del API (contrato docs/01 §5):
 * `{ error: { code, message, details? } }`. Un único punto para no repetir
 * la forma en cada ruta.
 */
export interface ApiErrorDetail {
  readonly field: string;
  readonly message: string;
}

export function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: readonly ApiErrorDetail[],
): void {
  res.status(status).json({
    error: {
      code,
      message,
      ...(details && details.length > 0 ? { details } : {}),
    },
  });
}
