-- roles.sql — rol de menor privilegio para la aplicación (decisión de operación,
-- ver `docs/03` §12).
--
-- Objetivo: la aplicación (API + worker) se conecta con un rol que SOLO puede
-- leer y escribir datos (DML). NO puede crear ni alterar objetos (DDL), ni
-- hacer DROP/TRUNCATE, ni crear triggers o referencias. Así, un bug o una
-- inyección en la capa de aplicación no puede borrar el esquema ni cambiar
-- las reglas de negocio que garantiza la base de datos (el constraint de
-- exclusión `no_room_overlap`).
--
-- Las MIGRACIONES y el SEED siguen necesitando un rol con DDL: para eso está
-- `MIGRATOR_DATABASE_URL` (ver `docs/02` §6). Si no se define, el migrador usa
-- `DATABASE_URL` (comportamiento de desarrollo por defecto).
--
-- Cómo se aplica (una vez, con el usuario dueño de la base):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/roles.sql
--
-- Es IDEMPOTENTE: se puede re-ejecutar sin efectos (los GRANT son no-op si el
-- privilegio ya existe, y el bloque DO solo crea el rol si no existe).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Rol de la aplicación
-- ─────────────────────────────────────────────────────────────────────────────
-- LOGIN: la app se autentica DIRECTAMENTE con este rol, no con el usuario
-- dueño de la base. Es la diferencia entre "menos privilegio de verdad" y
-- "menos privilegio decorativo": si la app se conectara como owner y luego
-- hiciera `SET ROLE coworking_app`, una inyección SQL podría deshacer ese
-- `SET ROLE` y volver a tener todos los privilegios.
--
-- La contraseña se fija desde la variable de entorno `COWORKING_APP_PASSWORD`
-- (la pasa el script `npm run db:roles`); si no está, se genera una aleatoria
-- y se imprime en pantalla para copiarla a `.env`.
DO $$
DECLARE
  app_password text := coalesce(current_setting('coworking.app_password', true), '');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coworking_app') THEN
    IF app_password = '' THEN
      -- Sin clave: el rol existe pero no puede iniciar sesión con contraseña
      -- (útil hasta que se le asigne una con `npm run db:roles`).
      CREATE ROLE coworking_app LOGIN;
    ELSE
      -- `PASSWORD` exige un literal, no un identificador: se arma la sentencia
      -- con format() y se ejecuta de forma dinámica.
      EXECUTE format('CREATE ROLE coworking_app LOGIN PASSWORD %L', app_password);
    END IF;
  ELSE
    -- El rol ya existe: solo se actualiza la contraseña si se pasó una nueva
    -- (así el script es re-ejecutable sin rotar la clave por accidente).
    IF app_password <> '' THEN
      EXECUTE format('ALTER ROLE coworking_app PASSWORD %L', app_password);
    END IF;
  END IF;
END
$$;

-- Sin herencia: el rol NO hereda los privilegios del usuario que lo activa
-- (ni del rol owner), de modo que la app no puede escribir en tablas por
-- "herencia" de un superusuario.
ALTER ROLE coworking_app NOINHERIT;

-- Límite de recursos: una app con un `max: 10` de pool no necesita más de 20
-- conexiones. El límite blinda al servidor si alguien abre conexiones a mano.
ALTER ROLE coworking_app CONNECTION LIMIT 20;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Privilegios sobre las tablas de la aplicación
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT / INSERT / UPDATE / DELETE sobre las 9 tablas que usa la app.
-- Sin CREATE, DROP, TRUNCATE, REFERENCES ni TRIGGER.
--
-- Lista explícita (y no "todas las tablas del esquema") a propósito: si
-- mañana alguien crea una tabla nueva, tiene que decidir explícitamente si la
-- app la necesita, en lugar de regalarle el acceso por defecto.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  users,
  rooms,
  bookings,
  booking_lines,
  sessions,
  email_outbox,
  chat_sessions,
  chat_messages,
  login_attempts
TO coworking_app;

-- Las columnas IDENTITY generan valores con una secuencia interna: sin
-- `USAGE` sobre ella, todo INSERT falla con "permission denied for sequence".
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO coworking_app;

-- El seed usa `setval()` sobre las secuencias (alinear el IDENTITY con el
-- mayor id insertado) y esa función es del migrador, no de la app; por eso
-- aquí NO se otorga `setval` ni `SELECT` sobre las secuencias. `USAGE` sí es
-- necesario para los INSERT de la app.

-- Sin objetos de esquema: la app no crea nada (ni tablas, ni vistas, ni
-- funciones, ni extensiones). `CREATE` en el esquema queda denegado.
REVOKE CREATE ON SCHEMA public FROM coworking_app;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Verificación
-- ─────────────────────────────────────────────────────────────────────────────
-- Consulta de control: lista los privilegios reales del rol. Debe mostrar
-- DML y NADA de DDL (Create/Truncate/References/Trigger).
--
--   SELECT table_name, privilege_type
--     FROM information_schema.role_table_grants
--    WHERE grantee = 'coworking_app'
--    ORDER BY table_name, privilege_type;
--
-- Comprobación de que NO hay DDL (las cuatro columnas deben salir en false):
--
--   SELECT has_table_privilege('coworking_app', 'bookings', 'TRUNCATE')  AS puede_truncar,
--          has_table_privilege('coworking_app', 'bookings', 'REFERENCES') AS puede_referenciar,
--          has_table_privilege('coworking_app', 'bookings', 'TRIGGER')    AS puede_trigger,
--          has_schema_privilege('coworking_app', 'public', 'CREATE')      AS puede_crear_esquema;
--
-- Prueba de humo: la app debe poder INSERTAR y no debe poder TRUNCATE.
--   SET ROLE coworking_app;
--   INSERT INTO rooms (name, size, capacity, hourly_rate) VALUES ('Test', 'small', 1, 1);
--   TRUNCATE bookings;   -- debe fallar: "permission denied"
