/**
 * tests/integration/complete-task-graceful-error.test.ts
 *
 * Regression test for: `bus complete-task`/`bus update-task` on an unknown
 * or short-form (truncated) task ID crashed the whole Node process with an
 * uncaught exception + raw stack trace instead of a clean CLI error. Root
 * cause: the action handlers for these two commands called completeTask()/
 * updateTask() directly with no try/catch, unlike the sibling claim-task
 * command which already wraps its call correctly.
 *
 * Drives the compiled dist/cli.js directly so it exercises the real CLI
 * wiring, not just the underlying library function (which was always
 * correct — it's supposed to throw; the CLI layer just needs to catch it).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const REPO_ROOT = join(__dirname, '..', '..');
const DIST_CLI = join(REPO_ROOT, 'dist', 'cli.js');

let ctxRoot: string;

beforeEach(() => {
  ctxRoot = mkdtempSync(join(tmpdir(), 'complete-task-graceful-'));
});

afterEach(() => {
  try { rmSync(ctxRoot, { recursive: true }); } catch { /* ignore */ }
});

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const {
    CTX_AGENT_DIR,
    CTX_AGENT_NAME,
    CTX_ORG,
    CTX_PROJECT_ROOT,
    ...baseEnv
  } = process.env;
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [DIST_CLI, 'bus', ...args],
      {
        env: {
          ...baseEnv,
          CTX_FRAMEWORK_ROOT: ctxRoot,
          CTX_PROJECT_ROOT: ctxRoot,
          CTX_ROOT: ctxRoot,
          CTX_ORG: 'testorg',
          CTX_AGENT_NAME: 'testagent',
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

describe.skipIf(!existsSync(DIST_CLI))('bus complete-task / update-task graceful errors', () => {
  it('complete-task on an unknown task id exits 1 with a clean message, not a stack trace', async () => {
    const { stderr, code } = await runCli(['complete-task', 'task_nonexistent_000', '--result', 'test']);
    expect(code).toBe(1);
    expect(stderr).toContain('not found in any org under');
    expect(stderr).not.toContain('at completeTask');
    expect(stderr).not.toContain('Node.js v');
  });

  it('complete-task on a short-form (truncated) task id exits 1 with a clean message', async () => {
    const { stderr, code } = await runCli(['complete-task', 'task_1784204566110']);
    expect(code).toBe(1);
    expect(stderr).toContain('not found in any org under');
    expect(stderr).not.toContain('at completeTask');
  });

  it('update-task on an unknown task id exits 1 with a clean message, not a stack trace', async () => {
    const { stderr, code } = await runCli(['update-task', 'task_nonexistent_000', 'completed']);
    expect(code).toBe(1);
    expect(stderr).toContain('not found in any org under');
    expect(stderr).not.toContain('at updateTask');
    expect(stderr).not.toContain('Node.js v');
  });
});
