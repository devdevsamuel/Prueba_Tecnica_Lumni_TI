#!/bin/sh
# Aplica db/seed.sql con psql. Carga .env si existe para no depender de
# variables exportadas en la shell (misma filosofía que scripts/dev.sh: 0 dependencias).
#
# Las variables YA definidas en el entorno tienen prioridad sobre las de .env.
#
# El seed es una operación de MIGRADOR: inserta usuarios/salas y hace `setval()`
# sobre las secuencias (privilegio que el rol de la aplicación no tiene). Por eso
# usa `MIGRATOR_DATABASE_URL` cuando está definida; si no, usa `DATABASE_URL`.
if [ -f .env ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) continue ;;
    esac
    key=${line%%=*}
    value=${line#*=}
    case "$key" in
      *[!A-Za-z0-9_]*|'') continue ;;
    esac
    eval "current=\${$key+x}"
    [ -z "$current" ] && eval "$key=\$value"
  done < .env
fi
if [ -z "$DATABASE_URL" ]; then
  echo "ERROR: DATABASE_URL no está definida. Copia .env.example a .env." >&2
  exit 1
fi
SEED_URL="${MIGRATOR_DATABASE_URL:-$DATABASE_URL}"
psql "$SEED_URL" -v ON_ERROR_STOP=1 -f db/seed.sql
