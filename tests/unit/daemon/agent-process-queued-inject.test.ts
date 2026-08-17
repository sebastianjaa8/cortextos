import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/utils/process-ownership.js', () => ({
  writeRuntimeProcessRecord: vi.fn((_stateDir, input) => ({ ...input, ownerToken: 'a'.repeat(64) })),
  removeRuntimeProcessRecord: vi.fn(() => true),
  terminateProcessTree: vi.fn(() => true),
}));

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

const { mockLogEvent } = vi.hoisted(() => ({ mockLogEvent: vi.fn() }));
vi.mock('../../../src/bus/event.js', () => ({
  logEvent: mockLogEvent,
}));

const { mockAppendDeliveryLog } = vi.hoisted(() => ({ mockAppendDeliveryLog: vi.fn() }));
vi.mock('../../../src/daemon/cron-delivery-log.js', () => ({
  appendDeliveryLog: mockAppendDeliveryLog,
}));

vi.mock('../../../src/utils/paths.js', () => ({
  resolvePaths: vi.fn().mockReturnValue({ stateDir: '/tmp/test-ctx/state/alice', analyticsDir: '/tmp/test-ctx/analytics' }),
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
    mockLogEvent.mockClear();
    mockAppendDeliveryLog.mockClear();
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

  describe('dropped catch-up inject detection (root-cause fix 2026-07-23)', () => {
    it('re-queues a verifiably-failed delivery ahead of newer queued items', () => {
      const { proc } = makeRunningProcess();
      proc.injectMessageQueued('first');

      // Deliver "first" (baseline tick + quiet tick).
      vi.advanceTimersByTime(TICK * 2);
      expect(mockInjectMessage).toHaveBeenCalledTimes(1);
      expect(mockInjectMessage.mock.calls[0][1]).toBe('first');

      // Simulate the Enter-swallow / retries-exhausted failure that inject.ts
      // reports via verify.onFailed — this is what used to just forget the
      // dedup hash and drop the content forever.
      const verify0 = mockInjectMessage.mock.calls[0][3];
      verify0.onFailed();

      // A newer cron fires while the failed retry is pending.
      proc.injectMessageQueued('second');

      // Next delivery cycle must re-attempt "first" (front of queue), not "second".
      vi.advanceTimersByTime(TICK * 2);
      expect(mockInjectMessage).toHaveBeenCalledTimes(2);
      expect(mockInjectMessage.mock.calls[1][1]).toBe('first');
      // Not yet escalated — still within retry budget.
      expect(mockLogEvent).not.toHaveBeenCalled();
    });

    it('drops and emits a critical bus event after retry budget is exhausted', () => {
      const { proc } = makeRunningProcess();
      proc.injectMessageQueued('stuck');

      // DRAIN_MAX_DELIVERY_ATTEMPTS = 3: fail every delivery.
      for (let i = 0; i < 3; i++) {
        vi.advanceTimersByTime(TICK * 2);
        const call = mockInjectMessage.mock.calls[mockInjectMessage.mock.calls.length - 1];
        call[3].onFailed();
      }

      expect(mockInjectMessage).toHaveBeenCalledTimes(3);
      // No 4th attempt — budget exhausted, content dropped instead of re-queued.
      vi.advanceTimersByTime(TICK * 4);
      expect(mockInjectMessage).toHaveBeenCalledTimes(3);

      expect(mockLogEvent).toHaveBeenCalledTimes(1);
      const [, , , category, eventName, severity, metadata] = mockLogEvent.mock.calls[0];
      expect(category).toBe('error');
      expect(eventName).toBe('cron_inject_dropped');
      expect(severity).toBe('critical');
      expect(metadata).toMatchObject({ attempts: 3 });
    });
  });

  describe('cron delivery record (task_1786971045376, 2026-08-17: drainTick success had no observable record)', () => {
    it('logs a delivery record ONLY once the async verify confirms acceptance, not at drain time; waited_ms counts the FULL elapsed time including verify latency', () => {
      const { proc, state } = makeRunningProcess();
      state.bytes = 10_000;
      proc.injectMessageQueued('[CRON FIRED 2026-08-17T12:00:00.000Z] pulse: do the thing', {
        cron: 'pulse',
        firedAt: '2026-08-17T12:00:00.000Z',
      });

      vi.advanceTimersByTime(TICK * 2);
      expect(mockInjectMessage).toHaveBeenCalledTimes(1);
      // The delivery is still UNCONFIRMED at this point — drainTick has only initiated the
      // submit, not verified it landed. THE INCIDENT ITSELF: recording here instead of on
      // confirmation would have logged an optimistic delivery, not a real one.
      expect(mockAppendDeliveryLog).not.toHaveBeenCalled();

      // Real async gap between drain and confirmation (inject.ts's Enter-verify window) —
      // adversarial review (Codex) found waited_ms was documented as "drain-queue wait time"
      // while actually including this gap too. Advancing time here before onAccepted() proves
      // the number reflects the FULL elapsed span, not just the pre-confirmation portion.
      const VERIFY_GAP_MS = 4_000;
      vi.advanceTimersByTime(VERIFY_GAP_MS);
      // Verify object is the 4th positional arg to injectMessage (see inject.ts call shape).
      const verify = mockInjectMessage.mock.calls[0][3];
      verify.onAccepted();

      expect(mockAppendDeliveryLog).toHaveBeenCalledTimes(1);
      const [agentName, entry] = mockAppendDeliveryLog.mock.calls[0];
      expect(agentName).toBe('alice');
      expect(entry).toMatchObject({ cron: 'pulse', fired_at: '2026-08-17T12:00:00.000Z', trigger: 'quiet-boundary' });
      expect(typeof entry.ts).toBe('string');
      // TIGHTENED after the second Codex pass: asserting only `>= VERIFY_GAP_MS` (4000) was
      // vacuous — the pre-confirmation drain alone already consumes TICK*2 (10000ms), so that
      // bound would pass even if waited_ms had stopped counting at drain time and never
      // included the verify gap at all. Asserting the FULL expected total (drain + gap) is the
      // only bound that can actually distinguish "includes verify latency" from "does not."
      expect(entry.waited_ms).toBeGreaterThanOrEqual(TICK * 2 + VERIFY_GAP_MS);
    });

    it('does NOT log a delivery record for an inject with no cron identity (interactive/Telegram path)', () => {
      const { proc, state } = makeRunningProcess();
      state.bytes = 10_000;
      // No cronMeta — same call shape as a non-cron caller.
      proc.injectMessageQueued('interactive steering, no cron attached');

      vi.advanceTimersByTime(TICK * 2);
      expect(mockInjectMessage).toHaveBeenCalledTimes(1);
      const verify = mockInjectMessage.mock.calls[0][3];
      verify.onAccepted();

      // CONTROL for the case above: proves the delivery log is gated on cronMeta actually being
      // present, not on every successful delivery unconditionally.
      expect(mockAppendDeliveryLog).not.toHaveBeenCalled();
    });

    it('BLOCKER FIX (Codex adversarial review): does NOT log a delivery record for the max-wait-valve path, even on confirmed acceptance', () => {
      // The overdue/max-wait branch fires precisely because the PTY has been busy — the same
      // output-growth verifier that confirms delivery can false-accept on UNRELATED ongoing
      // turn output in that state (documented ceiling, this file's own "ponytail: known
      // ceiling" comment). A durable "CONFIRMED delivery" record built on that weak signal
      // would be worse than no record at all. This is the regression guard for that fix —
      // sabotage it and this must go red.
      const { proc, state } = makeRunningProcess();
      proc.injectMessageQueued('starving prompt', { cron: 'starver', firedAt: '2026-08-17T00:00:00.000Z' });

      const ticks = Math.ceil((15 * 60_000) / TICK) + 1;
      for (let i = 0; i < ticks; i++) {
        state.bytes += 5_000;
        vi.advanceTimersByTime(TICK);
        if (mockInjectMessage.mock.calls.length > 0) break;
      }
      expect(mockInjectMessage).toHaveBeenCalledTimes(1);
      // Even a CONFIRMED accept on this path must not produce a delivery record.
      mockInjectMessage.mock.calls[0][3].onAccepted();

      expect(mockAppendDeliveryLog).not.toHaveBeenCalled();
    });

    it('does not log a delivery record if the drained inject fails instead of succeeding', () => {
      const { proc, state } = makeRunningProcess();
      state.bytes = 10_000;
      proc.injectMessageQueued('will fail', { cron: 'flaky', firedAt: '2026-08-17T00:00:00.000Z' });

      vi.advanceTimersByTime(TICK * 2);
      expect(mockInjectMessage).toHaveBeenCalledTimes(1);
      // Fail instead of accept.
      mockInjectMessage.mock.calls[0][3].onFailed();

      expect(mockAppendDeliveryLog).not.toHaveBeenCalled();
    });

    it('retains cron identity through a failed-then-retried-then-accepted cycle, and records exactly once', () => {
      // Codex gap: the failure test previously stopped after the first onFailed() and never
      // proved cronMeta survives the requeue (handleQueuedDeliveryFailure's `{ ...item }`
      // spread) into a SUBSEQUENT successful delivery, or that it records exactly once (not
      // once per attempt).
      const { proc, state } = makeRunningProcess();
      state.bytes = 10_000;
      proc.injectMessageQueued('retry then succeed', { cron: 'flaky-then-fine', firedAt: '2026-08-17T00:00:00.000Z' });

      vi.advanceTimersByTime(TICK * 2);
      expect(mockInjectMessage).toHaveBeenCalledTimes(1);
      mockInjectMessage.mock.calls[0][3].onFailed(); // attempt 1 fails, re-queued at front
      expect(mockAppendDeliveryLog).not.toHaveBeenCalled();

      state.bytes += 5_000; // force a fresh quiet baseline before the retry can redeliver
      vi.advanceTimersByTime(TICK * 2);
      expect(mockInjectMessage).toHaveBeenCalledTimes(2);
      mockInjectMessage.mock.calls[1][3].onAccepted(); // attempt 2 succeeds

      expect(mockAppendDeliveryLog).toHaveBeenCalledTimes(1);
      expect(mockAppendDeliveryLog.mock.calls[0][1]).toMatchObject({
        cron: 'flaky-then-fine',
        fired_at: '2026-08-17T00:00:00.000Z',
      });
    });
  });
});
