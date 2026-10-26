import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { hashPassword, verifyPassword } from './password.js';

const SEED = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../db/seed.sql',
);

/** Extrae el hash de un correo concreto del seed (fuente de verdad del login). */
async function seedHashFor(email: string): Promise<string> {
  const sql = await readFile(SEED, 'utf8');
  const match = new RegExp(`'${email}'[^)]*?'(scrypt\\$[^']+)'`, 's').exec(sql);
  assert.ok(match, `no se encontró el hash de ${email} en el seed`);
  return match[1] as string;
}

test('la contraseña sembrada del administrador valida (formato real del seed)', async () => {
  const hash = await seedHashFor('admin@coworking.test');
  assert.equal(await verifyPassword('coworking2026', hash), true, 'debe validar la contraseña');
  assert.equal(await verifyPassword('coworking2026 ', hash), false, 'sin espacios extra');
  assert.equal(await verifyPassword('otra', hash), false, 'otra contraseña no valida');
});

test('la contraseña sembrada del cliente valida', async () => {
  const hash = await seedHashFor('cliente@coworking.test');
  assert.equal(await verifyPassword('coworking2026', hash), true);
});

test('hashPassword/verifyPassword hacen ida y vuelta', async () => {
  const hash = await hashPassword('secreta-123');
  assert.match(hash, /^scrypt\$16384\$8\$1\$[^$]+\$[^$]+$/);
  assert.equal(await verifyPassword('secreta-123', hash), true);
  assert.equal(await verifyPassword('secreta-124', hash), false);
});

test('hashes malformados o manipulados no validan (sin lanzar)', async () => {
  assert.equal(await verifyPassword('x', ''), false);
  assert.equal(await verifyPassword('x', 'bcrypt$abc'), false);
  assert.equal(await verifyPassword('x', 'scrypt$16384$8$1$'), false);
  assert.equal(await verifyPassword('x', 'scrypt$0$8$1$AAAA$BBBB'), false);
  assert.equal(
    await verifyPassword('coworking2026', 'scrypt$16384$8$1$AAAA$BBBB'),
    false,
    'hash distinto no valida',
  );
});
