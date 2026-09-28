import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/utils/process-ownership.js', () => ({
  writeRuntimeProcessRecord: vi.fn((_stateDir, input) => ({ ...input, ownerToken: 'a'.repeat(64) })),
  removeRuntimeProcessRecord: vi.fn(() => true),
  terminateProcessTree: vi.fn(() => true),
  // reminders.ts (imported transitively via agent-process.ts's getOverdueReminders)
  // now pulls in utils/lock.ts, which calls inspectProcessIdentity(process.pid) at
  // MODULE LOAD TIME -- an unmocked export here throws immediately on import,
  // not on use. This file's own locking behavior is not under test; a null/absent
  // identity is a safe default that matches inspectProcessIdentity's real return
  // type (task_1787099506036).
  inspectProcessIdentity: vi.fn(() => null),
  probeProcessIdentity: vi.fn(() => ({ status: 'absent' })),
  processIdentityEquals: vi.fn(() => false),
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

function makeRunningProcess(runtime: string = 'claude') {
  const logFn = vi.fn();
  const proc = new AgentProcess('alice', mockEnv, { runtime } as any, logFn);
  const { pty, state } = makeFakePty();
  (proc as any).pty = pty;
  (proc as any).status = 'running';
  return { proc, pty, state, logFn };
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

  // GUARD FOR ONE LEG SUPPRESSING ANOTHER (task_1785507729042, found 2026-08-26). A prompt
  // evicted on queue overflow with attempts===0 (never delivered at all, not a re-lost retry)
  // used to produce NO event — only a log line nothing reads. This must go RED on the
  // pre-fix guard (`if (dropped.attempts > 0)`) and GREEN once every eviction escalates.
  it('escalates a queue-overflow eviction even when the dropped item was never attempted (attempts===0)', () => {
    const { proc } = makeRunningProcess();
    for (let i = 0; i < 45; i++) {
      proc.injectMessageQueued(`prompt-${i}`);
    }
    // ADVERSARIAL-REVIEW FIX (Codex, 2026-08-26): the original assertions only checked count,
    // severity, attempts and reason — that would still pass if the events described the WRONG
    // prompts, or if a delivery had actually been attempted despite attempts staying 0 in the
    // metadata. Never advancing fake timers here means no drain tick has run, so nothing COULD
    // have been delivered — assert that explicitly rather than relying on it implicitly.
    expect(mockInjectMessage).not.toHaveBeenCalled();
    // 5 evictions (prompts 0-4), none of which were ever delivered.
    expect(mockLogEvent).toHaveBeenCalledTimes(5);
    const previews = mockLogEvent.mock.calls.map((call) => call[6].content_preview);
    expect(previews).toEqual(['prompt-0', 'prompt-1', 'prompt-2', 'prompt-3', 'prompt-4']);
    for (const call of mockLogEvent.mock.calls) {
      const [, , , category, eventName, severity, metadata] = call;
      expect(category).toBe('error');
      expect(eventName).toBe('cron_inject_dropped');
      expect(severity).toBe('critical');
      expect(metadata).toMatchObject({ attempts: 0, reason: 'queue-overflow-eviction-never-attempted' });
    }
  });

  // PAIRED NEGATIVE: a retry (attempts > 0) evicted on overflow must keep the ORIGINAL reason
  // string, not collapse into the new never-attempted one — the two facts are different and a
  // reader needs to tell a re-lost retry apart from a prompt that was never delivered at all.
  it('keeps the original reason string when a queue-overflow eviction lands on a real retry', () => {
    const { proc } = makeRunningProcess();
    proc.injectMessageQueued('will-fail-then-get-evicted');

    // Deliver it once, then fail it — re-queued at the front with attempts=1.
    vi.advanceTimersByTime(TICK * 2);
    expect(mockInjectMessage).toHaveBeenCalledTimes(1);
    mockInjectMessage.mock.calls[0][3].onFailed();
    mockLogEvent.mockClear();

    // The retried item was re-queued at the FRONT (unshift), so it is the "oldest" for
    // eviction purposes (shift() removes index 0) even though it is not chronologically
    // oldest. Fill to EXACTLY the cap first (1 retried + 39 fillers = 40, no overflow yet),
    // then one more push triggers the drop of the front — which by construction is the
    // retried item, not any of the fresh fillers behind it.
    const DRAIN_MAX_QUEUE = 40; // private static on AgentProcess; mirrored here, see class comment
    for (let i = 0; i < DRAIN_MAX_QUEUE - 1; i++) {
      proc.injectMessageQueued(`filler-${i}`);
    }
    expect(mockLogEvent).not.toHaveBeenCalled(); // exactly at cap, no overflow yet

    proc.injectMessageQueued('one-more-to-overflow');
    expect(mockLogEvent).toHaveBeenCalledTimes(1);
    const [, , , , , , metadata] = mockLogEvent.mock.calls[0];
    // ADVERSARIAL-REVIEW FIX (Codex, 2026-08-26): assert content_preview too, not just
    // attempts/reason — without it, an event describing the WRONG evicted item (e.g. a filler
    // prompt instead of the retried one) would still satisfy this test.
    expect(metadata).toMatchObject({
      attempts: 1,
      reason: 'queue-overflow-eviction',
      content_preview: 'will-fail-then-get-evicted',
    });
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

const DRAIN_MAX_WAIT_MS = 15 * 60_000;

describe('AgentProcess.drainTick — never-bootstrapped nudge (task_1790591432216_84154671)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockInjectMessage.mockClear();
    mockLogEvent.mockClear();
    mockAppendDeliveryLog.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('MUST-FAIL: nudges once the queue is stalled past DRAIN_MAX_WAIT_MS with isBootstrapped stuck false', () => {
    const { proc, state } = makeRunningProcess('hermes');
    state.bootstrapped = false;
    proc.injectMessageQueued('real cron content');

    vi.advanceTimersByTime(DRAIN_MAX_WAIT_MS);
    expect(mockInjectMessage).toHaveBeenCalledTimes(1);
  });

  it('paired negative: does not nudge before DRAIN_MAX_WAIT_MS elapses', () => {
    const { proc, state } = makeRunningProcess('hermes');
    state.bootstrapped = false;
    proc.injectMessageQueued('real cron content');

    vi.advanceTimersByTime(DRAIN_MAX_WAIT_MS - 1_000);
    expect(mockInjectMessage).not.toHaveBeenCalled();
  });

  it('nudge content is NOT the queued cron content, and does not even embed it as a substring', () => {
    const { proc, state } = makeRunningProcess('hermes');
    // Distinctive sentinel, not just an inequality target — a nudge that embedded the full
    // cron prompt inside a prefix/timestamp wrapper would still pass a plain .not.toBe() check
    // (Codex round-review finding). Assert the sentinel does not appear anywhere in the
    // injected string, not just that the two strings aren't byte-identical.
    const sentinel = 'SENTINEL-REAL-CRON-CONTENT-MUST-NOT-LEAK-9f3a1';
    state.bootstrapped = false;
    proc.injectMessageQueued(sentinel);

    vi.advanceTimersByTime(DRAIN_MAX_WAIT_MS);
    expect(mockInjectMessage).toHaveBeenCalledTimes(1);
    expect(mockInjectMessage.mock.calls[0][1]).not.toContain(sentinel);
  });

  it('cooldown, not one-shot: nudges once per DRAIN_MAX_WAIT_MS window, not every tick', () => {
    const { proc, state } = makeRunningProcess('hermes');
    state.bootstrapped = false;
    proc.injectMessageQueued('real cron content');

    vi.advanceTimersByTime(DRAIN_MAX_WAIT_MS);
    expect(mockInjectMessage).toHaveBeenCalledTimes(1);

    // Advance to just under the second window — still exactly one nudge.
    vi.advanceTimersByTime(DRAIN_MAX_WAIT_MS - TICK);
    expect(mockInjectMessage).toHaveBeenCalledTimes(1);

    // Cross into the second window — a second nudge fires.
    vi.advanceTimersByTime(TICK);
    expect(mockInjectMessage).toHaveBeenCalledTimes(2);
  });

  it('dedup-salt regression: successive nudges carry different content (fire-timestamp salted)', () => {
    const { proc, state } = makeRunningProcess('hermes');
    state.bootstrapped = false;
    proc.injectMessageQueued('real cron content');

    vi.advanceTimersByTime(DRAIN_MAX_WAIT_MS);
    vi.advanceTimersByTime(DRAIN_MAX_WAIT_MS);
    expect(mockInjectMessage).toHaveBeenCalledTimes(2);
    expect(mockInjectMessage.mock.calls[0][1]).not.toBe(mockInjectMessage.mock.calls[1][1]);
  });

  it('backlog with multiple already-overdue items, re-latching never succeeds: nudges stay cooldown-bounded, queue never drains while unbootstrapped', () => {
    const { proc, state } = makeRunningProcess('hermes');
    state.bootstrapped = false;
    proc.injectMessageQueued('item 1');
    proc.injectMessageQueued('item 2');
    proc.injectMessageQueued('item 3');

    // Advance across several windows — bootstrapped never flips true.
    vi.advanceTimersByTime(DRAIN_MAX_WAIT_MS * 3);

    // Bounded: at most one nudge per window, not one per queued item and not one per tick.
    expect(mockInjectMessage.mock.calls.length).toBeLessThanOrEqual(3);
    expect(mockInjectMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
    // None of the nudge calls carried real content — the queue was never drained.
    for (const call of mockInjectMessage.mock.calls) {
      expect(call[1]).not.toBe('item 1');
      expect(call[1]).not.toBe('item 2');
      expect(call[1]).not.toBe('item 3');
    }

    // Confirm the queue is still intact: flip bootstrapped true and let the existing,
    // unmodified drain path take over — all 3 real items must still be there to deliver.
    // By now every item is also massively overdue by head.enqueuedAt (queued 3 windows ago),
    // so the existing overdue branch (unmodified by this fix) skips the quiet-window wait and
    // delivers one per tick, in order — proving retention AND ordering, not the quiet-boundary
    // shape a fresher queue would take.
    mockInjectMessage.mockClear();
    state.bootstrapped = true;
    vi.advanceTimersByTime(TICK * 3);
    expect(mockInjectMessage).toHaveBeenCalledTimes(3);
    expect(mockInjectMessage.mock.calls[0][1]).toBe('item 1');
    expect(mockInjectMessage.mock.calls[1][1]).toBe('item 2');
    expect(mockInjectMessage.mock.calls[2][1]).toBe('item 3');
  });

  it('same-instance restart: a stale cooldown timestamp does not suppress the new generation, but the new generation still gets its own fresh grace period', () => {
    const { proc, state } = makeRunningProcess('hermes');
    state.bootstrapped = false;
    proc.injectMessageQueued('real cron content');

    // T0 -> T1: one real nudge.
    vi.advanceTimersByTime(DRAIN_MAX_WAIT_MS);
    expect(mockInjectMessage).toHaveBeenCalledTimes(1);

    // Jump the clock to a LATE restart moment (T2 = T0 + 5*D) WITHOUT executing intermediate
    // ticks — setSystemTime() fires no callbacks and shifts pending timers' remaining delays
    // rather than running a catch-up burst, so lastNeverBootstrappedNudgeAt genuinely stays
    // frozen at its T1 value instead of having refired at every intermediate window.
    const t2 = Date.now() + DRAIN_MAX_WAIT_MS * 4;
    vi.setSystemTime(t2);
    // Same-instance session-refresh: reassign fields on the existing proc, don't reconstruct it
    // — matches real start()/startImpl() behavior (confirmed: restarts reuse the same
    // AgentProcess object). The queue is NOT cleared, matching real injectMessageQueued()
    // behavior across restarts.
    (proc as any).sessionStart = new Date(t2);
    state.bootstrapped = false;

    // 10 seconds after the restart: both the raw enqueue-age (5D+10s) and the plain
    // cooldown-age (4D+10s) are already well past D — only sessionStart in readyBaseline
    // correctly withholds the nudge here.
    mockInjectMessage.mockClear();
    vi.advanceTimersByTime(10_000);
    expect(mockInjectMessage).not.toHaveBeenCalled();

    // Once the NEW generation's own grace period elapses, a nudge fires.
    vi.advanceTimersByTime(DRAIN_MAX_WAIT_MS - 10_000);
    expect(mockInjectMessage).toHaveBeenCalledTimes(1);
  });

  it('nudge-write failure is contained: a synchronous throw from injectMessageDetailed does not crash drainTick, does not clear the queue, still respects cooldown, and still retries at the next window', () => {
    const { proc, state } = makeRunningProcess('hermes');
    state.bootstrapped = false;
    proc.injectMessageQueued('real cron content');
    mockInjectMessage.mockImplementationOnce(() => {
      throw new Error('simulated PTY write failure');
    });

    // The throwing attempt itself must still happen (not skipped) and must not crash.
    expect(() => vi.advanceTimersByTime(DRAIN_MAX_WAIT_MS)).not.toThrow();
    expect(mockInjectMessage).toHaveBeenCalledTimes(1);

    // Cooldown must still be respected after a FAILED attempt — this is the case Codex flagged
    // as unproven: moving the cooldown-timestamp assignment to only the success path (or after
    // the throwing call) would let this next assertion fail by re-attempting every 5s tick.
    mockInjectMessage.mockClear();
    vi.advanceTimersByTime(DRAIN_MAX_WAIT_MS - TICK);
    expect(mockInjectMessage).not.toHaveBeenCalled();

    // Once the cooldown clears, the SAME still-queued item drives a fresh (this time
    // non-throwing) attempt — proving the item was never cleared by the failed attempt, and
    // proving cooldown expiry, not the earlier throw, governs the next try. Also confirms
    // content retention directly: flip bootstrapped true afterward and require the ORIGINAL
    // content (not a re-enqueued substitute) to be what the existing drain path delivers.
    vi.advanceTimersByTime(TICK);
    expect(mockInjectMessage).toHaveBeenCalledTimes(1);
    expect(mockInjectMessage.mock.calls[0][1]).not.toBe('real cron content'); // still a nudge, not real content

    mockInjectMessage.mockClear();
    state.bootstrapped = true;
    vi.advanceTimersByTime(TICK);
    expect(mockInjectMessage).toHaveBeenCalledTimes(1);
    expect(mockInjectMessage.mock.calls[0][1]).toBe('real cron content');
  });

  it("nudge's own failure-log call is contained too: a throwing logger does not escape the catch", () => {
    const { proc, state, logFn } = makeRunningProcess('hermes');
    state.bootstrapped = false;
    proc.injectMessageQueued('real cron content');
    mockInjectMessage.mockImplementationOnce(() => {
      throw new Error('simulated PTY write failure');
    });
    logFn.mockImplementationOnce(() => {
      throw new Error('simulated broken logger');
    });

    expect(() => vi.advanceTimersByTime(DRAIN_MAX_WAIT_MS)).not.toThrow();
  });

  it('injectMessageDetailed returning { ok: false } (NOT_RUNNING/DEDUPED) is logged accurately, not claimed as sent', () => {
    const { proc, state, logFn } = makeRunningProcess('hermes');
    state.bootstrapped = false;
    proc.injectMessageQueued('real cron content');
    const spy = vi.spyOn(proc as any, 'injectMessageDetailed').mockReturnValueOnce({
      ok: false,
      code: 'DEDUPED',
      message: 'test dedup',
    });

    vi.advanceTimersByTime(DRAIN_MAX_WAIT_MS);
    expect(spy).toHaveBeenCalledTimes(1);
    const logged = logFn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/not sent \(DEDUPED\)/);
  });

  it('a successful injection whose success-path log call itself throws is still contained', () => {
    const { proc, state, logFn } = makeRunningProcess('hermes');
    state.bootstrapped = false;
    proc.injectMessageQueued('real cron content');
    logFn.mockImplementationOnce(() => {
      throw new Error('simulated broken logger on the success path');
    });

    expect(() => vi.advanceTimersByTime(DRAIN_MAX_WAIT_MS)).not.toThrow();
    expect(mockInjectMessage).toHaveBeenCalledTimes(1);
  });

  it('bootstrap-transition preserves queued content: delivers the ORIGINAL item via the unlogged overdue path, not the nudge string', () => {
    const { proc, state } = makeRunningProcess('hermes');
    state.bootstrapped = false;
    proc.injectMessageQueued('real cron content', { cron: 'starver', firedAt: '2026-09-28T00:00:00.000Z' });

    // Nudge fires once the item is overdue (readyBaseline uses the same DRAIN_MAX_WAIT_MS,
    // so head.enqueuedAt is also already past it by construction).
    vi.advanceTimersByTime(DRAIN_MAX_WAIT_MS);
    expect(mockInjectMessage).toHaveBeenCalledTimes(1);
    expect(mockInjectMessage.mock.calls[0][1]).not.toBe('real cron content');

    // Simulate a successful re-latch and let the existing, unmodified bootstrapped path drain
    // the ORIGINAL item.
    mockInjectMessage.mockClear();
    state.bootstrapped = true;
    vi.advanceTimersByTime(TICK);
    expect(mockInjectMessage).toHaveBeenCalledTimes(1);
    expect(mockInjectMessage.mock.calls[0][1]).toBe('real cron content');

    // Matching the existing line-380 test's own pattern: even a CONFIRMED accept on this
    // (already-overdue) path must not produce a delivery record.
    mockInjectMessage.mock.calls[0][3].onAccepted();
    expect(mockAppendDeliveryLog).not.toHaveBeenCalled();
  });

  it('runtime gating: a non-hermes runtime never nudges, even stalled well past DRAIN_MAX_WAIT_MS', () => {
    const { proc, state } = makeRunningProcess('opencode');
    state.bootstrapped = false;
    proc.injectMessageQueued('real cron content');

    vi.advanceTimersByTime(DRAIN_MAX_WAIT_MS * 2);
    expect(mockInjectMessage).not.toHaveBeenCalled();
  });
});
