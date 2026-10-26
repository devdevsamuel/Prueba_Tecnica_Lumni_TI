-- seed.sql — datos mínimos de desarrollo (docs/04 §1).
-- Idempotente: re-ejecutarlo no duplica ni modifica filas existentes.
-- Se aplica con: npm run seed

-- 2 usuarios (cliente y administrador). Contraseña de desarrollo: coworking2026
-- Hash scrypt (node:crypto, docs/03 §8) precalculado con N=16384, r=8, p=1,
-- keylen=64 y salt aleatorio embebido; formato: scrypt$N$r$p$salt$hash (base64).
-- La verificación real (password.ts) llega en la Fase 3.
INSERT INTO users (id, email, full_name, role, password_hash) VALUES
  (1, 'cliente@coworking.test', 'Cliente de Prueba', 'client',
   'scrypt$16384$8$1$V1WEPUhZ7lThajmvghPgYA==$me674qmUEQblTOkZasdaLoJ1K+AlRFX+Eu04Ai0kus1wk27xp53RKdkuT2gl4XZTVEZTuQSGSK1DvNhy5kWy0Q=='),
  (2, 'admin@coworking.test', 'Administración', 'admin',
   'scrypt$16384$8$1$bNBOSXoDHFnjLw7e3nsa0A==$/mV64Z+Kg0JrJSPlHeziZQvPhDerqt5S6THTJ0nrDCC5ri3rjYWarKmcylnxFHiaX/O0Sxc+rI5sgGM0Le7xNg==')
ON CONFLICT (id) DO NOTHING;

-- 3 salas con las tarifas del enunciado y capacidades decididas en docs/01 §14.9.
INSERT INTO rooms (id, name, size, capacity, hourly_rate) VALUES
  (1, 'Sala Pequeña', 'small',  4,  40000.00),
  (2, 'Sala Mediana', 'medium', 8,  70000.00),
  (3, 'Sala Grande',  'large', 12, 120000.00)
ON CONFLICT (id) DO NOTHING;

-- Los inserts de arriba fijan ids explícitos, pero eso NO avanza la secuencia
-- del IDENTITY. Sin este ajuste, el siguiente INSERT sin id intentaría reusar el
-- 1 y fallaría con duplicado en la clave primaria. Se alinea la secuencia al
-- mayor id existente (idempotente y seguro con tablas vacías).
SELECT setval(pg_get_serial_sequence('users', 'id'),  (SELECT COALESCE(MAX(id), 0) FROM users));
SELECT setval(pg_get_serial_sequence('rooms', 'id'),  (SELECT COALESCE(MAX(id), 0) FROM rooms));
