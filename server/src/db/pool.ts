import { Pool } from 'pg';

/**
 * Pool global de PostgreSQL: una sola instancia compartida por los módulos.
 *
 * Tiempos de vida (decisión de operación, ver `docs/03` §12.2):
 *  - `max: 10` conexiones simultáneas: el servidor es pequeño y el cuello de
 *    botella real es la BD, no el proceso de Node.
 *  - `idleTimeoutMillis: 10_000` → una conexión ociosa se devuelve al pool a
 *    los 10 s (es el valor por defecto de `pg`, aquí es explícito a propósito).
 *  - `connectionTimeoutMillis: 5_000` → si la BD no acepta una conexión nueva
 *    (caída, `kill -9` de Postgres, failover), la espera **falla rápido** en
 *    lugar de colgar la petición HTTP indefinidamente. Sin este límite, el
 *    valor por defecto de `pg` es 0 = esperar para siempre.
 *  - `maxLifetimeSeconds: 1_800` → recicla las conexiones cada 30 min: si un
 *    proxy o un firewall corta conexiones ociosas en silencio, el pool no se
 *    queda con sockets muertos que solo fallan al usarlos.
 */
export function createPool(databaseUrl: string): Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    maxLifetimeSeconds: 1_800,
  });
}
