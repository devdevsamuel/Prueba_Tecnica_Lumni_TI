import { Pool } from 'pg';

/** Pool global de PostgreSQL: una sola instancia compartida por los módulos. */
export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl, max: 10 });
}
