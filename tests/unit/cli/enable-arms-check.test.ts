/**
 * tests/unit/cli/enable-arms-check.test.ts
 *
 * The warning printed at the moment an agent is enabled or started, when its next boot would
 * silently overwrite crons.json from config.json.
 *
 * These assert on the OUTPUT, not just the predicate. `wipeConditionArmed` is unit-tested
 * separately in tests/unit/daemon/cron-drift.test.ts; what is untested there — and what actually
 * fails in practice — is a correct predicate wired to a warning nobody sees. Loaded is not
 * exercised.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { warnIfWipeArmed } from '../../../src/cli/enable-arms-check';

describe('warnIfWipeArmed', () => {
  const AGENT = 'zz_probe';
  let tmp: string;
  let stderr: string[];
  let spy: ReturnType<typeof vi.spyOn>;

  const stateDir = () => join(tmp, '.cortextOS', 'state', 'agents', AGENT);

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'armscheck-'));
    mkdirSync(stateDir(), { recursive: true });
    stderr = [];
    spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      stderr.push(args.join(' '));
    });
  });

  afterEach(() => {
    spy.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
  });

  function seedCrons(names: string[]): void {
    writeFileSync(
      join(stateDir(), 'crons.json'),
      JSON.stringify({ crons: names.map((name) => ({ name })) }),
      'utf-8',
    );
  }

  it('WARNS and names every cron that would be lost', () => {
    seedCrons(['unified-watchdog', 'liveness-poke']); // no marker => armed
    warnIfWipeArmed(AGENT, tmp);
    const out = stderr.join('\n');
    expect(out).toContain('WARNING');
    expect(out).toContain('unified-watchdog');
    expect(out).toContain('liveness-poke');
    // Names the remedy, not just the problem. A warning that does not say what to do gets ignored.
    expect(out).toContain('.crons-migrated');
  });

  it('SAYS IT IS NOT BLOCKING — an operator who reads this must not think the start failed', () => {
    seedCrons(['x']);
    warnIfWipeArmed(AGENT, tmp);
    expect(stderr.join('\n')).toContain('Not blocking');
  });

  it('is COMPLETELY SILENT when the marker is present — the normal case for every live agent', () => {
    // The clean direction is the one that decides whether this is usable. A warning that fires on
    // every start is one the operator learns to scroll past, which is how the real one gets missed.
    seedCrons(['x']);
    writeFileSync(join(stateDir(), '.crons-migrated'), '', 'utf-8');
    warnIfWipeArmed(AGENT, tmp);
    expect(stderr).toEqual([]);
  });

  it('is silent for an agent with no state directory at all (a brand-new agent)', () => {
    warnIfWipeArmed('never_seen_agent', tmp);
    expect(stderr).toEqual([]);
  });

  it('never throws on an unreadable ctxRoot — a diagnostic must not break an enable', () => {
    expect(() => warnIfWipeArmed(AGENT, join(tmp, 'does', 'not', 'exist'))).not.toThrow();
    expect(stderr).toEqual([]);
  });
});
