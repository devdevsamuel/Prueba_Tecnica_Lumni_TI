#!/bin/sh
# Aplica db/seed.sql con psql. Carga .env si existe para no depender de
# variables exportadas en la shell (misma filosofía que scripts/dev.sh: 0 dependencias).
if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi
if [ -z "$DATABASE_URL" ]; then
  echo "ERROR: DATABASE_URL no está definida. Copia .env.example a .env." >&2
  exit 1
fi
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/seed.sql
