-- 0002_drafts.sql — permite borradores a medio guardar (docs/01 §2.2).
--
-- "Cada paso se guarda como borrador" y el usuario puede entrar en el wizard
-- sin cotización previa (enlace "Reservar"), así que al inicio no hay sala ni
-- horario, y el paso 1 todavía no aportó los datos del cliente. Esos campos
-- pasan a ser obligatorios solo al CONFIRMAR (se validan en el servicio).
--
-- Ojo con el constraint de exclusión: usa WHERE (status = 'confirmed'), y toda
-- reserva confirmada tiene sala y horario rellenados por el servicio, así que
-- el índice nunca ve valores nulos. `CHECK (ends_at > starts_at)` evalúa a NULL
-- (no a FALSE) cuando faltan valores → no bloquea un borrador incompleto.
ALTER TABLE bookings
  ALTER COLUMN customer_name  DROP NOT NULL,
  ALTER COLUMN customer_email DROP NOT NULL,
  ALTER COLUMN room_id        DROP NOT NULL,
  ALTER COLUMN starts_at      DROP NOT NULL,
  ALTER COLUMN ends_at        DROP NOT NULL;
