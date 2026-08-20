/**
 * `cortextos bus list-experiments --json` with no --agent — task_1787184346930.
 *
 * Recurring bug, flagged 08-13 and again 08-20: omitting --agent silently
 * scoped results to the CALLER's own directory only, because listExperiments()
 * (src/bus/experiment.ts) only ever reads the ONE directory it is given — there
 * was never a fleet-scan branch. seb_boss's own run read "5 experiments, 0
 * running" on a day the real fleet total was 24 experiments, 5 running.
 *
 * ISOLATION NOTE: same throwaway-CTX_INSTANCE_ID + real CTX_FRAMEWORK_ROOT
 * strategy as assignee-alias-and-notify.test.ts — exercises the CLI's real
 * fleet-enumeration logic end to end, not listExperiments() directly (that
 * function's own unit tests already live in tests/sprint3-experiments.test.ts
 * and are untouched by this fix).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { busCommand } from '../../../src/cli/bus';
import { createExperiment } from '../../../src/bus/experiment';

const ORG = 'testorg';

let instanceId: string;
let frameworkRoot: string;
const originalEnv = {
  CTX_INSTANCE_ID: process.env.CTX_INSTANCE_ID,
  CTX_AGENT_NAME: process.env.CTX_AGENT_NAME,
  CTX_ORG: process.env.CTX_ORG,
  CTX_FRAMEWORK_ROOT: process.env.CTX_FRAMEWORK_ROOT,
  // Both must be cleared, not just left inherited: resolveEnv's sandbox-leak
  // guard (env.ts) refuses to run when CTX_AGENT_DIR/CTX_PROJECT_ROOT are
  // inherited from the REAL live session (this agent's own actual dir) while
  // CTX_FRAMEWORK_ROOT points at a temp test dir -- exactly what this test
  // needs to do to exercise fleet-wide enumeration in isolation.
  CTX_AGENT_DIR: process.env.CTX_AGENT_DIR,
  CTX_PROJECT_ROOT: process.env.CTX_PROJECT_ROOT,
};

function agentDir(name: string): string {
  return join(frameworkRoot, 'orgs', ORG, 'agents', name);
}

function seedExperiment(
  agent: string,
  metric: string,
  status: 'proposed' | 'running' | 'completed' = 'proposed',
  createdAt?: string,
) {
  mkdirSync(join(agentDir(agent), 'experiments', 'history'), { recursive: true });
  const id = createExperiment(agentDir(agent), agent, metric, `hypothesis for ${metric}`);
  if (status !== 'proposed' || createdAt) {
    const filePath = join(agentDir(agent), 'experiments', 'history', `${id}.json`);
    const raw = JSON.parse(require('fs').readFileSync(filePath, 'utf-8'));
    if (status !== 'proposed') raw.status = status;
    if (createdAt) raw.created_at = createdAt;
    writeFileSync(filePath, JSON.stringify(raw, null, 2), 'utf-8');
  }
  return id;
}

async function runListExperiments(extraArgs: string[] = []): Promise<any[]> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  await busCommand.parseAsync(['node', 'cli', 'list-experiments', ...extraArgs]);
  const output = logSpy.mock.calls.map((c) => String(c[0])).join('');
  logSpy.mockRestore();
  return JSON.parse(output);
}

beforeEach(() => {
  instanceId = `test-list-exp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  frameworkRoot = mkdtempSync(join(tmpdir(), 'list-exp-fw-'));
  process.env.CTX_INSTANCE_ID = instanceId;
  process.env.CTX_AGENT_NAME = 'caller';
  process.env.CTX_ORG = ORG;
  process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;
  delete process.env.CTX_AGENT_DIR;
  delete process.env.CTX_PROJECT_ROOT;
  // The caller's OWN dir, with the fleet-wide bug reproduced by an ALMOST-EMPTY
  // caller directory sitting alongside two other agents with real experiments.
  mkdirSync(join(agentDir('caller'), 'experiments', 'history'), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalEnv.CTX_INSTANCE_ID !== undefined) process.env.CTX_INSTANCE_ID = originalEnv.CTX_INSTANCE_ID;
  else delete process.env.CTX_INSTANCE_ID;
  if (originalEnv.CTX_AGENT_NAME !== undefined) process.env.CTX_AGENT_NAME = originalEnv.CTX_AGENT_NAME;
  else delete process.env.CTX_AGENT_NAME;
  if (originalEnv.CTX_ORG !== undefined) process.env.CTX_ORG = originalEnv.CTX_ORG;
  else delete process.env.CTX_ORG;
  if (originalEnv.CTX_FRAMEWORK_ROOT !== undefined) process.env.CTX_FRAMEWORK_ROOT = originalEnv.CTX_FRAMEWORK_ROOT;
  else delete process.env.CTX_FRAMEWORK_ROOT;
  if (originalEnv.CTX_AGENT_DIR !== undefined) process.env.CTX_AGENT_DIR = originalEnv.CTX_AGENT_DIR;
  else delete process.env.CTX_AGENT_DIR;
  if (originalEnv.CTX_PROJECT_ROOT !== undefined) process.env.CTX_PROJECT_ROOT = originalEnv.CTX_PROJECT_ROOT;
  else delete process.env.CTX_PROJECT_ROOT;
  try { rmSync(frameworkRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('list-experiments fleet-wide default', () => {
  it('MUST-FAIL CASE: omitting --agent aggregates every agent, not just the caller', async () => {
    seedExperiment('alpha', 'ctr', 'running');
    seedExperiment('beta', 'latency', 'running');
    seedExperiment('beta', 'cost', 'completed');
    // caller itself has ZERO experiments -- the exact shape of the real incident:
    // a caller with few/no experiments of its own silently reading as "the fleet".

    const results = await runListExperiments();

    expect(results).toHaveLength(3);
    const agents = new Set(results.map((r) => r.agent));
    expect(agents).toEqual(new Set(['alpha', 'beta']));
  });

  it('PAIRED NEGATIVE: --agent <name> still scopes to exactly one agent (unchanged behavior)', async () => {
    seedExperiment('alpha', 'ctr', 'running');
    seedExperiment('beta', 'latency', 'running');

    const results = await runListExperiments(['--agent', 'alpha']);

    expect(results).toHaveLength(1);
    expect(results[0].agent).toBe('alpha');
  });

  it('fleet-wide scan still applies --status and --metric filters across all agents', async () => {
    seedExperiment('alpha', 'ctr', 'running');
    seedExperiment('alpha', 'ctr', 'completed');
    seedExperiment('beta', 'ctr', 'running');
    seedExperiment('beta', 'latency', 'running');

    const running = await runListExperiments(['--status', 'running']);
    expect(running).toHaveLength(3);
    expect(running.every((r) => r.status === 'running')).toBe(true);

    const ctrOnly = await runListExperiments(['--metric', 'ctr']);
    expect(ctrOnly).toHaveLength(3);
    expect(ctrOnly.every((r) => r.metric === 'ctr')).toBe(true);
  });

  it('an agent with no experiments/history dir at all does not break the fleet scan', async () => {
    // 'gamma' exists as a directory but never ran createExperiment -- historyDir()
    // read fails with ENOENT internally and listExperiments() already returns [].
    mkdirSync(agentDir('gamma'), { recursive: true });
    seedExperiment('alpha', 'ctr', 'running');

    const results = await runListExperiments();

    expect(results).toHaveLength(1);
    expect(results[0].agent).toBe('alpha');
  });

  it('sorts fleet-wide results by created_at desc, same as the single-agent path', async () => {
    // created_at is second-precision (nowISO() strips milliseconds), so real
    // wall-clock gaps between calls in a fast test aren't reliably distinct --
    // set explicit, guaranteed-ordered timestamps instead of racing the clock.
    seedExperiment('alpha', 'first', 'proposed', '2026-01-01T00:00:01Z');
    seedExperiment('beta', 'second', 'proposed', '2026-01-01T00:00:02Z');
    seedExperiment('alpha', 'third', 'proposed', '2026-01-01T00:00:03Z');

    const results = await runListExperiments();

    expect(results.map((r) => r.metric)).toEqual(['third', 'second', 'first']);
  });
});
