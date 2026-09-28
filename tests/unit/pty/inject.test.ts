import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageDedup, KEYS, injectMessage } from '../../../src/pty/inject';

describe('MessageDedup', () => {
  it('detects duplicate content', () => {
    const dedup = new MessageDedup();
    expect(dedup.isDuplicate('hello world')).toBe(false);
    expect(dedup.isDuplicate('hello world')).toBe(true);
  });

  it('allows different content', () => {
    const dedup = new MessageDedup();
    expect(dedup.isDuplicate('message 1')).toBe(false);
    expect(dedup.isDuplicate('message 2')).toBe(false);
  });

  it('evicts old entries', () => {
    const dedup = new MessageDedup(3);
    dedup.isDuplicate('msg1');
    dedup.isDuplicate('msg2');
    dedup.isDuplicate('msg3');
    dedup.isDuplicate('msg4'); // evicts msg1
    expect(dedup.isDuplicate('msg1')).toBe(false); // no longer in cache
    expect(dedup.isDuplicate('msg4')).toBe(true); // still in cache
  });

  it('forget() un-poisons a hash so an identical re-send passes', () => {
    const dedup = new MessageDedup();
    expect(dedup.isDuplicate('lost message')).toBe(false); // recorded
    dedup.forget('lost message'); // submit failed — un-poison
    expect(dedup.isDuplicate('lost message')).toBe(false); // re-send allowed
    expect(dedup.isDuplicate('lost message')).toBe(true);  // normal dedup resumes
  });

  it('forget() on unknown content is a no-op', () => {
    const dedup = new MessageDedup();
    dedup.isDuplicate('other');
    expect(() => dedup.forget('never seen')).not.toThrow();
    expect(dedup.isDuplicate('other')).toBe(true);
  });
});

describe('KEYS', () => {
  it('has correct escape sequences', () => {
    expect(KEYS.ENTER).toBe('\r');
    expect(KEYS.CTRL_C).toBe('\x03');
    expect(KEYS.DOWN).toBe('\x1b[B');
    expect(KEYS.UP).toBe('\x1b[A');
    expect(KEYS.SPACE).toBe(' ');
  });
});

describe('injectMessage — deferred Enter crash safety', () => {
  // Regression guard for the 2026-04-22 storm. worker-process.ts:93 passed
  // an unsafe `this.pty!.write` callback; when PTY was torn down during the
  // 300ms enterDelay window the setTimeout fired null.write → uncaught
  // TypeError → daemon crash. The fix wraps the deferred write in try/catch.
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    warnSpy.mockRestore();
  });

  it('swallows throw from the deferred Enter callback without crashing', () => {
    const writes: string[] = [];
    // Caller's write is "safe" during the synchronous paste but starts
    // throwing by the time the deferred Enter fires — simulates PTY teardown.
    let ptyAlive = true;
    const write = (data: string) => {
      if (!ptyAlive) throw new TypeError("Cannot read properties of null (reading 'write')");
      writes.push(data);
    };

    // Synchronous calls (paste markers + content) should succeed.
    expect(() => injectMessage(write, 'hello', 300)).not.toThrow();
    expect(writes.length).toBeGreaterThan(0);

    // PTY dies before the 300ms Enter timeout fires.
    ptyAlive = false;

    // Advancing the clock invokes the deferred callback. Must NOT propagate.
    expect(() => vi.advanceTimersByTime(300)).not.toThrow();

    // The warn path in inject.ts confirms the catch branch ran.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/deferred Enter failed/);
  });

  it('sends Enter normally when the PTY stays alive', () => {
    const writes: string[] = [];
    const write = (data: string) => { writes.push(data); };

    injectMessage(write, 'hi', 300);
    const writesBeforeTimer = writes.length;
    vi.advanceTimersByTime(300);

    // Exactly one new write — the ENTER keystroke — and no warn.
    expect(writes.length).toBe(writesBeforeTimer + 1);
    expect(writes[writes.length - 1]).toBe(KEYS.ENTER);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('injectMessage — verified submit (Enter retry)', () => {
  // Regression guard for the 2026-07-01 incident: Claude Code renders large
  // pastes as an async "[Pasted text #N]" placeholder; under load the fixed
  // enterDelay elapsed before placeholder registration, the Enter landed on
  // an empty composer, and Telegram messages sat unsubmitted for hours.
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const countEnters = (writes: string[]) => writes.filter(w => w === KEYS.ENTER).length;

  it('re-sends Enter when PTY output stays silent after the first Enter', () => {
    const writes: string[] = [];
    const write = (data: string) => { writes.push(data); };
    let outputBytes = 0;
    const logs: string[] = [];

    injectMessage(write, 'long research message', 300, {
      getOutputBytes: () => outputBytes,
      log: (m) => logs.push(m),
    });

    vi.advanceTimersByTime(300); // first Enter
    expect(countEnters(writes)).toBe(1);

    // No output growth → first retry at +4000ms
    vi.advanceTimersByTime(4000);
    expect(countEnters(writes)).toBe(2);
    expect(logs.some(l => l.includes('re-sending Enter'))).toBe(true);

    // Retry worked — big repaint burst. No further Enters.
    outputBytes += 5000;
    vi.advanceTimersByTime(120000);
    expect(countEnters(writes)).toBe(2);
  });

  it('does not retry when the submit produced output', () => {
    const writes: string[] = [];
    const write = (data: string) => { writes.push(data); };
    let outputBytes = 0;

    injectMessage(write, 'hi', 300, { getOutputBytes: () => outputBytes });

    vi.advanceTimersByTime(300); // Enter sent
    outputBytes += 5000;         // turn started streaming
    vi.advanceTimersByTime(120000);
    expect(countEnters(writes)).toBe(1);
  });

  it('gives up after bounded retries and logs exhaustion', () => {
    const writes: string[] = [];
    const write = (data: string) => { writes.push(data); };
    const logs: string[] = [];

    injectMessage(write, 'msg', 300, {
      getOutputBytes: () => 0,
      log: (m) => logs.push(m),
    });

    vi.advanceTimersByTime(300);
    vi.advanceTimersByTime(120000);
    expect(countEnters(writes)).toBe(4); // initial + 3 retries
    expect(logs.some(l => l.includes('retries exhausted'))).toBe(true);
  });

  it('fires onFailed when retries exhaust with zero output (dedup un-poisoning)', () => {
    const write = () => { /* pty accepts writes but agent never repaints */ };
    const onFailed = vi.fn();

    injectMessage(write, 'msg', 300, {
      getOutputBytes: () => 0,
      onFailed,
    });

    vi.advanceTimersByTime(300);
    expect(onFailed).not.toHaveBeenCalled(); // still retrying
    vi.advanceTimersByTime(120000);
    expect(onFailed).toHaveBeenCalledTimes(1);
  });

  it('fires onFailed when the deferred Enter write throws (PTY teardown)', () => {
    let ptyAlive = true;
    const write = (_: string) => {
      if (!ptyAlive) throw new TypeError('null.write');
    };
    const onFailed = vi.fn();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    injectMessage(write, 'msg', 300, { getOutputBytes: () => 0, onFailed });
    ptyAlive = false;
    vi.advanceTimersByTime(300);
    expect(onFailed).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('does not fire onFailed on a successful verified submit', () => {
    const write = () => { /* ok */ };
    let outputBytes = 0;
    const onFailed = vi.fn();

    injectMessage(write, 'msg', 300, { getOutputBytes: () => outputBytes, onFailed });
    vi.advanceTimersByTime(300);
    outputBytes += 5000; // turn started
    vi.advanceTimersByTime(120000);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it('fires onAccepted only after PTY output proves the turn started', () => {
    const write = () => { /* ok */ };
    let outputBytes = 0;
    const onAccepted = vi.fn();
    const onFailed = vi.fn();

    injectMessage(write, 'msg', 300, {
      getOutputBytes: () => outputBytes,
      onAccepted,
      onFailed,
    });
    vi.advanceTimersByTime(300);
    expect(onAccepted).not.toHaveBeenCalled();
    outputBytes += 5000;
    vi.advanceTimersByTime(4000);
    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it('fires onSubmitted at the Enter write without treating unrelated output as delivery proof', () => {
    const writes: string[] = [];
    const onSubmitted = vi.fn();
    const onAccepted = vi.fn();

    injectMessage((data) => writes.push(data), 'msg', 300, { onSubmitted, onAccepted });
    vi.advanceTimersByTime(299);
    expect(onSubmitted).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(writes.at(-1)).toBe(KEYS.ENTER);
    expect(onSubmitted).toHaveBeenCalledTimes(1);
    expect(onAccepted).not.toHaveBeenCalled();
  });

  it('scales the default enterDelay with content size', () => {
    const writes: string[] = [];
    const write = (data: string) => { writes.push(data); };

    injectMessage(write, 'x'.repeat(2000)); // no explicit delay → 900 + 1000 = 1900ms
    vi.advanceTimersByTime(899);
    expect(countEnters(writes)).toBe(0);
    vi.advanceTimersByTime(1100); // 1999ms total
    expect(countEnters(writes)).toBe(1);
  });
});

describe('injectMessage — verify-callback crash containment (task_1790591432216_84154671)', () => {
  // Round 7 of the drainTick never-bootstrapped-nudge plan review found that a caller-supplied
  // verify callback (log/onAccepted/onFailed/onSubmitted/getOutputBytes) throwing inside these
  // setTimeout callbacks would escape uncaught — no surrounding handler existed here before this
  // fix, and drainTick()'s new nudge exercises this async path in a state (unbootstrapped) that
  // previously never reached it, so a callback throw here could crash the whole daemon process
  // (src/daemon/index.ts's uncaughtException handler calls process.exit(1)).
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('a throwing verify.onSubmitted does not crash the deferred handler', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    injectMessage(() => {}, 'msg', 300, {
      onSubmitted: () => { throw new Error('onSubmitted boom'); },
    });
    expect(() => vi.advanceTimersByTime(300)).not.toThrow();
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('deferred submit handling failed'))).toBe(true);
    warnSpy.mockRestore();
  });

  it("a throwing verify.getOutputBytes on its FIRST call (outer handler, before check() exists) does not crash the deferred handler", () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    injectMessage(() => {}, 'msg', 300, {
      getOutputBytes: () => { throw new Error('getOutputBytes boom'); },
    });
    expect(() => vi.advanceTimersByTime(300)).not.toThrow();
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('deferred submit handling failed'))).toBe(true);
    warnSpy.mockRestore();
  });

  it('a throwing verify.onAccepted inside check() does not crash the retry loop', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let outputBytes = 0;
    injectMessage(() => {}, 'msg', 300, {
      getOutputBytes: () => outputBytes,
      onAccepted: () => { throw new Error('onAccepted boom'); },
    });
    vi.advanceTimersByTime(300); // Enter sent, check() scheduled
    outputBytes += 5000; // growth on the next check() tick triggers onAccepted
    expect(() => vi.advanceTimersByTime(4000)).not.toThrow();
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('verify-retry check failed'))).toBe(true);
    warnSpy.mockRestore();
  });

  it('a throwing verify.log at the EXHAUSTION point specifically (not the interim retry logs) does not crash the retry loop', () => {
    // The original version of this test threw from EVERY log() call, so it exited at the
    // FIRST retry's "re-sending Enter" log — never reaching the exhaustion branch at all
    // (review finding: "exercises a different branch"). Throwing only when the message
    // identifies the exhaustion log distinguishes the two call sites and proves the retry loop
    // ran to genuine exhaustion (3 interim retries logged) before the throw, not an early exit.
    // Source order is `verify.log?.(...)` THEN `verify.onFailed?.(...)` at exhaustion — the log
    // throw is expected to prevent onFailed from ever running in THIS scenario (that pairing is
    // covered by the next test, where log succeeds and onFailed is what throws).
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onFailed = vi.fn();
    const interimLogs: string[] = [];
    injectMessage(() => {}, 'msg', 300, {
      getOutputBytes: () => 0,
      onFailed,
      log: (msg) => {
        if (msg.includes('retries exhausted')) throw new Error('log boom at exhaustion');
        interimLogs.push(msg);
      },
    });
    vi.advanceTimersByTime(300); // first Enter
    expect(() => vi.advanceTimersByTime(120000)).not.toThrow(); // drives all the way to exhaustion
    expect(interimLogs).toHaveLength(3); // all 3 retries logged normally before the exhaustion throw
    expect(onFailed).not.toHaveBeenCalled(); // never reached — the exhaustion log throws first
    warnSpy.mockRestore();
  });

  it('a throwing verify.onFailed AT exhaustion (log succeeds normally) does not crash the retry loop', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logs: string[] = [];
    // vi.fn() still records the call in .mock.calls even when its own implementation throws
    // (the call is registered before the implementation runs) — used here specifically so the
    // test can assert onFailed was genuinely INVOKED, not just that its throw was contained.
    const onFailed = vi.fn(() => { throw new Error('onFailed boom at exhaustion'); });
    injectMessage(() => {}, 'msg', 300, {
      getOutputBytes: () => 0,
      log: (msg) => { logs.push(msg); },
      onFailed,
    });
    vi.advanceTimersByTime(300);
    expect(() => vi.advanceTimersByTime(120000)).not.toThrow();
    expect(logs.some((l) => l.includes('retries exhausted'))).toBe(true); // exhaustion genuinely reached
    expect(onFailed).toHaveBeenCalledTimes(1); // onFailed itself genuinely ran, not just skipped over
    warnSpy.mockRestore();
  });

  it('a throwing verify.getOutputBytes on a SUBSEQUENT call (inside check()s retry sampling, not the first) does not crash the retry loop', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let call = 0;
    injectMessage(() => {}, 'msg', 300, {
      getOutputBytes: () => {
        call++;
        if (call === 1) return 0; // baseline capture in the outer handler succeeds
        throw new Error('getOutputBytes boom on retry sampling');
      },
    });
    vi.advanceTimersByTime(300); // baseline captured successfully
    expect(() => vi.advanceTimersByTime(4000)).not.toThrow(); // check()'s own call throws
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('verify-retry check failed'))).toBe(true);
    warnSpy.mockRestore();
  });

  it('a throwing verify.onFailed after an Enter WRITE failure (not retries-exhausted) does not crash the deferred handler', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let ptyAlive = true;
    const write = (_: string) => {
      if (!ptyAlive) throw new TypeError('null.write');
    };
    injectMessage(write, 'msg', 300, {
      getOutputBytes: () => 0,
      onFailed: () => { throw new Error('onFailed boom'); },
    });
    ptyAlive = false;
    expect(() => vi.advanceTimersByTime(300)).not.toThrow();
    warnSpy.mockRestore();
  });

  it('a throwing verify.onFailed after a RETRY Enter write failure (inside check()) does not crash the retry loop', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let enterCount = 0;
    const write = (data: string) => {
      if (data === KEYS.ENTER) {
        enterCount++;
        if (enterCount === 2) throw new TypeError('null.write on retry');
      }
    };
    const onFailed = vi.fn(() => { throw new Error('onFailed boom on retry'); });
    injectMessage(write, 'msg', 300, {
      getOutputBytes: () => 0, // never grows -> triggers a retry
      onFailed,
    });
    vi.advanceTimersByTime(300); // first Enter succeeds
    expect(() => vi.advanceTimersByTime(4000)).not.toThrow(); // retry Enter throws -> onFailed throws
    expect(enterCount).toBe(2); // the retry write genuinely happened and genuinely threw
    expect(onFailed).toHaveBeenCalledTimes(1); // onFailed genuinely ran, not skipped over
    warnSpy.mockRestore();
  });

  it('[R8] a throwing console.warn on top of a throwing callback is still contained (outer handler)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('warn boom'); });
    injectMessage(() => {}, 'msg', 300, {
      onSubmitted: () => { throw new Error('onSubmitted boom'); },
    });
    expect(() => vi.advanceTimersByTime(300)).not.toThrow();
    warnSpy.mockRestore();
  });

  it('[R8] a throwing console.warn on top of a throwing callback is still contained (check() closure)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('warn boom'); });
    let outputBytes = 0;
    const onAccepted = vi.fn(() => { throw new Error('onAccepted boom'); });
    injectMessage(() => {}, 'msg', 300, {
      getOutputBytes: () => outputBytes,
      onAccepted,
    });
    vi.advanceTimersByTime(300);
    outputBytes += 5000;
    expect(() => vi.advanceTimersByTime(4000)).not.toThrow();
    expect(onAccepted).toHaveBeenCalledTimes(1); // the triggering callback genuinely ran
    expect(warnSpy).toHaveBeenCalledTimes(1); // the (also-throwing) reporting call was attempted
    warnSpy.mockRestore();
  });

  it('[R8] a thrown value whose toString() itself throws does not escape either catch (outer handler)', () => {
    // console.warn(...) is never actually INVOKED in this scenario — the throw happens while
    // building its argument (the template literal's String(err) call), before the call
    // expression itself runs. The containment here is the inner try/catch around the whole
    // console.warn(...) statement, not console.warn surviving a throw from within itself.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const evil = { toString() { throw new Error('conversion boom'); } };
    const onSubmitted = vi.fn(() => { throw evil; });
    injectMessage(() => {}, 'msg', 300, { onSubmitted });
    expect(() => vi.advanceTimersByTime(300)).not.toThrow();
    expect(onSubmitted).toHaveBeenCalledTimes(1); // the triggering callback genuinely ran
    expect(warnSpy).not.toHaveBeenCalled(); // confirms WHERE containment happened: arg-building, not the call itself
    warnSpy.mockRestore();
  });

  it('[R8] a thrown value whose toString() itself throws does not escape either catch (check() closure)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const evil = { toString() { throw new Error('conversion boom'); } };
    let outputBytes = 0;
    const onAccepted = vi.fn(() => { throw evil; });
    injectMessage(() => {}, 'msg', 300, {
      getOutputBytes: () => outputBytes,
      onAccepted,
    });
    vi.advanceTimersByTime(300);
    outputBytes += 5000;
    expect(() => vi.advanceTimersByTime(4000)).not.toThrow();
    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled(); // same reason as the outer-handler case above
    warnSpy.mockRestore();
  });
});
