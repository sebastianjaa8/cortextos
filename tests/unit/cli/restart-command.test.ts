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
  DAEMON_STOP_TIMEOUT_MS,
  exactProcessGenerationIsGone,
  pm2SupervisorSlotIsQuiescent,
  restartCommand,
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
});
