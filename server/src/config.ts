import { z } from 'zod';

/**
 * Configuración = env validada con zod (docs/02 §6).
 *
 * `loadConfig` recibe el env por parámetro (puro, testeable sin procesos ni
 * archivos): `index.ts` le pasa `process.env` y los tests un objeto falso.
 * Decisión: `AI_API_KEY` es OPCIONAL en la Fase 0; pasa a requerirse en la
 * Fase 5, cuando el chat la usa. Así el esqueleto arranca sin clave de IA.
 */
const EnvSchema = z.object({
  DATABASE_URL: z.url('DATABASE_URL debe ser una URL de PostgreSQL válida'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  SESSION_SECRET: z
    .string()
    .min(32, 'SESSION_SECRET debe tener al menos 32 caracteres (generar con: openssl rand -hex 32)'),
  TZ: z.string().min(1).default('America/Bogota'),
  // Para la cookie de sesión: `Secure` solo en producción (docs/03 §8).
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  AI_BASE_URL: z
    .url('AI_BASE_URL debe ser una URL válida')
    .default('https://opencode.ai/inference/go/openai/v1'),
  AI_API_KEY: z.string().min(1).optional(),
  AI_MODEL: z.string().min(1).default('glm-5.3-flash'),
});

export interface AiConfig {
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  readonly model: string;
}

export interface Config {
  readonly databaseUrl: string;
  readonly port: number;
  readonly sessionSecret: string;
  readonly tz: string;
  readonly isProduction: boolean;
  readonly ai: AiConfig;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(raíz)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`Configuración inválida — ${issues}`);
  }
  const data = parsed.data;
  return {
    databaseUrl: data.DATABASE_URL,
    port: data.PORT,
    sessionSecret: data.SESSION_SECRET,
    tz: data.TZ,
    isProduction: data.NODE_ENV === 'production',
    ai: { baseUrl: data.AI_BASE_URL, apiKey: data.AI_API_KEY, model: data.AI_MODEL },
  };
}
