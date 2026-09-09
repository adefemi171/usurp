import { describe, it, expect } from 'vitest';
import { mkdtempSync, copyFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeEnv } from './init-env.mjs';
describe('new-install secret setup', () => {
  it('generates consistent private credentials and refuses to overwrite them', () => {
    const dir = mkdtempSync(join(tmpdir(),'usurp-env-test-'));
    try {
      copyFileSync('.env.example',join(dir,'.env.example'));
      initializeEnv(dir);
      const text = readFileSync(join(dir,'.env'),'utf8');
      const password = /^POSTGRES_PASSWORD=(.+)$/m.exec(text)![1];
      expect(password).toMatch(/^[a-f0-9]{64}$/);
      expect(new URL(/^DATABASE_URL=(.+)$/m.exec(text)![1]).password).toBe(password);
      expect(statSync(join(dir,'.env')).mode & 0o777).toBe(0o600);
      expect(() => initializeEnv(dir)).toThrow();
      expect(readFileSync(join(dir,'.env'),'utf8')).toBe(text);
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });
});
