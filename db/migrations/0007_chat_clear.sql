-- 0007_chat_clear.sql — limpiar el historial visible sin perder trazabilidad (Fase 5/5b).
--
-- "Limpiar" NO borra los mensajes: marca la conversación con `cleared_at` y la
-- lectura del chat solo muestra lo posterior. Así se conservan los límites por
-- sesión, el presupuesto mensual y el `usage` que audita el admin (docs/03 §6.3).
ALTER TABLE chat_sessions
  ADD COLUMN cleared_at timestamptz;
