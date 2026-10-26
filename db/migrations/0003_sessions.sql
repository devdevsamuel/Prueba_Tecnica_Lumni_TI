-- 0003_sessions.sql — sesiones de servidor (docs/01 §6, docs/03 §8).
--
-- La cookie `sid` es `base64(payload).hmac-sha256` firmada con SESSION_SECRET,
-- pero la tabla es quien da **expiración y revocación**: sin ella, un cookie
-- robado seguiría válido (y "cerrar sesión" no invalidaría nada en el servidor).
CREATE TABLE sessions (
  id         text PRIMARY KEY,               -- sid aleatorio que viaja en la cookie
  user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);
