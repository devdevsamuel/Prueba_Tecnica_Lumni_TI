import { Card } from '../components/Card';
import { Input, Select } from '../components/Input';

/**
 * Pantalla 1 — Cotizador (docs/01 §3): solo el esqueleto visual con markup
 * estático (docs/04 §10). La lógica, validación inline y fetch llegan en la Fase 1.
 */
export function QuotePage() {
  return (
    <div className="stack-lg">
      <div>
        <h1>Cotizador de salas</h1>
        <p className="page-intro">
          Elige sala, fecha, hora y duración para ver el desglose y la disponibilidad.
        </p>
      </div>
      <Card title="Nueva cotización">
        <form onSubmit={(event) => event.preventDefault()}>
          <Select label="Sala" defaultValue="">
            <option value="" disabled>
              Selecciona una sala…
            </option>
            <option value="1">Sala Pequeña · hasta 4 personas · $40.000/h</option>
            <option value="2">Sala Mediana · hasta 8 personas · $70.000/h</option>
            <option value="3">Sala Grande · hasta 12 personas · $120.000/h</option>
          </Select>
          <Input label="Fecha" type="date" />
          <Input label="Hora de inicio" type="time" />
          <Input label="Duración (minutos)" type="number" placeholder="Ej.: 120" />
          <button className="btn btn--primary" type="submit">
            Cotizar
          </button>
        </form>
      </Card>
    </div>
  );
}
