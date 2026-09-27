/**
 * tests/integration/task-audit-attribution-cli.test.ts (task_1785666339329, 2026-09-27)
 *
 * CLI-level attribution test, per Codex plan review requirement #4: a library-level test
 * (tests/unit/bus/task.test.ts) proves the fallback logic works, but not that the CLI actually
 * supplies `callerAgent` from `resolveEnv().agentName` — that wiring is the actual production
 * defect (src/cli/bus.ts previously never passed caller identity to updateTask/completeTask at
 * all). Drives the compiled dist/cli.js directly, same pattern as
 * complete-task-graceful-error.test.ts.
 *
 * ISOLATION NOTE: resolvePaths() (src/utils/paths.ts) resolves `ctxRoot` from `homedir()` +
 * `CTX_INSTANCE_ID`, NOT from a `CTX_ROOT` env var — setting `CTX_ROOT` in the spawned env (as
 * the sibling graceful-error test does) does not actually isolate task storage. This test uses a
 * unique `CTX_INSTANCE_ID` per run instead, which resolveEnv() does honor, and cleans up the real
 * `~/.cortextos/<instanceId>` directory it creates.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomBytes } from 'crypto';

const execFileAsync = promisify(execFile);

const REPO_ROOT = join(__dirname, '..', '..');
const DIST_CLI = join(REPO_ROOT, 'dist', 'cli.js');

let instanceId: string;
let ctxRoot: string;

beforeEach(() => {
  instanceId = `task-audit-cli-${randomBytes(6).toString('hex')}`;
  ctxRoot = join(homedir(), '.cortextos', instanceId);
});

afterEach(() => {
  try { rmSync(ctxRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function runCli(
  args: string[],
  callerAgent: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const {
    CTX_AGENT_DIR,
    CTX_AGENT_NAME,
    CTX_ORG,
    CTX_PROJECT_ROOT,
    CTX_ROOT,
    CTX_INSTANCE_ID,
    ...baseEnv
  } = process.env;
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [DIST_CLI, 'bus', ...args],
      {
        env: {
          ...baseEnv,
          CTX_ORG: 'testorg',
          CTX_AGENT_NAME: callerAgent,
          CTX_INSTANCE_ID: instanceId,
        },
      },
    );
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      code: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

function readAudit(taskId: string): Array<Record<string, unknown>> {
  const auditPath = join(ctxRoot, 'orgs', 'testorg', 'tasks', 'audit', `${taskId}.jsonl`);
  const raw = readFileSync(auditPath, 'utf-8');
  return raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

describe.skipIf(!existsSync(DIST_CLI))('bus update-task / complete-task audit attribution (real CLI)', () => {
  it('update-task records the CALLER in the audit log, not the assignee', async () => {
    const { stdout: createOut, code: createCode } = await runCli(
      ['create-task', 'attribution test', '--assignee', 'assignee_agent'],
      'assignor_agent',
    );
    expect(createCode).toBe(0);
    const taskId = createOut.trim();
    expect(taskId).toMatch(/^task_/);

    const { code: updateCode } = await runCli(['update-task', taskId, 'in_progress'], 'caller_agent');
    expect(updateCode).toBe(0);

    const audit = readAudit(taskId).find((e) => e.event === 'update');
    expect(audit?.agent).toBe('caller_agent');
    expect(audit?.agent).not.toBe('assignee_agent');
  });

  it('complete-task records the CALLER in the audit log, not the assignee', async () => {
    const { stdout: createOut, code: createCode } = await runCli(
      ['create-task', 'attribution test 2', '--assignee', 'assignee_agent'],
      'assignor_agent',
    );
    expect(createCode).toBe(0);
    const taskId = createOut.trim();

    const { code: completeCode } = await runCli(
      ['complete-task', taskId, '--result', 'done', '--evidence', 'test'],
      'closer_agent',
    );
    expect(completeCode).toBe(0);

    const audit = readAudit(taskId).find((e) => e.event === 'complete');
    expect(audit?.agent).toBe('closer_agent');
    expect(audit?.agent).not.toBe('assignee_agent');
  });
});
