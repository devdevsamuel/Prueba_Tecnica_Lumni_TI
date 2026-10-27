#!/bin/sh
# Crea (o actualiza) el rol de menor privilegio `coworking_app` para la
# aplicación y muestra los privilegios resultantes.
#
#   npm run db:roles
#
# La contraseña del rol:
#   - si existe COWORKING_APP_PASSWORD en el entorno, se usa esa;
#   - si no, se genera una aleatoria y se imprime al final (cópiala a `.env`
#     como DATABASE_URL=postgresql://coworking_app:<clave>@localhost:5432/coworking).
#
# Se aplica con el usuario dueño de la base (el de DATABASE_URL), porque crear
# roles y conceder privilegios es DDL y solo un owner/superuser puede hacerlo.
set -e

# Carga .env si existe para no depender de variables exportadas en la shell
# (misma filosofía que scripts/dev.sh: 0 dependencias). Las variables YA
# definidas en el entorno tienen prioridad sobre las de .env, para poder
# apuntar a una base de pruebas sin editar el archivo.
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
    # Solo se define si la variable no viene ya del entorno.
    eval "current=\${$key+x}"
    [ -z "$current" ] && eval "$key=\$value"
  done < .env
fi

if [ -z "$DATABASE_URL" ]; then
  echo "ERROR: DATABASE_URL no está definida. Copia .env.example a .env." >&2
  exit 1
fi

# `current_setting('coworking.app_password')` es la vía para pasar la clave al
# bloque DO de db/roles.sql sin interpolarla en el texto de la consulta.
# PGOPTIONS se aplica a la SESIÓN completa de psql (no a una sentencia suelta),
# así que el valor está disponible durante todo el `-f db/roles.sql`.
if [ -z "$COWORKING_APP_PASSWORD" ]; then
  COWORKING_APP_PASSWORD="app-$(openssl rand -hex 12)"
  GENERATED=1
else
  GENERATED=0
fi

PGOPTIONS="-c coworking.app_password='$COWORKING_APP_PASSWORD'" \
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/roles.sql

echo
echo "── Privilegios de coworking_app sobre las tablas ──"
psql "$DATABASE_URL" -c "
  SELECT table_name, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privilegios
    FROM information_schema.role_table_grants
   WHERE grantee = 'coworking_app'
   GROUP BY table_name
   ORDER BY table_name;"

echo "── Comprobación de que NO hay DDL (todo debe ser false) ──"
psql "$DATABASE_URL" -c "
  SELECT has_table_privilege('coworking_app', 'bookings', 'TRUNCATE')  AS puede_truncar,
         has_table_privilege('coworking_app', 'bookings', 'REFERENCES') AS puede_referenciar,
         has_table_privilege('coworking_app', 'bookings', 'TRIGGER')    AS puede_trigger,
         has_schema_privilege('coworking_app', 'public', 'CREATE')      AS puede_crear_esquema;"

if [ "$GENERATED" = "1" ]; then
  echo
  echo "Contraseña generada para coworking_app: $COWORKING_APP_PASSWORD"
  echo "Añádela a .env como DATABASE_URL del rol de la aplicación:"
  echo "  DATABASE_URL=postgresql://coworking_app:$COWORKING_APP_PASSWORD@localhost:5432/coworking"
  echo "y deja MIGRATOR_DATABASE_URL apuntando al usuario dueño (para `npm run migrate`)."
fi
