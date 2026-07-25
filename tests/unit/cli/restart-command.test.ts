/**
 * Unit-test parity for the `cortextos restart <agent>` subcommand
 * (issue #328). Companion to lifecycle-markers.test.ts which already
 * covers writeStopMarker — restart re-uses that helper, so this file
 * pins the command-level wiring (name, required argument, --instance
 * option, description) instead of duplicating the marker-write tests.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import {
  DAEMON_RESTART_TIMEOUT_MS,
  DAEMON_STOP_TIMEOUT_MS,
  daemonRestartResultPath,
  exactProcessGenerationIsGone,
  pm2SupervisorSlotIsQuiescent,
  quoteWindowsCommandLineArg,
  restartCommand,
  windowsCimLauncherScript,
} from '../../../src/cli/restart';
import { inspectProcessIdentity } from '../../../src/utils/process-ownership';

describe('issue #328: cortextos restart <agent>', () => {
  it('is registered as `restart`', () => {
    expect(restartCommand.name()).toBe('restart');
  });

  it('accepts an optional agent so --daemon can select daemon restart', () => {
    // commander stores arg metadata on _args / registeredArguments depending on
    // version; both expose .required on the registered argument.
    const args = (restartCommand as unknown as { registeredArguments: { required: boolean; name: () => string }[] }).registeredArguments;
    expect(args).toHaveLength(1);
    expect(args[0].required).toBe(false);
    expect(args[0].name()).toBe('agent');
  });

  it('accepts --instance with a default of "default"', () => {
    const opts = restartCommand.opts();
    expect(opts.instance).toBe('default');
  });

  it('exposes the Windows-safe daemon restart mode', () => {
    expect(restartCommand.options.some(option => option.long === '--daemon')).toBe(true);
  });

  it('waits longer than the configured 60-second PM2 kill timeout', () => {
    expect(DAEMON_STOP_TIMEOUT_MS).toBeGreaterThan(60_000);
    expect(DAEMON_RESTART_TIMEOUT_MS).toBeGreaterThan(DAEMON_STOP_TIMEOUT_MS);
  });

  it('accepts PM2 waiting-restart only after the supervised PID is gone', () => {
    expect(pm2SupervisorSlotIsQuiescent({
      name: 'cortextos-daemon-default',
      status: 'waiting restart',
    })).toBe(true);
    expect(pm2SupervisorSlotIsQuiescent({
      name: 'cortextos-daemon-default',
      status: 'waiting restart',
      pid: 123,
    })).toBe(false);
    expect(pm2SupervisorSlotIsQuiescent({
      name: 'cortextos-daemon-default',
      status: 'online',
    })).toBe(false);
  });

  it('warns operators away from direct PM2 restart', () => {
    // The description must make clear this does NOT bounce the daemon —
    // operator-facing UX guard so users don't reach for this when they
    // need a daemon bounce and might otherwise reach for direct PM2 restart.
    const desc = restartCommand.description().toLowerCase();
    expect(desc).toContain('unsafe');
    expect(desc).toContain('daemon');
  });

  it('waits for the exact daemon process generation, not only its PID', () => {
    const current = inspectProcessIdentity(process.pid);
    expect(current).not.toBeNull();
    expect(exactProcessGenerationIsGone(current!)).toBe(false);
    expect(exactProcessGenerationIsGone({
      ...current!,
      startIdentity: `${current!.startIdentity}-old-generation`,
    })).toBe(true);
  });

  it('fresh-registers the stopped daemon before starting the replacement', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'cli', 'restart.ts'), 'utf-8');
    expect(source).toMatch(/runPm2\(\['stop', appName\][\s\S]*runPm2\(\['delete', appName\][\s\S]*runPm2\(\['start', ecosystemPath/);
  });

  it('delegates daemon restart coordination outside the daemon process tree', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'cli', 'restart.ts'), 'utf-8');
    expect(source).toContain("join(projectRoot, 'dist', 'daemon-restart-helper.js')");
    expect(source).toContain('Invoke-CimMethod -ClassName Win32_Process -MethodName Create');
    expect(source).not.toMatch(/async function requestDaemonRestart[\s\S]*runPm2\(\['stop', appName\]/);
  });

  it('quotes Windows helper command arguments without losing trailing slashes or quotes', () => {
    expect(quoteWindowsCommandLineArg('C:\\Program Files\\nodejs\\node.exe'))
      .toBe('"C:\\Program Files\\nodejs\\node.exe"');
    expect(quoteWindowsCommandLineArg('plain')).toBe('plain');
    expect(quoteWindowsCommandLineArg('a"b')).toBe('"a\\"b"');
    expect(quoteWindowsCommandLineArg('C:\\path with space\\'))
      .toBe('"C:\\path with space\\\\"');
  });

  it('builds a CIM launcher that fails closed when process creation fails', () => {
    const script = windowsCimLauncherScript('"C:\\Program Files\\node.exe" helper.js');
    expect(script).toContain('Win32_Process');
    expect(script).toContain('ReturnValue -ne 0');
    expect(script).toContain('ProcessId');
  });

  it('uses a scoped durable result path and rejects malformed request IDs', () => {
    expect(daemonRestartResultPath('default', '12345678-1234-1234-1234-123456789abc'))
      .toContain(join('.cortextos', 'default', 'state', 'daemon-restarts'));
    expect(() => daemonRestartResultPath('default', '..\\escape')).toThrow('Invalid daemon restart request ID');
  });

  it('builds the restart helper as a standalone entrypoint', () => {
    const source = readFileSync(join(process.cwd(), 'tsup.config.ts'), 'utf-8');
    expect(source).toContain("'daemon-restart-helper': 'src/daemon-restart-helper.ts'");
  });
});
