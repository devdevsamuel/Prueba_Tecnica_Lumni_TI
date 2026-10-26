import { Card } from '../components/Card';
import { Stepper } from '../components/Stepper';
import { EmptyState } from '../components/states';

/**
 * Pantalla 2 — Reserva por pasos (docs/01 §3): esqueleto con el Stepper real
 * (3 pasos del enunciado). La máquina de estados y el CRUD llegan en la Fase 2.
 */
const STEPS = ['Datos del cliente', 'Sala y horario', 'Servicios adicionales'] as const;

export function BookingWizardPage() {
  return (
    <div className="stack-lg">
      <div>
        <h1>Reserva por pasos</h1>
        <p className="page-intro">
          Tres pasos: tus datos, la sala y horario elegidos, y los servicios adicionales.
        </p>
      </div>
      <Card title="Nueva reserva">
        <Stepper steps={STEPS} currentStep={0} label="Progreso de la reserva" />
        <EmptyState
          title="Paso 1 de 3: datos del cliente"
          description="Esta pantalla se completa en la Fase 2 del plan."
        />
      </Card>
    </div>
  );
}
