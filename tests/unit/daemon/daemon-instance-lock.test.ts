import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const daemonModule = await import('../../../src/daemon/index.js') as Record<string, unknown>;
const roots: string[] = [];

afterEach(() => {
  const release = daemonModule.releaseDaemonInstanceLock as ((ctxRoot: string) => void) | undefined;
  for (const root of roots.splice(0)) {
    release?.(root);
    rmSync(root, { recursive: true, force: true });
  }
});

describe('daemon instance lock', () => {
  it('allows only one live daemon per ctx root', () => {
    const acquire = daemonModule.acquireDaemonInstanceLock as
      | ((ctxRoot: string) => boolean)
      | undefined;
    expect(acquire).toBeTypeOf('function');

    const root = mkdtempSync(join(tmpdir(), 'cortextos-daemon-lock-'));
    roots.push(root);

    expect(acquire!(root)).toBe(true);
    expect(acquire!(root)).toBe(false);
  });

  it('detects when PM2 no longer supervises the current daemon generation', () => {
    const ownsCurrentProcess = daemonModule.pm2SupervisorOwnsCurrentProcess as
      | ((env: NodeJS.ProcessEnv, pid: number) => boolean | undefined)
      | undefined;
    expect(ownsCurrentProcess).toBeTypeOf('function');

    const root = mkdtempSync(join(tmpdir(), 'cortextos-pm2-fence-'));
    roots.push(root);
    const pidPath = join(root, 'daemon.pid');

    writeFileSync(pidPath, '1234', 'utf-8');
    expect(ownsCurrentProcess!({ pm_pid_path: pidPath }, 1234)).toBe(true);

    writeFileSync(pidPath, '5678', 'utf-8');
    expect(ownsCurrentProcess!({ pm_pid_path: pidPath }, 1234)).toBe(false);

    writeFileSync(pidPath, '1234-invalid', 'utf-8');
    expect(ownsCurrentProcess!({ pm_pid_path: pidPath }, 1234)).toBe(false);
    expect(ownsCurrentProcess!({ pm_pid_path: join(root, 'missing.pid') }, 1234)).toBe(false);
    expect(ownsCurrentProcess!({}, 1234)).toBeUndefined();
  });
});

describe('daemon fatal exit code', () => {
  it('maps a duplicate-daemon lock conflict to the PM2 stop_exit_codes value', () => {
    const exitCodeFor = daemonModule.daemonFatalExitCode as ((msg: string) => number);
    const terminal = daemonModule.DAEMON_EXIT_LOCK_CONFLICT as number;

    // Must match ecosystem.config.js stop_exit_codes, or PM2 respawns forever.
    expect(terminal).toBe(2);
    expect(exitCodeFor('Another cortextOS daemon is already running for instance "default"')).toBe(terminal);
    // Every other startup failure stays retryable.
    expect(exitCodeFor('ECONNREFUSED talking to Telegram')).toBe(1);
  });
});
