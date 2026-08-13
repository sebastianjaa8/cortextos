/**
 * tests/unit/cli/send-message-unknown-recipient.test.ts
 *
 * task_1785720898226: `send-message` and `send-message-file` used to return exit 0 and a message
 * id for a recipient that does not exist -- success and failure were byte-identical in exit code
 * and in shape, and sendMessage()'s ensureDir() created inbox/<to> for whatever string it was
 * handed, so a typo's second attempt found that directory already present and looked exactly like
 * a real agent. Fix brings both commands in line with send-telegram's existing house style:
 * reject loudly, before any write.
 *
 * MUST-FAIL CASE (seb_boss's stronger version, adopted as primary): after a send to an unknown
 * recipient, inbox/<name> MUST NOT EXIST -- exiting nonzero alone is insufficient because the
 * defect is self-healing in the wrong direction (the directory, once created, makes every
 * subsequent typo look legitimate).
 * PAIRED NEGATIVE: a send to a REAL registered agent must still exit 0 and must NOT warn.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { busCommand } from '../../../src/cli/bus';
import { resolvePaths } from '../../../src/utils/paths';

const ORG = 'testorg';
const CALLER = 'caller';
const REAL_RECIPIENT = 'realagent';
const UNKNOWN_RECIPIENT = 'no-such-agent';

let instanceId: string;
let frameworkRoot: string;
const originalEnv: Record<string, string | undefined> = {
  CTX_INSTANCE_ID: process.env.CTX_INSTANCE_ID,
  CTX_AGENT_NAME: process.env.CTX_AGENT_NAME,
  CTX_ORG: process.env.CTX_ORG,
  CTX_FRAMEWORK_ROOT: process.env.CTX_FRAMEWORK_ROOT,
  // This test overrides CTX_FRAMEWORK_ROOT to a scratch dir. resolveEnv()'s own
  // sandbox/live-leak guard then requires CTX_AGENT_DIR (and CTX_PROJECT_ROOT) to
  // resolve UNDER that scratch root — but this shell's real CTX_AGENT_DIR is the
  // live builder_1 agent dir, inherited from the running session. Left alone,
  // resolveEnv() correctly refuses to proceed ("sandbox/live environment leak").
  // Clearing both for the duration of this test lets resolveEnv() derive a fresh
  // agentDir under the scratch frameworkRoot instead.
  CTX_AGENT_DIR: process.env.CTX_AGENT_DIR,
  CTX_PROJECT_ROOT: process.env.CTX_PROJECT_ROOT,
};

function spyExitAndError() {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__TEST_PROCESS_EXIT_${code}__`);
  }) as never);
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  return { exitSpy, errorSpy, logSpy };
}

beforeEach(() => {
  instanceId = `test-unknown-recip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  frameworkRoot = mkdtempSync(join(tmpdir(), 'cortextos-fwroot-'));
  mkdirSync(join(frameworkRoot, 'orgs', ORG, 'agents', REAL_RECIPIENT), { recursive: true });

  process.env.CTX_INSTANCE_ID = instanceId;
  process.env.CTX_AGENT_NAME = CALLER;
  process.env.CTX_ORG = ORG;
  process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;
  delete process.env.CTX_AGENT_DIR;
  delete process.env.CTX_PROJECT_ROOT;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v !== undefined) process.env[k] = v; else delete process.env[k];
  }
  rmSync(frameworkRoot, { recursive: true, force: true });
  try { rmSync(join(homedir(), '.cortextos', instanceId), { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('send-message: unknown recipient rejected before any inbox write', () => {
  it('exits nonzero and does NOT create inbox/<name> for an unknown recipient', async () => {
    const { errorSpy } = spyExitAndError();
    await expect(
      busCommand.parseAsync(['node', 'cli', 'send-message', UNKNOWN_RECIPIENT, 'normal', 'hello']),
    ).rejects.toThrow(/__TEST_PROCESS_EXIT_1__/);

    const msg = String(errorSpy.mock.calls[0][0]);
    expect(msg).toContain('not found');
    expect(msg).toContain(UNKNOWN_RECIPIENT);

    const paths = resolvePaths(UNKNOWN_RECIPIENT, instanceId, ORG);
    expect(existsSync(paths.inbox)).toBe(false);
  });

  it('a real registered agent still gets exit 0, no warning, and a real inbox message', async () => {
    const { errorSpy, logSpy } = spyExitAndError();
    await busCommand.parseAsync(['node', 'cli', 'send-message', REAL_RECIPIENT, 'normal', 'hello']);

    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalled(); // prints the msg id

    const paths = resolvePaths(REAL_RECIPIENT, instanceId, ORG);
    expect(existsSync(paths.inbox)).toBe(true);
  });
});

describe('send-message-file: unknown recipient rejected before any inbox write', () => {
  let bodyPath: string;

  beforeEach(() => {
    bodyPath = join(frameworkRoot, 'body.md');
    writeFileSync(bodyPath, 'hello from a file', 'utf-8');
  });

  it('exits nonzero and does NOT create inbox/<name> for an unknown recipient', async () => {
    const { errorSpy } = spyExitAndError();
    await expect(
      busCommand.parseAsync(['node', 'cli', 'send-message-file', UNKNOWN_RECIPIENT, 'normal', bodyPath]),
    ).rejects.toThrow(/__TEST_PROCESS_EXIT_1__/);

    const msg = String(errorSpy.mock.calls[0][0]);
    expect(msg).toContain('not found');

    const paths = resolvePaths(UNKNOWN_RECIPIENT, instanceId, ORG);
    expect(existsSync(paths.inbox)).toBe(false);
  });

  it('a real registered agent still gets exit 0 and a real inbox message', async () => {
    const { errorSpy, logSpy } = spyExitAndError();
    await busCommand.parseAsync(['node', 'cli', 'send-message-file', REAL_RECIPIENT, 'normal', bodyPath]);

    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalled();

    const paths = resolvePaths(REAL_RECIPIENT, instanceId, ORG);
    expect(existsSync(paths.inbox)).toBe(true);
  });
});
