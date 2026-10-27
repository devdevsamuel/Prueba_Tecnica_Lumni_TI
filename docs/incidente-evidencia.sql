-- incidente-evidencia.sql — Anexo de evidencia de `INCIDENTE.md` (Parte 4).
--
-- ⚠️  ALCANCE: estas consultas apuntan a la tabla `reminders` del **sistema afectado**,
--     descrito en el enunciado del incidente. **No existen en el esquema de esta app**
--     (`db/migrations/`): aquí no hay tabla `reminders` — el recordatorio que sí
--     construimos vive en `email_outbox` (`kind='reminder_2d'`), sin TTL de 2 h y sin
--     ventana 8:00–18:00. Ejecutarlas contra esta base **falla**; están para que el
--     método (qué mirar y por qué) quede auditable, no para correrse aquí.
--
--     En la base del sistema afectado se asume este esquema mínimo:
--       reminders(id, booking_id, status, created_at, sent_at, ...)
--       bookings(id, status)   -- status = 'draft' | 'confirmed' | ...
--
-- Zona horaria: el reporte usa hora de Bogotá (America/Bogota). Verificar SIEMPRE
-- `SHOW timezone;` antes de comparar franjas (hipótesis H4).

-- ═══════════════════════════════════════════════════════════════════════════════════
-- BLOQUE 1 — Diagnóstico: confirmar o refutar la hipótesis
-- ═══════════════════════════════════════════════════════════════════════════════════

-- Q1 · Histograma: ¿dónde se concentran los `expired`?
-- H1 predice un escalón a partir de las 16:00 (2 h antes del cierre de las 18:00).
-- H3 (off-by-one del TTL) predice masa también de madrugada (00:00–08:00).
SELECT date_trunc('hour', created_at AT TIME ZONE 'America/Bogota') AS hora_local,
       count(*)                                                     AS caducados
  FROM reminders
 WHERE status = 'expired'
 GROUP BY 1
 ORDER BY 1;

-- Q2 · La comparación que decide: tasa de `expired` por franja.
-- Resultado esperado si H1 es correcta: control ≈ 0 %, zona de riesgo ≈ 90 %.
-- Si ambas tasas son parecidas, H1 queda refutada → buscar otra causa (H5).
SELECT CASE WHEN extract(hour FROM created_at AT TIME ZONE 'America/Bogota') BETWEEN 8 AND 15
            THEN '1 · 08:00–15:59 (control)' ELSE '2 · 16:00–17:59 (zona de riesgo)' END AS franja,
       count(*)                                                   AS total,
       count(*) FILTER (WHERE status = 'expired')                 AS caducados,
       count(*) FILTER (WHERE status = 'sent')                    AS enviados,
       round(100.0 * count(*) FILTER (WHERE status = 'expired')
             / count(*), 1)                                       AS pct_expired
  FROM reminders
 WHERE created_at >= now() - interval '14 days'
 GROUP BY 1
 ORDER BY 1;

-- Q3 · Contramuestra: lo creado a primera hora debería enviarse bien.
-- Si esto también caduca masivamente, la causa NO es la ventana de envío.
SELECT status, count(*) AS total
  FROM reminders
 WHERE extract(hour FROM created_at AT TIME ZONE 'America/Bogota') BETWEEN 8 AND 9
 GROUP BY status
 ORDER BY status;

-- Q4 · H4 — desfase de zona horaria. Si esto no coincide con America/Bogota,
-- la franja real del problema es otra y hay que recalcular el umbral (16:00).
SHOW timezone;
SELECT now()                                AS en_servidor,
       now() AT TIME ZONE 'America/Bogota'   AS en_bogota;

-- Q5 · H3 — ¿hay `expired` que nacieron ya vencidos (edad > TTL al crearse)?
-- Un `pending` que nace con más de 2 h de vida es un off-by-one en el TTL.
SELECT count(*) AS nacieron_ya_vencidos
  FROM reminders
 WHERE status = 'expired'
   AND created_at <= now() - interval '2 hours';

-- Q6 · Cuantificar el alcance: ¿cuántos clientes quedaron sin recordatorio?
-- Se une con bookings para saber cuántos seguían en 'draft' (aún les sirve).
SELECT b.status                                              AS estado_reserva,
       count(*)                                              AS recordatorios,
       count(*) FILTER (WHERE r.sent_at IS NULL)             AS nunca_enviados
  FROM reminders r
  JOIN bookings b ON b.id = r.booking_id
 WHERE r.created_at >= now() - interval '14 days'
 GROUP BY 1
 ORDER BY 1;

-- ═══════════════════════════════════════════════════════════════════════════════════
-- BLOQUE 2 — Remediación: selección de los elegibles
-- ═══════════════════════════════════════════════════════════════════════════════════

-- Q7 · Los que SÍ se deben recuperar. Las tres barreras, en una sola query:
--   · sent_at IS NULL  → nunca reenviar lo ya enviado (no duplicados)
--   · b.status='draft'  → no escribir a quien ya confirmó
--   · hora 08:00–18:00  → nunca a las 3 a. m.
SELECT r.id, r.booking_id, r.created_at, r.status, r.sent_at
  FROM reminders r
  JOIN bookings b ON b.id = r.booking_id
 WHERE r.status IN ('pending', 'expired')   -- 'expired' = caducados por este bug
   AND r.sent_at IS NULL                    -- nunca reenviar lo ya enviado
   AND b.status = 'draft'                   -- a quien ya confirmó NO se le escribe
   AND (now() AT TIME ZONE 'America/Bogota')::time BETWEEN '08:00' AND '18:00';

-- Q8 · Lo que queda FUERA, y por qué (esto también se revisa antes de ejecutar).
-- Cada categoría debe tener su motivo documentado en el acta de aprobación.
SELECT CASE
         WHEN r.sent_at IS NOT NULL                THEN '1 · ya enviado (no tocar)'
         WHEN b.status <> 'draft'                  THEN '2 · ya confirmó o canceló (no tocar)'
         WHEN r.status = 'pending'
              AND (now() AT TIME ZONE 'America/Bogota')::time
                  NOT BETWEEN '08:00' AND '18:00' THEN '3 · ventana cerrada (aplazar a la apertura)'
         ELSE '4 · elegible para recuperar'
       END                                     AS categoria,
       count(*)                                AS registros
  FROM reminders r
  JOIN bookings b ON b.id = r.booking_id
 GROUP BY 1
 ORDER BY 1;

-- ═══════════════════════════════════════════════════════════════════════════════════
-- BLOQUE 3 — Invariantes: se validan ANTES y DESPUÉS de ejecutar
-- ═══════════════════════════════════════════════════════════════════════════════════

-- Q9 · Invariante de duplicados → debe devolver 0 filas.
SELECT r.booking_id, count(*) AS envios
  FROM reminders r
 WHERE r.sent_at IS NOT NULL
 GROUP BY r.booking_id
HAVING count(*) > 1;

-- Q10 · Invariante de horario → debe devolver 0 filas.
--          Nadie puede haber recibido un mensaje fuera de 8:00–18:00.
SELECT r.id, r.sent_at
  FROM reminders r
 WHERE r.sent_at IS NOT NULL
   AND (r.sent_at AT TIME ZONE 'America/Bogota')::time NOT BETWEEN '08:00' AND '18:00';

-- Q11 · Invariante de no-envío-a-confirmados → debe devolver 0 filas.
SELECT r.id, r.booking_id, b.status, r.sent_at
  FROM reminders r
  JOIN bookings b ON b.id = r.booking_id
 WHERE r.sent_at IS NOT NULL
   AND b.status = 'confirmed'
   AND r.sent_at > b.confirmed_at;   -- enviado después de confirmar = escritura fuera de la reserva

-- ═══════════════════════════════════════════════════════════════════════════════════
-- BLOQUE 4 — Detección temprana (la señal que habría saltado el primer día)
-- ═══════════════════════════════════════════════════════════════════════════════════

-- Q12 · La curva del incidente: tasa de `expired` por hora de creación.
--       Alerta si alguna franja de 1 h supera el 5 %.
--       Esta consulta es la que debía estar en el dashboard desde el día uno.
SELECT extract(hour FROM created_at AT TIME ZONE 'America/Bogota') AS hora_creacion,
       count(*)                                                   AS total,
       count(*) FILTER (WHERE status = 'expired')                 AS caducados,
       round(100.0 * count(*) FILTER (WHERE status = 'expired')
             / count(*), 1)                                       AS pct_expired
  FROM reminders
 WHERE created_at >= now() - interval '1 day'
 GROUP BY 1
 ORDER BY 1;

-- Q13 · Antigüedad máxima en `pending` (medida en tiempo de calendario, que es lo
--       que se vigila hoy) y en `scheduled` (tiempo habilitable, que es lo que debe
--       vigilarse tras el cambio de fondo).
SELECT status,
       count(*)                          AS en_curso,
       max(now() - created_at)           AS antiguedad_max
  FROM reminders
 WHERE status IN ('pending', 'scheduled')
 GROUP BY status;

-- Q14 · % de envíos con éxito en 24 h → alerta si baja del 95 %.
SELECT count(*) FILTER (WHERE status = 'sent')                      AS enviados,
       count(*)                                                      AS totales,
       round(100.0 * count(*) FILTER (WHERE status = 'sent')
             / nullif(count(*), 0), 1)                               AS pct_exito
  FROM reminders
 WHERE created_at >= now() - interval '24 hours';

-- ═══════════════════════════════════════════════════════════════════════════════════
-- Notas de método
-- ═══════════════════════════════════════════════════════════════════════════════════
-- 1. Todo se mide en America/Bogota; sin `AT TIME ZONE` los histogramas mienten.
-- 2. El rango `14 days` es un supuesto: adjustable al periodo del incidente real.
-- 3. Antes de ejecutar cualquier UPDATE, exportar el conjunto elegido a CSV y
--    adjuntarlo al acta de aprobación (trazabilidad de "a quién se le escribió").
-- 4. El script de remediación debe correr con `--dry-run` por defecto y exigir
--    `--execute` explícito; y usar `SELECT ... FOR UPDATE SKIP LOCKED` para que un
--    job concurrente no tome el mismo registro.
