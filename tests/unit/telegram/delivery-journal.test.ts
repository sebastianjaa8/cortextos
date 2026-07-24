import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  TelegramDeliveryJournal,
  createTelegramDeliveryId,
} from '../../../src/telegram/delivery-journal';
import type { TelegramUpdate } from '../../../src/types';

function update(updateId: number, text: string): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: 42, type: 'private' },
      text,
    },
  };
}

describe('TelegramDeliveryJournal', () => {
  let stateDir: string;
  let nowMs: number;
  let journal: TelegramDeliveryJournal;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'cortextos-telegram-journal-'));
    nowMs = Date.parse('2026-07-23T12:00:00.000Z');
    journal = new TelegramDeliveryJournal(stateDir, {
      agentName: 'eros',
      botId: '123456',
      maxAttempts: 3,
      initialBackoffMs: 100,
      maxBackoffMs: 1_000,
      now: () => new Date(nowMs),
    });
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('uses agent, bot, and update ID rather than message text for stable IDs', () => {
    const first = journal.journalUpdate(update(10, 'identical'));
    const duplicate = journal.journalUpdate(update(10, 'changed redelivery body'));
    const second = journal.journalUpdate(update(11, 'identical'));

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.record.delivery_id).toBe(first.record.delivery_id);
    expect(second.record.delivery_id).not.toBe(first.record.delivery_id);
    expect(first.record.delivery_id).toBe(createTelegramDeliveryId('eros', '123456', 10));
    expect(readdirSync(join(stateDir, '.telegram-deliveries')).every((name) => name.endsWith('.json'))).toBe(true);
  });

  it('tracks dispatch attempts, exponential backoff, acceptance, and dead-lettering', () => {
    const retrying = journal.journalUpdate(update(20, 'retry me')).record;
    expect(journal.markDelivering(retrying.delivery_id).attempts).toBe(1);

    const firstFailure = journal.markFailure(retrying.delivery_id, new Error('offline'));
    expect(firstFailure.state).toBe('retryable');
    expect(firstFailure.next_attempt_at).toBe('2026-07-23T12:00:00.100Z');
    expect(journal.listReady()).toEqual([]);

    nowMs += 100;
    expect(journal.listReady().map((record) => record.delivery_id)).toEqual([retrying.delivery_id]);
    expect(journal.markDelivering(retrying.delivery_id).attempts).toBe(2);
    const secondFailure = journal.markFailure(retrying.delivery_id, 'still offline');
    expect(secondFailure.next_attempt_at).toBe('2026-07-23T12:00:00.300Z');

    nowMs += 200;
    expect(journal.markDelivering(retrying.delivery_id).attempts).toBe(3);
    expect(journal.markFailure(retrying.delivery_id, 'last failure').state).toBe('dead-letter');

    const accepted = journal.journalUpdate(update(21, 'accept me')).record;
    journal.markDelivering(accepted.delivery_id);
    expect(journal.markAccepted(accepted.delivery_id).state).toBe('accepted');
  });

  it('recovers interrupted delivering records after restart', () => {
    const record = journal.journalUpdate(update(30, 'survive restart')).record;
    journal.markDelivering(record.delivery_id);

    const restarted = new TelegramDeliveryJournal(stateDir, {
      agentName: 'eros',
      botId: '123456',
      now: () => new Date(nowMs),
    });
    const recovered = restarted.recoverPending();

    expect(recovered.map((item) => item.delivery_id)).toEqual([record.delivery_id]);
    expect(restarted.get(record.delivery_id)?.state).toBe('retryable');
  });

  it('never exposes message or error bodies in health metadata', () => {
    const secret = 'TOP SECRET MESSAGE BODY';
    const record = journal.journalUpdate(update(40, secret)).record;
    journal.markDelivering(record.delivery_id);
    journal.markFailure(record.delivery_id, new Error(`failed while handling ${secret}`));

    const serialized = JSON.stringify(journal.getHealth());
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('failed while handling');
    expect(journal.getHealth()).toMatchObject({
      total: 1,
      pending: 1,
      counts: { retryable: 1 },
    });
  });

  it('bounds accepted history by age and count when rebuilding the index', () => {
    for (let id = 50; id < 53; id++) {
      const record = journal.journalUpdate(update(id, `accepted-${id}`)).record;
      journal.markDelivering(record.delivery_id);
      journal.markAccepted(record.delivery_id);
      nowMs += 10;
    }

    const countBounded = new TelegramDeliveryJournal(stateDir, {
      agentName: 'eros',
      botId: '123456',
      maxAcceptedRecords: 2,
      acceptedRetentionMs: 1_000,
      now: () => new Date(nowMs),
    });
    expect(countBounded.getHealth().total).toBe(2);

    nowMs += 2_000;
    const ageBounded = new TelegramDeliveryJournal(stateDir, {
      agentName: 'eros',
      botId: '123456',
      maxAcceptedRecords: 2,
      acceptedRetentionMs: 1_000,
      now: () => new Date(nowMs),
    });
    expect(ageBounded.getHealth().total).toBe(0);
    expect(readdirSync(join(stateDir, '.telegram-deliveries'))).toHaveLength(0);
  });

  it('reports stale unacknowledged and corrupt records as unhealthy without exposing bodies', () => {
    const record = journal.journalUpdate(update(60, 'private body')).record;
    journal.markDelivering(record.delivery_id);
    nowMs += 5 * 60 * 1_000 + 1;

    const corruptId = createTelegramDeliveryId('eros', '123456', 61);
    writeFileSync(join(stateDir, '.telegram-deliveries', `${corruptId}.json`), '{broken', 'utf8');
    const rebuilt = new TelegramDeliveryJournal(stateDir, {
      agentName: 'eros',
      botId: '123456',
      staleDeliveryMs: 5 * 60 * 1_000,
      now: () => new Date(nowMs),
    });

    const health = rebuilt.getHealth();
    expect(health).toMatchObject({
      healthy: false,
      stale_delivering: 1,
      corrupt_records: 1,
    });
    expect(JSON.stringify(health)).not.toContain('private body');
  });
});
