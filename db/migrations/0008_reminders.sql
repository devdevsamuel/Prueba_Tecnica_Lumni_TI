-- 0008_reminders.sql — recordatorio de reserva 48 h antes (extensión posterior).
--
-- Decisión (docs/03 §9): NO se usa Redis/Sidekiq/BullMQ. El recordatorio es otra
-- fila del MISMO outbox transaccional:
--   · kind = 'reminder_2d' → UNIQUE (booking_id, kind) garantiza un solo
--     recordatorio por reserva, aunque el scheduler corra varias veces.
--   · status = 'skipped' → deja auditoría cuando la reserva se cancela o ya
--     empezó antes de que el worker la envíe.
--   · El scheduler solo inserta; el worker existente sigue siendo el único que
--     envía, reintenta y aplica backoff por fila.
ALTER TABLE email_outbox DROP CONSTRAINT email_outbox_kind_check;
ALTER TABLE email_outbox ADD CONSTRAINT email_outbox_kind_check
  CHECK (kind IN ('confirmation', 'reminder_2d'));

ALTER TABLE email_outbox DROP CONSTRAINT email_outbox_status_check;
ALTER TABLE email_outbox ADD CONSTRAINT email_outbox_status_check
  CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped'));

-- El scheduler filtra por estado e inicio; este índice evita escanear toda la
-- tabla de reservas en cada tick.
CREATE INDEX bookings_status_starts_at_idx ON bookings (status, starts_at);
