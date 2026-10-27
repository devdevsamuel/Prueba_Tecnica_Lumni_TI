import './DateBadge.css';

interface DateBadgeProps {
  readonly date: string; // YYYY-MM-DD
  readonly showWeekday?: boolean;
}

export function DateBadge({ date, showWeekday = true }: DateBadgeProps) {
  const d = new Date(`${date}T00:00:00`);
  const month = d.toLocaleDateString('es-CO', { month: 'short' }).replace('.', '').toUpperCase();
  const day = d.getDate().toString().padStart(2, '0');
  const weekday = d.toLocaleDateString('es-CO', { weekday: 'long' });
  const fullDate = d.toLocaleDateString('es-CO', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  return (
    <time className="date-badge" dateTime={date} aria-label={fullDate}>
      <span className="date-badge__month">{month}</span>
      <span className="date-badge__day">{day}</span>
      {showWeekday && <span className="date-badge__weekday">{weekday}</span>}
    </time>
  );
}
