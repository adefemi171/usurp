import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  backup: { ok: true, completedAt: '', file: 'test.dump.gpg' },
  restore: { ok: true, completedAt: '' },
  writes: vi.fn(), notification: vi.fn(),
}));
vi.mock('node:os', () => ({ homedir: () => '/isolated-backup-test' }));
vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(), chmodSync: vi.fn(), existsSync: () => true,
  readdirSync: () => [], writeFileSync: state.writes,
  readFileSync: (path: string) => JSON.stringify(path.endsWith('latest-backup.json') ? state.backup : state.restore),
}));
vi.mock('node:child_process', () => ({ execFileSync: vi.fn(), spawnSync: state.notification }));
const previousExitCode = process.exitCode;
afterEach(() => { process.exitCode = previousExitCode; vi.restoreAllMocks(); });

it.each(['fresh', 'backup-stale', 'restore-stale', 'backup-failed', 'restore-failed'])(
  'backup monitoring handles %s without touching real files or network', async mode => {
    vi.resetModules(); state.writes.mockClear(); state.notification.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const now = new Date().toISOString();
    state.backup = { ok: mode !== 'backup-failed', completedAt: mode === 'backup-stale' ? '2000-01-01T00:00:00Z' : now, file: 'test.dump.gpg' };
    state.restore = { ok: mode !== 'restore-failed', completedAt: mode === 'restore-stale' ? '2000-01-01T00:00:00Z' : now };
    await import('../deploy/database/mac-backup.mjs');
    const result = JSON.parse(state.writes.mock.calls.at(-1)![1]);
    expect(result.ok).toBe(mode === 'fresh');
    expect(state.notification).toHaveBeenCalledTimes(mode === 'fresh' ? 0 : 1);
    if (mode !== 'fresh') {
      expect(process.exitCode).toBe(1);
      expect(state.notification.mock.calls[0][0]).toBe('/usr/bin/osascript');
      expect(state.notification.mock.calls[0][1][1]).toContain('Usurp backup needs attention');
    }
  },
);
