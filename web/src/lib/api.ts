/**
 * Cliente de red tipado: único punto de `fetch` del front (docs/03 §7 S).
 * Las páginas NUNCA hacen fetch directo: pasan por aquí.
 * Errores en el contrato `{ error: { code, message } }` de docs/01 §5.
 */
export interface ApiErrorBody {
  error: { code: string; message: string };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    });
  } catch {
    throw new ApiError(0, 'network_error', 'No hay conexión con el servidor. Reintenta en unos segundos.');
  }
  if (!response.ok) {
    let body: ApiErrorBody | undefined;
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      body = undefined;
    }
    throw new ApiError(
      response.status,
      body?.error?.code ?? 'unknown',
      body?.error?.message ?? `Error del servidor (${response.status}).`,
    );
  }
  return (await response.json()) as T;
}

export function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { method: 'GET', signal });
}

export function apiPost<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body), signal });
}
