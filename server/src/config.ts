import { z } from 'zod';

/**
 * Configuración = env validada con zod (docs/02 §6).
 *
 * `loadConfig` recibe el env por parámetro (puro, testeable sin procesos ni
 * archivos): `index.ts` le pasa `process.env` y los tests un objeto falso.
 *
 * `AI_API_KEY` **es obligatoria desde la Fase 5**: el chat necesita el modelo y
 * el enunciado exige que la clave viva en `.env`, nunca en el repo. Si falta, el
 * error de arranque lo dice con claridad (y `.env.example` indica cómo obtenerla).
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
  AI_API_KEY: z
    .string({ error: 'AI_API_KEY es obligatoria desde la Fase 5 (el chat la necesita).' })
    .min(1, 'AI_API_KEY no puede estar vacía: usa el valor oc_sk_… y guárdalo en .env'),
  AI_MODEL: z.string().min(1).default('glm-5.3-flash'),
  // Tope de SALIDA por llamada: los modelos de razonamiento se lo gastan casi
  // entero "pensando" (verificado con beam-free), así que no se pone corto.
  AI_MAX_TOKENS: z.coerce.number().int('AI_MAX_TOKENS debe ser un entero').min(256).max(32_000).default(4_000),
  // Límites de uso del chat (Fase 5b): protegen la cuota del proveedor.
  // Ventanas móviles: 5 por minuto y 50 en las últimas 24 h, por sesión.
  AI_MAX_PER_SESSION_MIN: z.coerce.number().int('AI_MAX_PER_SESSION_MIN debe ser un entero').min(1).max(1_000).default(5),
  AI_MAX_PER_SESSION_DAY: z.coerce.number().int('AI_MAX_PER_SESSION_DAY debe ser un entero').min(1).max(100_000).default(50),
  // Presupuesto global mensual en tokens (entrada + salida). Vacío = sin límite:
  // solo se activa poniendo un número, antes de pasarse a un modelo de pago.
  AI_MONTHLY_TOKEN_BUDGET: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.coerce.number().int('AI_MONTHLY_TOKEN_BUDGET debe ser un entero').min(1).optional(),
  ),
});

export interface AiLimits {
  readonly perMinute: number;
  readonly perDay: number;
  readonly monthlyTokenBudget: number | undefined;
}

export interface AiConfig {
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  readonly model: string;
  readonly maxTokens: number;
  readonly limits: AiLimits;
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
    ai: {
      baseUrl: data.AI_BASE_URL,
      apiKey: data.AI_API_KEY,
      model: data.AI_MODEL,
      maxTokens: data.AI_MAX_TOKENS,
      limits: {
        perMinute: data.AI_MAX_PER_SESSION_MIN,
        perDay: data.AI_MAX_PER_SESSION_DAY,
        monthlyTokenBudget: data.AI_MONTHLY_TOKEN_BUDGET,
      },
    },
  };
}
