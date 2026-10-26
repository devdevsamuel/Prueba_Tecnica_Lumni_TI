import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiGet, apiPost } from './api';

/**
 * Sesión en el front (Fase 3): login, lectura de la sesión actual y logout.
 * Único punto de red para `/api/auth/*` (docs/03 §7 S).
 */
export interface SessionUser {
  readonly id: number;
  readonly email: string;
  readonly fullName: string;
  readonly role: 'client' | 'admin';
}

/** Devuelve el usuario de la sesión actual, o `null` si no hay (401). */
export async function fetchSession(): Promise<SessionUser | null> {
  try {
    const data = await apiGet<{ user: SessionUser }>('/api/auth/me');
    return data.user;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return null;
    throw error;
  }
}

export function loginRequest(email: string, password: string): Promise<{ user: SessionUser }> {
  return apiPost<{ user: SessionUser }>('/api/auth/login', { email, password });
}

export function logoutRequest(): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>('/api/auth/logout', {});
}

export interface SessionState {
  readonly user: SessionUser | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly reload: () => void;
}

/** Carga la sesión al montar y la recarga tras login/logout. */
export function useSession(): SessionState {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchSession()
      .then((session) => {
        if (!cancelled) setUser(session);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setUser(null);
        setError(cause instanceof ApiError ? cause.message : 'No se pudo comprobar la sesión.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => reload(), [reload]);

  return { user, loading, error, reload };
}
