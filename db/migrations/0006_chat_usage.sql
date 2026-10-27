-- 0006_chat_usage.sql — trazabilidad de consumo del asistente (Fase 5b).
--
-- El `usage` que devuelve el proveedor de IA se guarda POR MENSAJE para poder
-- (a) mostrar el consumo real en el panel de admin y (b) aplicar el presupuesto
-- mensual con un `SUM` sobre la propia BD, sin estado externo.
-- `completion_tokens` YA INCLUYE los de razonamiento (convención OpenAI); estos
-- se guardan aparte solo para trazabilidad (no se suman dos veces).
-- `model` es NULL en mensajes de usuario (no consumen por sí solos).
ALTER TABLE chat_messages
  ADD COLUMN prompt_tokens     integer NOT NULL DEFAULT 0,
  ADD COLUMN completion_tokens integer NOT NULL DEFAULT 0,
  ADD COLUMN reasoning_tokens  integer NOT NULL DEFAULT 0,
  ADD COLUMN cost_usd          numeric(12,6) NOT NULL DEFAULT 0,
  ADD COLUMN model             text;
