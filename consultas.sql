-- ============================================================================
-- consultas.sql — Parte 3 (PostgreSQL) · 10 %
--
-- Una consulta por punto, comentada solo donde la intención no es obvia.
-- Esquema: el simplificado que entrega el enunciado (literal en §0).
--
-- DATOS DE EJEMPLO: el enunciado dice "te enviaremos un script con datos de
-- ejemplo" pero NO viene incluido → se genera un dataset reproducible con
-- generate_series (anexo A). Con él están verificadas las 4 primeras consultas
-- y medida la 5:
--   7 salas · 100.003 clientes · 101.207 reservas · 101.232 líneas · 5.000.007 pagos
--   Q1 16.165 filas · Q2 una decena (solo solapes reales) · Q3 84 filas · Q4 33 filas
--   (Q2 varía levemente según la hora en que se ejecute el anexo: los casos
--    límite se expresan respecto a `now()`.)
--
-- ⚠ EJECUTAR EN UNA BASE DE DATOS APARTE (p. ej. \c parte3): las tablas rooms,
--   bookings y booking_lines CHOCAN con las de la Parte 1.
-- ============================================================================

-- ── 0) Esquema (literal del enunciado) ──────────────────────────────────────
CREATE TABLE rooms         (id serial PRIMARY KEY, name text NOT NULL,
                            size text NOT NULL CHECK (size IN ('small','medium','large')),
                            hourly_rate numeric(14,2) NOT NULL);
CREATE TABLE customers     (id serial PRIMARY KEY, email text UNIQUE NOT NULL, full_name text NOT NULL, company text);
CREATE TABLE bookings      (id serial PRIMARY KEY, customer_id int REFERENCES customers, room_id int REFERENCES rooms,
                            starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
                            created_at timestamptz NOT NULL, total numeric(14,2) NOT NULL,
                            status text CHECK (status IN ('draft','confirmed','completed','cancelled')),
                            payment_status text CHECK (payment_status IN ('unpaid','partial','paid')));
CREATE TABLE booking_lines (id serial PRIMARY KEY, booking_id int REFERENCES bookings,
                            concept text NOT NULL, amount numeric(14,2) NOT NULL);
CREATE TABLE payments      (id serial PRIMARY KEY, booking_id int REFERENCES bookings, amount numeric(14,2),
                            external_event_id text, paid_at timestamptz);

-- ── 1) Clientes morosos antiguos ────────────────────────────────────────────
-- MIN(ends_at) es la más antigua de LAS QUE CUMPLEN el filtro (>30 días);
-- HAVING > 0 es el "aún tiene saldo pendiente" del enunciado.
SELECT c.email,
       c.full_name,
       c.company,
       SUM(b.total - COALESCE(p.paid, 0))                          AS saldo_pendiente,
       (EXTRACT(epoch FROM (now() - MIN(b.ends_at))) / 86400)::int AS dias_desde_la_mas_antigua
  FROM customers c
  JOIN bookings b ON b.customer_id = c.id
  LEFT JOIN (SELECT booking_id, SUM(amount) AS paid
               FROM payments GROUP BY booking_id) p ON p.booking_id = b.id
 WHERE b.status = 'completed'
   AND b.ends_at < now() - interval '30 days'
 GROUP BY c.id, c.email, c.full_name, c.company
HAVING SUM(b.total - COALESCE(p.paid, 0)) > 0
 ORDER BY saldo_pendiente DESC;

-- ── 2) Reservas cruzadas ────────────────────────────────────────────────────
-- b.id > a.id → una sola fila por par (evita A-B y B-A y el emparejamiento
-- consigo mismo). El solape es estricto (< y >): que una termine a las 10:00 y
-- otra empiece a las 10:00 NO se cruzan.
SELECT a.id AS reserva_a,
       b.id AS reserva_b,
       a.room_id AS sala
  FROM bookings a
  JOIN bookings b
    ON b.room_id = a.room_id
   AND b.id > a.id
   AND a.status IN ('confirmed', 'completed')
   AND b.status IN ('confirmed', 'completed')
   AND a.starts_at < b.ends_at
   AND a.ends_at   > b.starts_at
 ORDER BY a.id, b.id;

-- Nota de rendimiento (medido sobre 101.207 reservas): con esta forma el hash
-- join descarta 250.790.004 pares candidatos → 143.6 s. `room_id` no tiene
-- índice y admite pocos valores, así que la unión se vuelve casi cartesiana por
-- sala. Se arregla con un índice de intervalo y expresando el solape como `&&`:
--   CREATE EXTENSION IF NOT EXISTS btree_gist;
--   CREATE INDEX bookings_room_range_idx ON bookings USING gist
--     (room_id, tstzrange(starts_at, ends_at));
-- entonces `tstzrange(b.starts_at,b.ends_at) && tstzrange(a.starts_at,a.ends_at)`
-- da Nested Loop + Index Scan: **143,6 s → 2,3 s (62×)**. (Mismo índice que ya
-- protege la no-solape en la Parte 1.)

-- ── 3) Horas e ingresos por sala y mes (últimos 12 meses) ───────────────────
-- CROSS JOIN con la retícula meses × salas → cada sala aparece los 12 meses,
-- en 0 si no tuvo reservas. El mes se calcula en hora de Colombia.
WITH meses AS (
  SELECT generate_series(
           date_trunc('month', now() AT TIME ZONE 'America/Bogota') - interval '11 months',
           date_trunc('month', now() AT TIME ZONE 'America/Bogota'),
           interval '1 month') AS mes
)
SELECT r.id                                   AS sala_id,
       r.name                                 AS sala,
       to_char(m.mes, 'YYYY-MM')              AS mes,
       ROUND(COALESCE(SUM(EXTRACT(epoch FROM (b.ends_at - b.starts_at)) / 3600), 0), 2) AS horas,
       COALESCE(SUM(b.total), 0)              AS ingresos
  FROM rooms r
  CROSS JOIN meses m
  LEFT JOIN bookings b
         ON b.room_id = r.id
        AND b.status IN ('confirmed', 'completed')
        AND date_trunc('month', b.starts_at AT TIME ZONE 'America/Bogota') = m.mes
 GROUP BY r.id, r.name, m.mes
 ORDER BY r.name, mes;

-- ── 4) Inconsistencias ──────────────────────────────────────────────────────
-- COALESCE convierte el NULL del LEFT JOIN en 0: una reserva sin líneas tiene
-- suma 0 y por tanto también es inconsistente.
SELECT b.id                       AS reserva,
       b.total,
       COALESCE(l.suma, 0)        AS suma_lineas,
       COALESCE(p.pagado, 0)      AS pagado,
       CASE
         WHEN b.total <> COALESCE(l.suma, 0)
          AND b.payment_status = 'paid'
          AND COALESCE(p.pagado, 0) < b.total THEN 'ambas'
         WHEN b.total <> COALESCE(l.suma, 0)  THEN 'booking_lines'
         ELSE 'pagos_insuficientes'
       END                        AS fallo
  FROM bookings b
  LEFT JOIN (SELECT booking_id, SUM(amount) AS suma
               FROM booking_lines GROUP BY booking_id) l ON l.booking_id = b.id
  LEFT JOIN (SELECT booking_id, SUM(amount) AS pagado
               FROM payments      GROUP BY booking_id) p ON p.booking_id = b.id
 WHERE b.total <> COALESCE(l.suma, 0)
    OR (b.payment_status = 'paid' AND COALESCE(p.pagado, 0) < b.total)
 ORDER BY b.id;

-- ── 5) payments con 5 millones de filas: índices ────────────────────────────
-- 1. payments (booking_id, amount) y booking_lines (booking_id, amount): índices
--    cubrientes → Index Only Scan (no tocan el heap) y sin desbordar a temp.
-- 2. Comprobación: mismo EXPLAIN (ANALYZE, BUFFERS) antes y después; buscar
--    "Seq Scan" → "Index Only Scan" y la caída de Execution Time.
-- 3. Coste: 136 MB + 3,1 MB. Medido: 9.259 ms → 3.353 ms (−64 %, 2,8×).

-- Índices propuestos (bloque comentado):
-- CREATE INDEX payments_booking_amount_idx      ON payments      (booking_id, amount);
-- CREATE INDEX booking_lines_booking_amount_idx ON booking_lines (booking_id, amount);
-- ANALYZE payments; ANALYZE booking_lines;

-- La comprobación es este mismo EXPLAIN, ejecutado antes y después de crearlos:
EXPLAIN (ANALYZE, BUFFERS)
SELECT b.id, b.total, COALESCE(l.suma, 0) AS suma_lineas, COALESCE(p.pagado, 0) AS pagado
  FROM bookings b
  LEFT JOIN (SELECT booking_id, SUM(amount) AS suma
               FROM booking_lines GROUP BY booking_id) l ON l.booking_id = b.id
  LEFT JOIN (SELECT booking_id, SUM(amount) AS pagado
               FROM payments      GROUP BY booking_id) p ON p.booking_id = b.id
 WHERE b.total <> COALESCE(l.suma, 0)
    OR (b.payment_status = 'paid' AND COALESCE(p.pagado, 0) < b.total);

-- Resultados medidos en local con el dataset del anexo A (5.000.007 pagos):
--
--   ANTES   Seq Scan en payments/booking_lines + HashAggregate
--           Execution Time: 9.259 ms
--   DESPUÉS Index Only Scan en ambas + GroupAggregate
--           Execution Time: 3.353 ms    → −64 % (2,8×)
--           índices: 136 MB + 3,1 MB (heap: 313 MB + 5,1 MB)

-- ============================================================================
-- ANEXO A — dataset de verificación (el script de datos no viene en el PDF).
-- Ejecutar tras §0, sobre la base de datos aparte, antes de las consultas.
-- Tarda ~4 minutos.
-- ============================================================================
INSERT INTO rooms (id, name, size, hourly_rate) VALUES
 (1,'Sala 1','small',40000), (2,'Sala 2','medium',70000), (3,'Sala 3','large',120000),
 (4,'Sala 4','small',40000), (5,'Sala 5','medium',70000),
 (6,'Sala 6','large',120000),              -- solo 60 días → ceros el resto
 (7,'Sala 7 sin reservas','small',40000);   -- 12 meses en cero

INSERT INTO customers (id, email, full_name, company)
SELECT n, 'cliente' || n || '@example.test', 'Cliente ' || n,
       CASE WHEN n % 4 = 0 THEN NULL ELSE 'Empresa ' || (n % 77) END
FROM generate_series(1, 100000) AS n;
SELECT setval(pg_get_serial_sequence('customers','id'), 100000);
SELECT setval(pg_get_serial_sequence('rooms','id'), 7);

-- Salas 1–5: 1.000 días × 5 salas × 20 huecos de 30 min (08:00–18:00). Los
-- huecos NO se solapan entre sí: la consulta 2 solo puede hallar solapes reales
-- (y ~95.000 pares colindantes por sala/día que NO son solape).
INSERT INTO bookings (customer_id, room_id, starts_at, ends_at, created_at, total, status, payment_status)
SELECT 1 + (b.n % 100000),
       b.sala,
       b.empieza,
       b.empieza + interval '30 minutes',
       b.empieza - interval '2 days',
       (CASE WHEN b.n % 5 = 0 THEN 40000 WHEN b.n % 5 = 1 THEN 70000 ELSE 120000 END)::numeric(14,2),
       (ARRAY['draft','confirmed','completed','cancelled'])[1 + (b.n % 4)],
       (ARRAY['unpaid','partial','paid'])[1 + (b.n % 3)]
FROM (
  SELECT (d.dia * 5 + s.sala) * 20 + h.hueco AS n,
         s.sala,
         date_trunc('day', now()) - make_interval(days => d.dia) + time '08:00'
           + make_interval(mins => h.hueco * 30) AS empieza
    FROM generate_series(0, 999) AS d(dia)
   CROSS JOIN generate_series(1, 5) AS s(sala)
   CROSS JOIN generate_series(0, 19) AS h(hueco)
) AS b;

-- Sala 6: solo hace 40–99 días (dentro de la ventana de 12 meses).
INSERT INTO bookings (customer_id, room_id, starts_at, ends_at, created_at, total, status, payment_status)
SELECT 1 + (b.n % 100000), 6,
       b.empieza, b.empieza + interval '30 minutes', b.empieza - interval '2 days',
       40000, 'confirmed', 'unpaid'
FROM (
  SELECT row_number() OVER () AS n,
         date_trunc('day', now()) - make_interval(days => d.dia) + time '08:00'
           + make_interval(mins => h.hueco * 30) AS empieza
    FROM generate_series(40, 99) AS d(dia)
   CROSS JOIN generate_series(0, 19) AS h(hueco)
) AS b;

-- Casos límite. Ojo: los ids van POR ENCIMA de los 100.000 de la carga masiva.
INSERT INTO customers (id, email, full_name, company) VALUES
 (900001,'moroso@x.test','Moroso Real','Empresa Morosa'),
 (900002,'alDia@x.test','Cliente Al Día','Empresa Al Día'),
 (900003,'reciente@x.test','Cliente Reciente','Empresa Reciente');

INSERT INTO bookings (id, customer_id, room_id, starts_at, ends_at, created_at, total, status, payment_status) VALUES
 -- moroso real (saldo 70.000, terminó hace ~61 días) / pagado del todo / reciente (< 30 días)
 (9000011,900001,1,now() - interval '61 days', now() - interval '61 days' + interval '2 hours',
                     now() - interval '62 days',100000,'completed','partial'),
 (9000012,900002,1,now() - interval '91 days', now() - interval '91 days' + interval '2 hours',
                     now() - interval '92 days', 50000,'completed','paid'),
 (9000013,900003,1,now() - interval '11 days', now() - interval '11 days' + interval '2 hours',
                     now() - interval '12 days', 30000,'completed','unpaid'),
 -- solape REAL (debe salir en la consulta 2)…
 (9000021,900001,4,date_trunc('day',now()) - interval '100 days' + interval '9 hours',
                     date_trunc('day',now()) - interval '100 days' + interval '11 hours', now() - interval '110 days',70000,'confirmed','paid'),
 (9000022,900001,4,date_trunc('day',now()) - interval '100 days' + interval '10 hours',
                     date_trunc('day',now()) - interval '100 days' + interval '12 hours', now() - interval '110 days',70000,'confirmed','paid'),
 -- …y colindancia 8:00–10:00 / 10:00–12:00 (NO debe salir).
 (9000023,900002,4,date_trunc('day',now()) - interval '99 days' + interval '8 hours',
                     date_trunc('day',now()) - interval '99 days' + interval '10 hours', now() - interval '110 days',70000,'completed','paid'),
 (9000024,900002,4,date_trunc('day',now()) - interval '99 days' + interval '10 hours',
                     date_trunc('day',now()) - interval '99 days' + interval '12 hours', now() - interval '110 days',70000,'completed','paid');

-- Líneas: la base cuadra con total en TODAS; anomalía A (id % 4000) no cuadra.
INSERT INTO booking_lines (booking_id, concept, amount)
SELECT id, 'base', total FROM bookings;
INSERT INTO booking_lines (booking_id, concept, amount)
SELECT id, 'ajuste', 1 FROM bookings WHERE id % 4000 = 0;

-- Anomalía B: 'paid' pero pagando 1 COP de menos (id % 6000).
UPDATE bookings SET payment_status = 'paid' WHERE id % 6000 = 0;

-- Exactamente 5.000.000 de pagos: 50 eventos por reserva de las salas 1–5
-- (con external_event_id, como log de eventos). `paid` cuadra con el total salvo
-- en la anomalía B; `partial` paga el 20 %; `unpaid` no paga.
INSERT INTO payments (booking_id, amount, external_event_id, paid_at)
SELECT b.id,
       CASE b.payment_status
         WHEN 'paid'     THEN ((b.total - CASE WHEN b.id % 6000 = 0 THEN 1 ELSE 0 END) * 0.02)::numeric(14,2)
         WHEN 'partial'  THEN (b.total * 0.004)::numeric(14,2)
         ELSE 0
       END,
       'evt-' || b.id || '-' || g.i,
       now() - ((b.id % 450) || ' days')::interval
  FROM bookings b
 CROSS JOIN generate_series(1, 50) AS g(i)
 WHERE b.id <= 100000;   -- solo las salas 1–5 (la sala 6 queda sin pagos)

INSERT INTO payments (booking_id, amount, external_event_id, paid_at) VALUES
 (9000011,30000,'evt-moroso',   now() - interval '61 days'),
 (9000012,50000,'evt-aldia',    now() - interval '91 days'),
 (9000013,    0,'evt-reciente', now() - interval '11 days'),
 (9000021,70000,'evt-21', now() - interval '100 days'),
 (9000022,70000,'evt-22', now() - interval '100 days'),
 (9000023,70000,'evt-23', now() - interval '99 days'),
 (9000024,70000,'evt-24', now() - interval '99 days');

SELECT setval(pg_get_serial_sequence('bookings','id'), (SELECT MAX(id) FROM bookings));
ANALYZE;
