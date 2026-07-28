/**
 * Outbound Telegram send attempts must leave a durable record, including the
 * failures.
 *
 * Bug context: `logOutboundMessage` is called inside the try block, after the
 * await resolves, so outbound-messages.jsonl only ever contained successes. A
 * failed send printed its reason to the calling agent's stderr and then died
 * with the session. That log then reads as evidence of health -- analysing
 * 5,466 sends on 2026-07-28 produced a confident "delivery is fine" that was
 * pure survivorship bias, because no failure was ever written to the file
 * being counted.
 *
 * The classifier is the part worth testing rather than merely running: it
 * decides retryable vs dead-letter, and a wrongly-"retryable" permanent error
 * (bad chat_id, blocked bot, malformed HTML) is how one undelivered message
 * becomes six duplicates plus a flooded journal.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  classifyOutboundError,
  createOutboundDeliveryId,
  recordOutboundDelivery,
} from '../../../src/telegram/outbound-journal';

describe('classifyOutboundError', () => {
  it('treats genuinely transient failures as retryable', () => {
    for (const msg of [
      'Request timed out',
      'Telegram API error: 429 Too Many Requests',
      'retry after 30',
      'Telegram API error: 502 Bad Gateway',
      'Request failed: ECONNRESET',
    ]) {
      expect(classifyOutboundError(msg), msg).toBe('retryable');
    }
  });

  it('dead-letters permanent failures, so a retry loop can never form', () => {
    for (const msg of [
      'Telegram API error: Unauthorized',
      'Telegram API error: Bad Request: chat not found',
      'Telegram API error: Forbidden: bot was blocked by the user',
      "Telegram API error: Bad Request: can't parse entities",
    ]) {
      expect(classifyOutboundError(msg), msg).toBe('dead-letter');
    }
  });

  it('dead-letters anything it does not recognise', () => {
    // Conservative on purpose: retrying an unknown failure is the expensive
    // direction of the error. Silence is cheaper than a duplicate storm.
    expect(classifyOutboundError('something nobody has seen before')).toBe('dead-letter');
  });
});

describe('recordOutboundDelivery', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'otx-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const read = () =>
    readFileSync(join(root, 'logs', 'a1', 'outbound-deliveries.jsonl'), 'utf-8')
      .trim().split('\n').map((l) => JSON.parse(l));

  it('correlates the attempt and its outcome under one delivery_id', () => {
    const id = createOutboundDeliveryId();
    const base = { delivery_id: id, agent: 'a1', chat_id: '42', attempts: 1, kind: 'message' as const, preview: 'hi' };
    recordOutboundDelivery(root, 'a1', { ...base, state: 'delivering' });
    recordOutboundDelivery(root, 'a1', { ...base, state: 'dead-letter', error: 'chat not found' });

    const rows = read();
    expect(rows.map((r) => r.state)).toEqual(['delivering', 'dead-letter']);
    // The whole point: the failure is on disk, not only on a dead session's stderr.
    expect(rows[1].error).toBe('chat not found');
    expect(new Set(rows.map((r) => r.delivery_id)).size).toBe(1);
  });

  it('never throws, so journalling cannot break the send it observes', () => {
    expect(() =>
      recordOutboundDelivery('\0://not-a-path', 'a1', {
        delivery_id: 'x', agent: 'a1', chat_id: '42', state: 'accepted',
        attempts: 1, kind: 'message', preview: 'hi',
      }),
    ).not.toThrow();
  });
});
