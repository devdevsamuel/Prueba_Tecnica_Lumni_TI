import { Card } from '../components/Card';
import { EmptyState } from '../components/states';

/** Pantalla 5 — Chat con IA (docs/01 §3): esqueleto. Llega en la Fase 5. */
export function ChatPage() {
  return (
    <div className="stack-lg">
      <div>
        <h1>Asistente de reservas</h1>
        <p className="page-intro">Cuéntale al asistente qué necesitas y te guía hasta dejar la reserva lista.</p>
      </div>
      <Card title="Conversación">
        <EmptyState
          title="El asistente aún no está disponible"
          description="El chat con IA se implementa en la Fase 5 del plan."
        />
      </Card>
    </div>
  );
}
