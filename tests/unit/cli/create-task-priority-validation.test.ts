/**
 * Regression test: `cortextos bus create-task --priority <bad>` must fail with a
 * clean one-line error and exit 1, NOT a raw Node stack trace.
 *
 * Before the fix, create-task was the only priority-taking bus command with no
 * validation at the CLI boundary (update-task, log-event and send-message all
 * had one). It passed the raw string straight into createTask(), whose
 * validatePriority() threw, and the throw escaped to the top level — so Node
 * printed a 10-line stack trace and the real message was buried in it.
 *
 * Why that mattered beyond cosmetics: agents create task waves by chaining
 * several `create-task` calls in one shell invocation. An unreadable crash in
 * the middle of a chain made the later items look silently dropped rather than
 * skipped-because-item-N-was-invalid, which caused real duplicate-cleanup work
 * on 2026-07-18.
 *
 * The check is deliberately the FIRST statement in the action, ahead of
 * resolveEnv() and any path resolution, so a bad priority is rejected before any
 * environment or filesystem state is touched — nothing partial is left behind.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { busCommand } from '../../../src/cli/bus';
import { VALID_PRIORITIES } from '../../../src/types/index';

describe('bus create-task priority validation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Commander invokes process.exit(1) on failure. Intercept by throwing so the
  // test runner itself does not exit. Same approach as add-agent-validation.
  function spyExitAndError() {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__TEST_PROCESS_EXIT_${code}__`);
    }) as never);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    return { exitSpy, consoleErrorSpy };
  }

  it("rejects --priority medium with a clean error and exit 1, not a stack trace", async () => {
    const { consoleErrorSpy } = spyExitAndError();

    await expect(
      busCommand.parseAsync(['node', 'cli', 'create-task', 'some title', '--priority', 'medium'])
    ).rejects.toThrow(/__TEST_PROCESS_EXIT_1__/);

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const msg = String(consoleErrorSpy.mock.calls[0][0]);

    // Names the offending value...
    expect(msg).toContain("medium");
    // ...and lists every valid option, so the caller can fix it without docs.
    for (const p of VALID_PRIORITIES) {
      expect(msg).toContain(p);
    }
    // A single line — the whole point is that it is not a stack dump.
    expect(msg.split('\n')).toHaveLength(1);
    expect(msg).not.toContain('    at ');
  });

  it('rejects an empty --priority rather than silently defaulting', async () => {
    const { consoleErrorSpy } = spyExitAndError();

    await expect(
      busCommand.parseAsync(['node', 'cli', 'create-task', 'some title', '--priority', ''])
    ).rejects.toThrow(/__TEST_PROCESS_EXIT_1__/);

    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('validates before touching env/filesystem state', async () => {
    // If validation ran after resolveEnv(), an unconfigured env would surface a
    // different error first. Asserting the message is the priority one proves
    // ordering, which is what makes a failed create atomic (nothing written).
    const { consoleErrorSpy } = spyExitAndError();

    await expect(
      busCommand.parseAsync([
        'node', 'cli', 'create-task', 'some title',
        '--priority', 'MEDIUM',           // case matters — priorities are lowercase
        '--assignee', 'someagent',
        '--blocked-by', 'task_1_2',       // would hit cycle detection + disk reads
      ])
    ).rejects.toThrow(/__TEST_PROCESS_EXIT_1__/);

    expect(String(consoleErrorSpy.mock.calls[0][0])).toContain('MEDIUM');
  });
});
