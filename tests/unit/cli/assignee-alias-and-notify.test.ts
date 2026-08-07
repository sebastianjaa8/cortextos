/**
 * tests/unit/cli/assignee-alias-and-notify.test.ts
 *
 * Two fixes shipped together because they share the same CLI surface:
 *
 * 1. task_1785781068786_36016190 — the CLI option was `--assignee`, the stored field is
 *    `assigned_to`. A filter on the CLI's own word (`assignee`) returned zero rows and read
 *    exactly like an empty queue. FIX: `--assigned-to` is now the canonical flag (matches the
 *    stored field), `--assignee` stays as a working alias — it is in prompts, scripts and habits
 *    fleet-wide, and breaking it converts a silent query bug into a loud dispatch bug.
 *
 * 2. task_1785781154932_38520243 — `update-task --assignee` reassigned a task and told nobody.
 *    `create-task --assignee` already auto-notifies (issue #78); the update path had no
 *    equivalent. FIX: update-task notifies the new owner, guarded the same way create-task's own
 *    notify is (never message yourself), and only fires when a real reassignment happened.
 *
 * ISOLATION NOTE: `resolvePaths()` (src/utils/paths.ts) computes `join(homedir(), '.cortextos',
 * instanceId)` directly — it does NOT read `process.env.CTX_ROOT`. Every other task/message test
 * in this repo (task.test.ts, lifecycle.test.ts) works around this by building `BusPaths`
 * manually and calling the underlying functions directly, bypassing Commander entirely. That
 * approach cannot exercise the CLI's own flag-parsing (the thing actually under test here — does
 * `--assigned-to` parse to the same place `--assignee` used to?), so this file instead isolates
 * via a throwaway `CTX_INSTANCE_ID` under the REAL home directory and removes it in `afterEach`,
 * the same "full CLI-to-disk path" strategy bus-crons.test.ts already uses for the crons surface.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { busCommand } from '../../../src/cli/bus';
import { resolvePaths } from '../../../src/utils/paths';

const ORG = 'testorg';
const CALLER = 'caller';
const OTHER = 'otheragent';

let instanceId: string;
let ctxRoot: string;
const originalEnv = {
  CTX_INSTANCE_ID: process.env.CTX_INSTANCE_ID,
  CTX_AGENT_NAME: process.env.CTX_AGENT_NAME,
  CTX_ORG: process.env.CTX_ORG,
};

function taskFile(id: string): Record<string, unknown> {
  const paths = resolvePaths(CALLER, instanceId, ORG);
  return JSON.parse(readFileSync(join(paths.taskDir, `${id}.json`), 'utf-8'));
}

function inboxMessages(agent: string): Array<Record<string, unknown>> {
  const paths = resolvePaths(agent, instanceId, ORG);
  if (!existsSync(paths.inbox)) return [];
  return readdirSync(paths.inbox)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(paths.inbox, f), 'utf-8')));
}

beforeEach(() => {
  // Real Date.now()/Math.random() (this is test code, not a Workflow script) — unique per run so
  // parallel test files never collide on the same home-directory subtree.
  instanceId = `test-assignee-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  ctxRoot = join(homedir(), '.cortextos', instanceId);
  process.env.CTX_INSTANCE_ID = instanceId;
  process.env.CTX_AGENT_NAME = CALLER;
  process.env.CTX_ORG = ORG;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalEnv.CTX_INSTANCE_ID !== undefined) process.env.CTX_INSTANCE_ID = originalEnv.CTX_INSTANCE_ID;
  else delete process.env.CTX_INSTANCE_ID;
  if (originalEnv.CTX_AGENT_NAME !== undefined) process.env.CTX_AGENT_NAME = originalEnv.CTX_AGENT_NAME;
  else delete process.env.CTX_AGENT_NAME;
  if (originalEnv.CTX_ORG !== undefined) process.env.CTX_ORG = originalEnv.CTX_ORG;
  else delete process.env.CTX_ORG;
  try { rmSync(ctxRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function createTaskViaCli(title: string, extra: string[]): Promise<string> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  await busCommand.parseAsync(['node', 'cli', 'create-task', title, ...extra]);
  // create-task's ONLY stdout line is the bare task id (callers do `TASK_ID=$(... create-task)`).
  const id = String(logSpy.mock.calls[0][0]);
  logSpy.mockRestore();
  return id;
}

describe('create-task: --assigned-to / --assignee alias', () => {
  it('--assigned-to sets assigned_to and auto-notifies (canonical flag)', async () => {
    const id = await createTaskViaCli('T1', ['--assigned-to', OTHER]);
    expect(taskFile(id).assigned_to).toBe(OTHER);
    const msgs = inboxMessages(OTHER);
    expect(msgs).toHaveLength(1);
    expect(String(msgs[0].text)).toContain(id);
  });

  it('--assignee still works identically (compat alias, must not break)', async () => {
    const id = await createTaskViaCli('T2', ['--assignee', OTHER]);
    expect(taskFile(id).assigned_to).toBe(OTHER);
    expect(inboxMessages(OTHER)).toHaveLength(1);
  });

  it('defaults to the caller when neither flag is given (unchanged behavior)', async () => {
    const id = await createTaskViaCli('T3', []);
    expect(taskFile(id).assigned_to).toBe(CALLER);
    expect(inboxMessages(CALLER)).toHaveLength(0); // create-task never notifies yourself
  });
});

describe('update-task: --assigned-to / --assignee alias + reassignment notify', () => {
  it('MUST-FAIL CASE: --assigned-to reassigns to someone else and they receive a message naming the task id', async () => {
    const id = await createTaskViaCli('T4', []); // assigned to CALLER, no notify yet
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await busCommand.parseAsync(['node', 'cli', 'update-task', id, 'in_progress', '--assigned-to', OTHER]);
    logSpy.mockRestore();

    expect(taskFile(id).assigned_to).toBe(OTHER);
    const msgs = inboxMessages(OTHER);
    expect(msgs).toHaveLength(1);
    expect(String(msgs[0].text)).toContain(id);
  });

  it('--assignee (old flag) still reassigns and still notifies', async () => {
    const id = await createTaskViaCli('T5', []);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await busCommand.parseAsync(['node', 'cli', 'update-task', id, 'in_progress', '--assignee', OTHER]);
    logSpy.mockRestore();

    expect(taskFile(id).assigned_to).toBe(OTHER);
    expect(inboxMessages(OTHER)).toHaveLength(1);
  });

  it('PAIRED NEGATIVE: reassigning TO YOURSELF must NOT notify, even on a REAL change of owner', async () => {
    // Real change (OTHER -> CALLER), not a no-op — the thing that must suppress the message is
    // the self-guard, not the "nothing changed" check. If the guard were missing, this reclaim
    // would emit a message from CALLER to CALLER.
    const id = await createTaskViaCli('T6', ['--assigned-to', OTHER]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await busCommand.parseAsync(['node', 'cli', 'update-task', id, 'in_progress', '--assigned-to', CALLER]);
    logSpy.mockRestore();

    expect(taskFile(id).assigned_to).toBe(CALLER); // the reassignment DID happen
    expect(inboxMessages(CALLER)).toHaveLength(0); // and nobody messaged themselves about it
  });

  it('PAIRED NEGATIVE: an update with no --assigned-to/--assignee emits nothing at all', async () => {
    const id = await createTaskViaCli('T7', ['--assigned-to', OTHER]);
    const before = inboxMessages(OTHER).length;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await busCommand.parseAsync(['node', 'cli', 'update-task', id, 'in_progress']); // status-only
    logSpy.mockRestore();

    expect(inboxMessages(OTHER)).toHaveLength(before); // unchanged — no new reassign message
  });

  it('a no-op reassignment (same value as the current owner) does not notify twice', async () => {
    const id = await createTaskViaCli('T8', ['--assigned-to', OTHER]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await busCommand.parseAsync(['node', 'cli', 'update-task', id, 'in_progress', '--assigned-to', OTHER]);
    logSpy.mockRestore();

    expect(inboxMessages(OTHER)).toHaveLength(1); // still just the create-time notify
  });
});
