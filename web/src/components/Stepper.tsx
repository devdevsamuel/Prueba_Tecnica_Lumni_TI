/**
 * Stepper de N pasos como `<ol>` con `aria-current="step"` (docs/05 §1, §6).
 * Solo pinta el progreso: la lógica del wizard llega en la Fase 2.
 */
export interface StepperProps {
  readonly steps: readonly string[];
  /** Índice (base 0) del paso activo. */
  readonly currentStep: number;
  readonly label?: string;
}

export function Stepper({ steps, currentStep, label = 'Progreso' }: StepperProps) {
  return (
    <ol className="stepper" aria-label={label}>
      {steps.map((step, index) => {
        const state = index < currentStep ? 'completed' : index === currentStep ? 'active' : 'pending';
        return (
          <li
            key={step}
            className={`stepper__item stepper__item--${state}`}
            aria-current={state === 'active' ? 'step' : undefined}
          >
            <span className="stepper__number" aria-hidden="true">
              {index + 1}
            </span>
            {step}
          </li>
        );
      })}
    </ol>
  );
}
