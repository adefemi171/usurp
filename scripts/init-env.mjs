import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** New installations only. Existing database roles require coordinated rotation. */
export function initializeEnv(directory = process.cwd()) {
  const password = randomBytes(32).toString('hex');
  const template = readFileSync(resolve(directory, '.env.example'), 'utf8');
  if (!template.includes('REPLACE_WITH_GENERATED_PASSWORD') || !/^POSTGRES_PASSWORD=$/m.test(template)) {
    throw new Error('Unexpected environment template; no file written.');
  }
  const content = template.replaceAll('REPLACE_WITH_GENERATED_PASSWORD', password)
    .replace(/^POSTGRES_PASSWORD=$/m, `POSTGRES_PASSWORD=${password}`)
    .replace(/^AUTH_SECRET=$/m, `AUTH_SECRET=${randomBytes(32).toString('base64url')}`);
  writeFileSync(resolve(directory, '.env'), content, { mode: 0o600, flag: 'wx' });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { initializeEnv(); console.log('Created private .env with generated database and session secrets. Configure OAuth before enabling sign-in.'); }
  catch (error) {
    console.error(error.code === 'EEXIST' ? '.env already exists; left unchanged. Existing database passwords require coordinated rotation.' : 'Could not initialize .env; check the template and file permissions.');
    process.exitCode = 1;
  }
}
