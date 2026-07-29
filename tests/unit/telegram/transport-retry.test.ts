import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import net from 'node:net';
import dns from 'node:dns';
import { TelegramAPI, classifyTransportFailure } from '../../../src/telegram/api';
import {
  applyTelegramNetTuning,
  resetTelegramNetTuningForTests,
} from '../../../src/telegram/net-tuning';

/**
 * The exact error Node produces for this fault, captured from a live failure on
 * 2026-07-29 rather than invented: happy-eyeballs races both families, both legs
 * fail during connect, and undici reports an AggregateError.
 */
function realWorldConnectFailure(): Error {
  const legs = [
    Object.assign(new Error('connect ETIMEDOUT 149.154.167.99:443'), {
      code: 'ETIMEDOUT',
      syscall: 'connect',
      address: '149.154.167.99',
      port: 443,
    }),
    Object.assign(new Error('connect ENETUNREACH 2001:67c:4e8:f004::9:443'), {
      code: 'ENETUNREACH',
      syscall: 'connect',
      address: '2001:67c:4e8:f004::9',
      port: 443,
    }),
  ];
  const agg = Object.assign(new AggregateError(legs, ''), { code: 'ETIMEDOUT' });
  return new TypeError('fetch failed', { cause: agg });
}

/** Same shape, except one leg failed while READING a response — so a request may
 *  already have been delivered and a retry could duplicate it. */
function ambiguousMidResponseFailure(): Error {
  const legs = [
    Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', syscall: 'read' }),
    Object.assign(new Error('connect ENETUNREACH'), { code: 'ENETUNREACH', syscall: 'connect' }),
  ];
  return new TypeError('fetch failed', { cause: new AggregateError(legs, '') });
}

function okResponse(messageId = 42) {
  return {
    json: async () => ({ ok: true, result: { message_id: messageId } }),
  } as unknown as Response;
}

describe('classifyTransportFailure', () => {
  it('treats the real happy-eyeballs connect failure as never_sent', () => {
    expect(classifyTransportFailure(realWorldConnectFailure())).toBe('never_sent');
  });

  it('SABOTAGE: flipping one leg from connect to read makes it ambiguous', () => {
    // If this returned never_sent, the never_sent check would be vacuous — it would
    // be waving through failures that could have been delivered.
    expect(classifyTransportFailure(ambiguousMidResponseFailure())).toBe('ambiguous');
  });

  it('does not assume a bare ETIMEDOUT with no syscall is safe', () => {
    const err = new TypeError('fetch failed', { cause: { code: 'ETIMEDOUT' } });
    expect(classifyTransportFailure(err)).toBe('ambiguous');
  });

  it('classifies a Telegram-level rejection as fatal', () => {
    expect(classifyTransportFailure(new Error('Telegram API error: chat not found'))).toBe('fatal');
  });

  it('classifies pre-write codes as never_sent even without an aggregate', () => {
    expect(classifyTransportFailure(Object.assign(new Error('x'), { code: 'ENOTFOUND' })))
      .toBe('never_sent');
  });
});

describe('post() retry behaviour', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'cortextos-telegram-retry-'));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function readJournal(agent: string): any[] {
    const p = join(stateDir, 'logs', agent, 'outbound-deliveries.jsonl');
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
  }

  it('retries a send after a never_sent failure and delivers exactly once', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => { throw realWorldConnectFailure(); })
      .mockResolvedValueOnce(okResponse(7));
    vi.stubGlobal('fetch', fetchMock);

    const api = new TelegramAPI('123:abc', { ctxRoot: stateDir, agentName: 'tester' });
    const p = api.sendMessage(555, 'hello');
    await vi.runAllTimersAsync();
    const res = await p;

    expect(res.result.message_id).toBe(7);
    // The load-bearing assertion is the CALL COUNT: two attempts, so exactly one
    // extra send happened — not zero (no retry) and not three (over-retry).
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const accepted = readJournal('tester').filter((r) => r.state === 'accepted');
    expect(accepted).toHaveLength(1);
    // A record claiming attempts:1 for a delivery that took two tries would hide
    // exactly the flakiness this change exists to surface.
    expect(accepted[0].attempts).toBe(2);
  });

  it('does NOT retry a send after an ambiguous failure (duplicate-message risk)', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => { throw ambiguousMidResponseFailure(); });
    vi.stubGlobal('fetch', fetchMock);

    const api = new TelegramAPI('123:abc', { ctxRoot: stateDir, agentName: 'tester' });
    const p = api.sendMessage(555, 'hello');
    // Attach the rejection handler BEFORE draining timers. Awaiting the drain
    // first leaves the rejection momentarily unhandled, which Node reports as an
    // unhandled rejection even though the test passes — noise that hides real ones.
    const rejects = expect(p).rejects.toThrow(/request failed/i);
    await vi.runAllTimersAsync();
    await rejects;

    // Called once and only once: retrying here is what would double-send.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('DOES retry an idempotent read after an ambiguous failure', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => { throw ambiguousMidResponseFailure(); })
      .mockResolvedValueOnce({ json: async () => ({ ok: true, result: { id: 1 } }) } as any);
    vi.stubGlobal('fetch', fetchMock);

    const api = new TelegramAPI('123:abc');
    const p = api.getMe();
    await vi.runAllTimersAsync();
    await p;

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a Telegram-level rejection', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ ok: false, description: 'chat not found' }),
    } as any);
    vi.stubGlobal('fetch', fetchMock);

    const api = new TelegramAPI('123:abc');
    const p = api.getMe();
    const rejects = expect(p).rejects.toThrow(/chat not found/);
    await vi.runAllTimersAsync();
    await rejects;

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after MAX_ATTEMPTS rather than looping forever', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => { throw realWorldConnectFailure(); });
    vi.stubGlobal('fetch', fetchMock);

    const api = new TelegramAPI('123:abc');
    const p = api.sendMessage(555, 'hello');
    const rejects = expect(p).rejects.toThrow();
    await vi.runAllTimersAsync();
    await rejects;

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('net tuning', () => {
  const origOrder = dns.getDefaultResultOrder?.();
  const origAuto = net.getDefaultAutoSelectFamily?.();

  afterEach(() => {
    resetTelegramNetTuningForTests();
    if (origOrder) dns.setDefaultResultOrder(origOrder as any);
    if (typeof origAuto === 'boolean') net.setDefaultAutoSelectFamily(origAuto);
    delete process.env.CORTEXTOS_TELEGRAM_NET_TUNING;
  });

  it('actually disables the family race, not just reports that it did', () => {
    resetTelegramNetTuningForTests();
    net.setDefaultAutoSelectFamily(true);
    expect(applyTelegramNetTuning()).toBe('applied');
    // Assert the observable effect. Trusting the return value would pass even if
    // the function did nothing at all.
    expect(net.getDefaultAutoSelectFamily()).toBe(false);
    expect(dns.getDefaultResultOrder()).toBe('ipv4first');
  });

  it('honours the env opt-out and leaves Node defaults untouched', () => {
    resetTelegramNetTuningForTests();
    net.setDefaultAutoSelectFamily(true);
    process.env.CORTEXTOS_TELEGRAM_NET_TUNING = 'off';
    expect(applyTelegramNetTuning()).toBe('skipped-env');
    expect(net.getDefaultAutoSelectFamily()).toBe(true);
  });

  it('is idempotent', () => {
    resetTelegramNetTuningForTests();
    expect(applyTelegramNetTuning()).toBe('applied');
    expect(applyTelegramNetTuning()).toBe('applied');
  });
});
