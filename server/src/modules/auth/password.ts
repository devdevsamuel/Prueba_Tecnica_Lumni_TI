import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

/**
 * Contraseñas con `scrypt` de `node:crypto` (docs/01 §7): sin bcrypt ni librerías.
 *
 * Formato guardado (el mismo que usa `db/seed.sql`):
 *   `scrypt$N$r$p$salt$hash` con salt y hash en base64.
 * Se leen N, r y p del propio hash para verificar con los parámetros con los que
 * se creó, y la comparación usa `timingSafeEqual` (no filtra el tiempo).
 */

const DEFAULT_N = 16_384;
const DEFAULT_R = 8;
const DEFAULT_P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
// scrypt necesita ~128·N·r bytes (16 MB con N=16384, r=8) → subir el tope de memoria.
const MAXMEM = 64 * 1024 * 1024;

interface ParsedHash {
  readonly n: number;
  readonly r: number;
  readonly p: number;
  readonly salt: Buffer;
  readonly hash: Buffer;
}

function parse(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(n) || n < 2 || !Number.isInteger(r) || r < 1 || !Number.isInteger(p) || p < 1) {
    return null;
  }
  const salt = Buffer.from(saltRaw, 'base64');
  const hash = Buffer.from(hashRaw, 'base64');
  if (salt.length === 0 || hash.length === 0) return null;
  return { n, r, p, salt, hash };
}

/** Hashea una contraseña con los mismos parámetros que el seed. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await scrypt(password, salt, KEY_LENGTH, {
    N: DEFAULT_N,
    r: DEFAULT_R,
    p: DEFAULT_P,
    maxmem: MAXMEM,
  });
  return `scrypt$${DEFAULT_N}$${DEFAULT_R}$${DEFAULT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** Comprueba una contraseña contra su hash. Nunca lanza: devuelve `false`. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed) return false;
  try {
    const derived = await scrypt(password, parsed.salt, parsed.hash.length, {
      N: parsed.n,
      r: parsed.r,
      p: parsed.p,
      maxmem: MAXMEM,
    });
    if (derived.length !== parsed.hash.length) return false;
    return timingSafeEqual(derived, parsed.hash);
  } catch {
    // Parámetros inválidos o memoria insuficiente → no valida.
    return false;
  }
}
