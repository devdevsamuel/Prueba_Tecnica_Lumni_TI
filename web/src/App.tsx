import { NavLink, Route, Routes } from 'react-router-dom';
import { AdminPage } from './pages/AdminPage';
import { AdminBookingPage } from './pages/AdminBookingPage';
import { AdminEmailsPage } from './pages/AdminEmailsPage';
import { AdminEmailDetailPage } from './pages/AdminEmailDetailPage';
import { AdminChatPage } from './pages/AdminChatPage';
import { BookingWizardPage } from './pages/BookingWizardPage';
import { ChatPage } from './pages/ChatPage';
import { QuotePage } from './pages/QuotePage';

/**
 * Layout semántico (docs/05 §1): skip-link, header/nav/main/footer,
 * un <h1> por página (sin saltos de jerarquía) y aria-current="page"
 * en el enlace activo (lo aporta NavLink).
 */
const NAV_ITEMS = [
  { to: '/', label: 'Cotizador', end: true },
  { to: '/reserva', label: 'Reservar', end: false },
  { to: '/admin', label: 'Administración', end: false },
  { to: '/chat', label: 'Asistente', end: false },
] as const;

export function App() {
  return (
    <>
      <a className="skip-link" href="#contenido">
        Saltar al contenido
      </a>
      <header className="app-header">
        <div className="app-header__inner">
          <NavLink to="/" className="app-brand">
            Coworking · Reserva de salas
          </NavLink>
          <nav className="app-nav" aria-label="Principal">
            <ul>
              {NAV_ITEMS.map((item) => (
                <li key={item.to}>
                  <NavLink to={item.to} end={item.end} className="nav-link">
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </header>
      <main className="app-main" id="contenido">
        <Routes>
          <Route path="/" element={<QuotePage />} />
          <Route path="/reserva" element={<BookingWizardPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/admin/reserva/:id" element={<AdminBookingPage />} />
          <Route path="/admin/correos" element={<AdminEmailsPage />} />
          <Route path="/admin/correos/:id" element={<AdminEmailDetailPage />} />
          <Route path="/admin/asistente" element={<AdminChatPage />} />
          <Route path="/chat" element={<ChatPage />} />
        </Routes>
      </main>
      <footer className="app-footer">
        <div className="app-footer__inner">
          <p>Prueba técnica Lumni TI · Reserva de salas de coworking</p>
        </div>
      </footer>
    </>
  );
}
