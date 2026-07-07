import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the inject module so injectMessageDetailed's final PTY write is observable.
// vi.hoisted: the mock factory is hoisted above this const, so the fn must be too.
const { mockInjectMessage } = vi.hoisted(() => ({ mockInjectMessage: vi.fn() }));
vi.mock('../../../src/pty/inject.js', () => ({
  injectMessage: mockInjectMessage,
  MessageDedup: class {
    isDuplicate(): boolean { return false; }
    forget(): void { /* noop */ }
    clear(): void { /* noop */ }
  },
}));

import { AgentProcess } from '../../../src/daemon/agent-process.js';

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/test-ctx',
  org: 'testorg',
  agentDir: '/tmp/test-ctx/agents/alice',
} as any;

/**
 * Fake PTY exposing a controllable output-byte counter + bootstrap flag.
 * `bytes` is mutated by tests to simulate mid-turn streaming vs idle quiet.
 */
function makeFakePty() {
  const state = { bytes: 0, bootstrapped: true };
  const pty = {
    write: vi.fn(),
    getPid: () => 4242,
    isAlive: () => true,
    getOutputBuffer: () => ({
      getTotalBytes: () => state.bytes,
      isBootstrapped: () => state.bootstrapped,
    }),
  };
  return { pty, state };
}

function makeRunningProcess() {
  const proc = new AgentProcess('alice', mockEnv, { runtime: 'claude' } as any, () => {});
  const { pty, state } = makeFakePty();
  (proc as any).pty = pty;
  (proc as any).status = 'running';
  return { proc, pty, state };
}

const TICK = 5_000;

describe('AgentProcess.injectMessageQueued — turn-boundary drain', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockInjectMessage.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects when the agent is not running', () => {
    const proc = new AgentProcess('alice', mockEnv, { runtime: 'claude' } as any, () => {});
    const res = proc.injectMessageQueued('hello');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('NOT_RUNNING');
  });

  it('delivers a queued prompt only after a full quiet window', () => {
    const { proc, state } = makeRunningProcess();
    state.bytes = 10_000;

    const res = proc.injectMessageQueued('[CRON FIRED t] pulse: do the thing');
    expect(res.ok).toBe(true);

    // Tick 1: establishes baseline only — must not inject yet.
    vi.advanceTimersByTime(TICK);
    expect(mockInjectMessage).not.toHaveBeenCalled();

    // Tick 2: no output growth since baseline → quiet → inject.
    vi.advanceTimersByTime(TICK);
    expect(mockInjectMessage).toHaveBeenCalledTimes(1);
    expect(mockInjectMessage.mock.calls[0][1]).toContain('pulse: do the thing');
  });

  it('holds the prompt while the PTY is mid-turn (output growing)', () => {
    const { proc, state } = makeRunningProcess();
    proc.injectMessageQueued('queued mid-turn');

    // Simulate active streaming: grow well past the quiet threshold each tick.
    for (let i = 0; i < 10; i++) {
      state.bytes += 5_000;
      vi.advanceTimersByTime(TICK);
    }
    expect(mockInjectMessage).not.toHaveBeenCalled();

    // Turn ends: output goes quiet → next tick delivers.
    vi.advanceTimersByTime(TICK);
    expect(mockInjectMessage).toHaveBeenCalledTimes(1);
  });

  it('serializes multiple queued prompts one per quiet window', () => {
    const { proc, state } = makeRunningProcess();
    proc.injectMessageQueued('first');
    proc.injectMessageQueued('second');

    // Baseline tick + quiet tick → first delivered.
    vi.advanceTimersByTime(TICK * 2);
    expect(mockInjectMessage).toHaveBeenCalledTimes(1);
    expect(mockInjectMessage.mock.calls[0][1]).toBe('first');

    // The injected prompt starts a turn (output grows) — second must wait.
    state.bytes += 5_000;
    vi.advanceTimersByTime(TICK);
    expect(mockInjectMessage).toHaveBeenCalledTimes(1);

    // Turn ends → baseline tick + quiet tick → second delivered.
    vi.advanceTimersByTime(TICK * 2);
    expect(mockInjectMessage).toHaveBeenCalledTimes(2);
    expect(mockInjectMessage.mock.calls[1][1]).toBe('second');
  });

  it('max-wait valve injects mid-turn instead of starving forever', () => {
    const { proc, state } = makeRunningProcess();
    proc.injectMessageQueued('starving prompt');

    // Perpetually busy PTY for 15 minutes.
    const ticks = Math.ceil((15 * 60_000) / TICK) + 1;
    for (let i = 0; i < ticks; i++) {
      state.bytes += 5_000;
      vi.advanceTimersByTime(TICK);
      if (mockInjectMessage.mock.calls.length > 0) break;
    }
    expect(mockInjectMessage).toHaveBeenCalledTimes(1);
  });

  it('does not treat a PTY counter reset (restart) as quiet', () => {
    const { proc, state } = makeRunningProcess();
    state.bytes = 50_000;
    proc.injectMessageQueued('across restart');

    vi.advanceTimersByTime(TICK); // baseline at 50_000

    // Session refresh: new OutputBuffer → counter resets to a small value.
    state.bytes = 100;
    vi.advanceTimersByTime(TICK); // bytes < prev → re-baseline, no inject
    expect(mockInjectMessage).not.toHaveBeenCalled();

    vi.advanceTimersByTime(TICK); // quiet since new baseline → inject
    expect(mockInjectMessage).toHaveBeenCalledTimes(1);
  });

  it('waits for bootstrap before delivering', () => {
    const { proc, state } = makeRunningProcess();
    state.bootstrapped = false;
    proc.injectMessageQueued('too early');

    vi.advanceTimersByTime(TICK * 4);
    expect(mockInjectMessage).not.toHaveBeenCalled();

    state.bootstrapped = true;
    vi.advanceTimersByTime(TICK * 2); // baseline + quiet
    expect(mockInjectMessage).toHaveBeenCalledTimes(1);
  });

  it('drops the oldest entry on queue overflow', () => {
    const { proc } = makeRunningProcess();
    for (let i = 0; i < 45; i++) {
      proc.injectMessageQueued(`prompt-${i}`);
    }
    // Queue cap is 40 → prompts 0-4 dropped; first delivery is prompt-5.
    vi.advanceTimersByTime(TICK * 2);
    expect(mockInjectMessage).toHaveBeenCalledTimes(1);
    expect(mockInjectMessage.mock.calls[0][1]).toBe('prompt-5');
  });
});
