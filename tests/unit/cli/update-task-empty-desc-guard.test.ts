/**
 * Regression test: `cortextos bus update-task <id> <status> --desc ""` must be
 * refused, not silently applied.
 *
 * task_1785629698092 (2026-08-02): a compound command whose $(...) substitution
 * resolved to an empty string was passed as --desc and blanked a real task
 * description at exit 0, with no history and no undo. Nobody types --desc ""
 * on purpose — an empty value is virtually always an accidental substitution
 * failure, so the CLI now refuses it unless --force-empty proves the caller
 * means it.
 *
 * The check is deliberately BEFORE resolveEnv()/updateTask(), same ordering
 * rationale as create-task's priority validation: a rejected update is atomic,
 * nothing partial is written.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { busCommand } from '../../../src/cli/bus';

describe('bus update-task empty --desc guard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Commander invokes process.exit(1) on failure. Intercept by throwing so the
  // test runner itself does not exit. Same approach as
  // create-task-priority-validation.test.ts.
  function spyExitAndError() {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__TEST_PROCESS_EXIT_${code}__`);
    }) as never);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    return { exitSpy, consoleErrorSpy };
  }

  it('refuses an empty --desc rather than blanking the description', async () => {
    const { consoleErrorSpy } = spyExitAndError();

    await expect(
      busCommand.parseAsync(['node', 'cli', 'update-task', 'task_does_not_matter', 'pending', '--desc', ''])
    ).rejects.toThrow(/__TEST_PROCESS_EXIT_1__/);

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const msg = String(consoleErrorSpy.mock.calls[0][0]);
    expect(msg).toContain('empty --desc');
    expect(msg).toContain('--force-empty');
    // A single line, not a stack dump.
    expect(msg.split('\n')).toHaveLength(1);
    expect(msg).not.toContain('    at ');
  });

  it('validates before touching env/filesystem state', async () => {
    // If validation ran after resolveEnv(), an unconfigured env would surface a
    // different error first (or a real task lookup would run). Asserting the
    // message is the empty-desc one proves ordering.
    const { consoleErrorSpy } = spyExitAndError();

    await expect(
      busCommand.parseAsync([
        'node', 'cli', 'update-task', 'task_definitely_does_not_exist_anywhere', 'in_progress',
        '--desc', '',
        '--assignee', 'someagent',
      ])
    ).rejects.toThrow(/__TEST_PROCESS_EXIT_1__/);

    expect(String(consoleErrorSpy.mock.calls[0][0])).toContain('empty --desc');
  });

  it('does not refuse an undefined --desc (status-only update)', async () => {
    // Must-fail-case's negative twin: the guard should fire ONLY on an explicit
    // empty string, never on --desc simply being absent. Exercised by letting
    // it proceed to the "task not found" error instead of the empty-desc one.
    const { consoleErrorSpy } = spyExitAndError();

    await expect(
      busCommand.parseAsync(['node', 'cli', 'update-task', 'task_definitely_does_not_exist_anywhere', 'pending'])
    ).rejects.toThrow();

    const calls = consoleErrorSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => m.includes('empty --desc'))).toBe(false);
  });
});
