import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { Button } from './Button';
import { Card } from './Card';
import { EmptyState, ErrorState, LoadingState } from './states';
import { LoginPage } from '../pages/LoginPage';
import { logoutRequest, type SessionState } from '../lib/auth';

/**
 * Puerta de administración (catálogo `06` §5): concentra los 4 estados de la
 * sesión (cargando · error · sin sesión → login · sin rol → 403) y la cabecera
 * con las pestañas del panel, para que las pantallas del admin solo pinten su
 * contenido. Recibe la sesión ya cargada por la página (un solo `GET /me`).
 */
export interface AdminGateProps {
  readonly session: SessionState;
  readonly title: string;
  readonly intro?: string;
  readonly children: ReactNode;
}

const TABS = [
  { to: '/admin', label: 'Reservas', end: true },
  { to: '/admin/correos', label: 'Correos', end: true },
  { to: '/admin/asistente', label: 'Asistente', end: true },
] as const;

export function AdminGate({ session, title, intro, children }: AdminGateProps) {
  const user = session.user;
  const isAdmin = user?.role === 'admin';
  // Quién hay dentro es contexto útil en todo el panel; una página puede pasar
  // su propio `intro` para sobrescribirlo.
  const subtitle = intro ?? (user ? `Sesión de ${user.fullName} · ${user.email}` : undefined);

  const header = (extra?: ReactNode): ReactNode => (
    <div className="admin-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="page-intro">{subtitle}</p>}
      </div>
      <div className="admin-head__actions">
        <nav className="admin-tabs" aria-label="Secciones de administración">
          <ul>
            {TABS.map((tab) => (
              <li key={tab.to}>
                <NavLink to={tab.to} end={tab.end} className="admin-tab">
                  {tab.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        {extra}
      </div>
    </div>
  );

  if (session.loading) {
    return (
      <div className="stack-lg">
        {header()}
        <Card>
          <LoadingState label="Comprobando la sesión…" />
        </Card>
      </div>
    );
  }

  if (session.error) {
    return (
      <div className="stack-lg">
        {header()}
        <Card>
          <ErrorState message={session.error} onRetry={session.reload} />
        </Card>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="stack-lg">
        <div>
          <h1>{title}</h1>
          <p className="page-intro">Área reservada al equipo del coworking.</p>
        </div>
        <LoginPage onLoggedIn={() => session.reload()} />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="stack-lg">
        {header()}
        <Card>
          <EmptyState
            title="Tu cuenta no tiene acceso"
            description={`La sesión de ${user.email} es de cliente. El panel es solo para administradores.`}
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  void logoutRequest().then(() => session.reload());
                }}
              >
                Cerrar sesión
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="stack-lg">
      {header(
        <Button
          variant="secondary"
          onClick={() => {
            void logoutRequest().then(() => session.reload());
          }}
        >
          Cerrar sesión
        </Button>,
      )}
      {children}
    </div>
  );
}
