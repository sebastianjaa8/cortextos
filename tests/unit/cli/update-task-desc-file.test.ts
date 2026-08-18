/**
 * `cortextos bus update-task <id> <status> --desc-file <path>` — task_1785687530533.
 *
 * A 33,994-char `--desc` argv failed SILENTLY on Windows (CreateProcess argv ceiling,
 * ~32k): the CLI printed "No error" and the description stayed unchanged, at exit 0
 * (until an unrelated --force-empty change gave update-task a real exit code path). That
 * failure happens in the OS before this process even starts -- it cannot be caught or
 * reported from inside update-task's action handler, so no amount of in-process error
 * handling on the --desc path can fix it. --desc-file sidesteps the ceiling entirely by
 * reading the description from a file instead of putting it on the command line.
 *
 * ISOLATION NOTE: same throwaway-CTX_INSTANCE_ID strategy as
 * assignee-alias-and-notify.test.ts -- exercises the CLI's real flag parsing end to end,
 * not the underlying updateTask() function directly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { busCommand } from '../../../src/cli/bus';
import { resolvePaths } from '../../../src/utils/paths';

const ORG = 'testorg';
const CALLER = 'caller';

let instanceId: string;
let descFileDir: string;
const originalEnv = {
  CTX_INSTANCE_ID: process.env.CTX_INSTANCE_ID,
  CTX_AGENT_NAME: process.env.CTX_AGENT_NAME,
  CTX_ORG: process.env.CTX_ORG,
};

function taskFile(id: string): Record<string, unknown> {
  const paths = resolvePaths(CALLER, instanceId, ORG);
  return JSON.parse(readFileSync(join(paths.taskDir, `${id}.json`), 'utf-8'));
}

function spyExitAndError() {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__TEST_PROCESS_EXIT_${code}__`);
  }) as never);
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  return { exitSpy, consoleErrorSpy };
}

beforeEach(() => {
  instanceId = `test-desc-file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  process.env.CTX_INSTANCE_ID = instanceId;
  process.env.CTX_AGENT_NAME = CALLER;
  process.env.CTX_ORG = ORG;
  descFileDir = mkdtempSync(join(tmpdir(), 'desc-file-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalEnv.CTX_INSTANCE_ID !== undefined) process.env.CTX_INSTANCE_ID = originalEnv.CTX_INSTANCE_ID;
  else delete process.env.CTX_INSTANCE_ID;
  if (originalEnv.CTX_AGENT_NAME !== undefined) process.env.CTX_AGENT_NAME = originalEnv.CTX_AGENT_NAME;
  else delete process.env.CTX_AGENT_NAME;
  if (originalEnv.CTX_ORG !== undefined) process.env.CTX_ORG = originalEnv.CTX_ORG;
  else delete process.env.CTX_ORG;
  const paths = resolvePaths(CALLER, instanceId, ORG);
  try { rmSync(join(paths.taskDir, '..'), { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(descFileDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function createTaskViaCli(title: string, extra: string[] = []): Promise<string> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  await busCommand.parseAsync(['node', 'cli', 'create-task', title, ...extra]);
  const id = String(logSpy.mock.calls[0][0]);
  logSpy.mockRestore();
  return id;
}

describe('update-task --desc-file', () => {
  it('MUST-FAIL CASE: a description sized past the argv ceiling that broke --desc lands intact via --desc-file', async () => {
    const id = await createTaskViaCli('T1');
    // 34,000 chars -- larger than the 33,994 that measurably broke a raw --desc argv.
    const big = 'x'.repeat(34_000);
    const descPath = join(descFileDir, 'big.txt');
    writeFileSync(descPath, big, 'utf-8');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await busCommand.parseAsync(['node', 'cli', 'update-task', id, 'pending', '--desc-file', descPath]);
    logSpy.mockRestore();

    expect((taskFile(id).description as string).length).toBe(34_000);
    expect(taskFile(id).description).toBe(big);
  });

  it('strips a BOM from the file, same as the .env reader elsewhere in this file', async () => {
    const id = await createTaskViaCli('T2');
    const descPath = join(descFileDir, 'bom.txt');
    writeFileSync(descPath, '﻿real description text', 'utf-8');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await busCommand.parseAsync(['node', 'cli', 'update-task', id, 'pending', '--desc-file', descPath]);
    logSpy.mockRestore();

    expect(taskFile(id).description).toBe('real description text');
  });

  it('refuses --desc-file pointing at a path that does not exist', async () => {
    const id = await createTaskViaCli('T3');
    const { consoleErrorSpy } = spyExitAndError();

    await expect(
      busCommand.parseAsync(['node', 'cli', 'update-task', id, 'pending', '--desc-file', join(descFileDir, 'nope.txt')])
    ).rejects.toThrow(/__TEST_PROCESS_EXIT_1__/);

    expect(String(consoleErrorSpy.mock.calls[0][0])).toContain('--desc-file path not found');
  });

  it('refuses --desc and --desc-file together (ambiguous)', async () => {
    const id = await createTaskViaCli('T4');
    const descPath = join(descFileDir, 'either.txt');
    writeFileSync(descPath, 'file content', 'utf-8');
    const { consoleErrorSpy } = spyExitAndError();

    await expect(
      busCommand.parseAsync(['node', 'cli', 'update-task', id, 'pending', '--desc', 'argv content', '--desc-file', descPath])
    ).rejects.toThrow(/__TEST_PROCESS_EXIT_1__/);

    expect(String(consoleErrorSpy.mock.calls[0][0])).toContain('only one of --desc or --desc-file');
  });

  it('an empty --desc-file is refused by the same guard as an empty --desc, unless --force-empty', async () => {
    const id = await createTaskViaCli('T5');
    const descPath = join(descFileDir, 'empty.txt');
    writeFileSync(descPath, '', 'utf-8');
    const { consoleErrorSpy } = spyExitAndError();

    await expect(
      busCommand.parseAsync(['node', 'cli', 'update-task', id, 'pending', '--desc-file', descPath])
    ).rejects.toThrow(/__TEST_PROCESS_EXIT_1__/);

    expect(String(consoleErrorSpy.mock.calls[0][0])).toContain('empty --desc');
  });

  it('PAIRED NEGATIVE: --force-empty lets an empty --desc-file through, same as an empty --desc', async () => {
    const id = await createTaskViaCli('T6');
    const descPath = join(descFileDir, 'empty2.txt');
    writeFileSync(descPath, '', 'utf-8');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await busCommand.parseAsync(['node', 'cli', 'update-task', id, 'pending', '--desc-file', descPath, '--force-empty']);
    logSpy.mockRestore();

    expect(taskFile(id).description).toBe('');
  });
});
