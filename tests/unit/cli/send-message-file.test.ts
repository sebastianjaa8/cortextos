/**
 * `cortextos bus send-message-file <to> <priority> <path>` — the body is read from a FILE so it
 * never crosses a shell.
 *
 * WHY IT EXISTS. `send-message` takes the body as a POSITIONAL ARGUMENT, so every message becomes
 * an argv entry and inherits the shell's quoting rules. On 2026-07-30 that produced SEVEN failures
 * across two agents in a single day — backslashes eaten inside heredocs, an apostrophe terminating
 * a single-quoted string, and backticks running as command substitution mid-message. Every one was
 * in the shell layer; none was in the message.
 *
 * The habit fix adopted that day (write harnesses to files instead of piping them through `node -e`)
 * is right and does NOT cover this path, because a bus message still has to reach argv somehow.
 * Passing a PATH removes the body from argv entirely.
 *
 * These tests pin the two LOUD failure paths. They must stay distinct: a missing file that silently
 * sent an empty message would be the reassuring-direction failure for a command whose entire purpose
 * is not losing content.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { busCommand } from '../../../src/cli/bus';

describe('bus send-message-file', () => {
  afterEach(() => vi.restoreAllMocks());

  function spyExitAndError() {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__TEST_PROCESS_EXIT_${code}__`);
    }) as never);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    return { exitSpy, consoleErrorSpy };
  }

  it('a MISSING body file fails loudly with exit 1 and names the path', async () => {
    const { consoleErrorSpy } = spyExitAndError();
    await expect(
      busCommand.parseAsync(['node', 'cli', 'send-message-file', 'someagent', 'normal', '/no/such/body.md']),
    ).rejects.toThrow(/__TEST_PROCESS_EXIT_1__/);
    const msg = String(consoleErrorSpy.mock.calls[0][0]);
    expect(msg).toContain('not found');
    expect(msg).toContain('/no/such/body.md');
  });

  it('an EMPTY body file fails with a DIFFERENT message than a missing one', async () => {
    // The distinction is the point. Collapsing "absent" and "present but empty" into one error is
    // the same conflation this command exists to remove one layer down.
    const dir = mkdtempSync(join(tmpdir(), 'smf-'));
    const p = join(dir, 'empty.md');
    writeFileSync(p, '   \n', 'utf-8');
    const { consoleErrorSpy } = spyExitAndError();
    try {
      await expect(
        busCommand.parseAsync(['node', 'cli', 'send-message-file', 'someagent', 'normal', p]),
      ).rejects.toThrow(/__TEST_PROCESS_EXIT_1__/);
      const msg = String(consoleErrorSpy.mock.calls[0][0]);
      expect(msg).toContain('empty');
      expect(msg).not.toContain('not found');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an invalid priority is rejected before the file is ever read', async () => {
    // Ordering matters: a bad priority must not depend on the body existing, or the caller gets
    // told about the wrong problem.
    const { consoleErrorSpy } = spyExitAndError();
    await expect(
      busCommand.parseAsync(['node', 'cli', 'send-message-file', 'someagent', 'medium', '/no/such/body.md']),
    ).rejects.toThrow(/__TEST_PROCESS_EXIT_1__/);
    const msg = String(consoleErrorSpy.mock.calls[0][0]);
    expect(msg).toContain('medium');
    expect(msg).not.toContain('not found');   // priority checked first, file never opened
  });
});
