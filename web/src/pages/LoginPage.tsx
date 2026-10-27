import { useState, type FormEvent } from 'react';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Collapse } from '../components/Collapse';
import { Input } from '../components/Input';
import { ApiError } from '../lib/api';
import { loginRequest, type SessionUser } from '../lib/auth';

/**
 * Pantalla de login (Fase 3). Validación de formato/presencia en el cliente;
 * las credenciales las decide el servidor (401 con mensaje único, sin revelar
 * si la cuenta existe).
 */
export interface LoginPageProps {
  readonly onLoggedIn: (user: SessionUser) => void;
}

function validate(email: string, password: string): { email?: string; password?: string } {
  const errors: { email?: string; password?: string } = {};
  if (!email.trim()) errors.email = 'Escribe tu correo.';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errors.email = 'Escribe un correo válido.';
  if (!password) errors.password = 'Escribe tu contraseña.';
  return errors;
}

export function LoginPage({ onLoggedIn }: LoginPageProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState<{ email?: boolean; password?: boolean }>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const errors = validate(email, password);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setTouched({ email: true, password: true });
    if (errors.email || errors.password) return;

    setSubmitting(true);
    setError(null);
    try {
      const { user } = await loginRequest(email.trim(), password);
      onLoggedIn(user);
    } catch (cause: unknown) {
      // El servidor responde 401 con un mensaje único: se conserva lo escrito.
      setError(
        cause instanceof ApiError
          ? cause.message
          : 'No se pudo iniciar sesión. Comprueba tu conexión.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card title="Iniciar sesión">
      <p className="page-intro">
        Accede con tu cuenta para ver y gestionar las reservas del coworking.
      </p>

      <Collapse open={Boolean(error)}>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
      </Collapse>

      <form onSubmit={handleSubmit} noValidate>
        <Input
          label="Correo electrónico"
          type="email"
          value={email}
          autoComplete="username"
          error={touched.email ? errors.email : undefined}
          onBlur={() => setTouched((state) => ({ ...state, email: true }))}
          onChange={(event) => setEmail(event.target.value)}
        />
        <Input
          label="Contraseña"
          type="password"
          value={password}
          autoComplete="current-password"
          error={touched.password ? errors.password : undefined}
          onBlur={() => setTouched((state) => ({ ...state, password: true }))}
          onChange={(event) => setPassword(event.target.value)}
        />
        <div className="form-actions">
          <Button type="submit" variant="primary" loading={submitting}>
            Entrar
          </Button>
        </div>
      </form>
    </Card>
  );
}
