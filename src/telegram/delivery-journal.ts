import { createHash } from 'crypto';
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { TelegramUpdate } from '../types/index.js';
import { atomicWriteDurableSync, ensureDir } from '../utils/atomic.js';

export const TELEGRAM_DELIVERY_STATES = [
  'queued',
  'delivering',
  'accepted',
  'retryable',
  'dead-letter',
] as const;

export type TelegramDeliveryState = typeof TELEGRAM_DELIVERY_STATES[number];

export interface TelegramDeliveryRecord {
  version: 1;
  delivery_id: string;
  agent_name: string;
  bot_id: string;
  update_id: number;
  state: TelegramDeliveryState;
  attempts: number;
  created_at: string;
  updated_at: string;
  next_attempt_at?: string;
  last_error?: string;
  update: TelegramUpdate;
}

export interface TelegramDeliveryHealth {
  healthy: boolean;
  total: number;
  pending: number;
  stale_delivering: number;
  corrupt_records: number;
  counts: Record<TelegramDeliveryState, number>;
  oldest_pending_at?: string;
  next_retry_at?: string;
}

export interface TelegramDeliveryJournalOptions {
  agentName: string;
  botId: string;
  maxAttempts?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  acceptedRetentionMs?: number;
  maxAcceptedRecords?: number;
  staleDeliveryMs?: number;
  now?: () => Date;
}

export interface JournalUpdateResult {
  record: TelegramDeliveryRecord;
  created: boolean;
}

/**
 * Stable across process restarts and independent of message content.
 * The hash keeps agent and bot identifiers safe for use as file names.
 */
export function createTelegramDeliveryId(
  agentName: string,
  botId: string,
  updateId: number,
): string {
  const digest = createHash('sha256')
    .update(`${agentName}\0${botId}\0${updateId}`)
    .digest('hex')
    .slice(0, 32);
  return `tg-${digest}`;
}

/**
 * Durable state machine for inbound Telegram updates.
 *
 * Each delivery is one atomically replaced JSON file. This avoids a shared
 * append/manifest corruption point and makes an already-journaled update
 * idempotent when Telegram redelivers it.
 */
export class TelegramDeliveryJournal {
  private readonly journalDir: string;
  private readonly agentName: string;
  private readonly botId: string;
  private readonly maxAttempts: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => Date;
  private readonly acceptedRetentionMs: number;
  private readonly maxAcceptedRecords: number;
  private readonly staleDeliveryMs: number;
  private readonly records = new Map<string, TelegramDeliveryRecord>();
  private readonly pendingIds = new Set<string>();
  private corruptRecordCount = 0;
  private acceptedSincePrune = 0;

  constructor(stateDir: string, options: TelegramDeliveryJournalOptions) {
    this.journalDir = join(stateDir, '.telegram-deliveries');
    this.agentName = options.agentName;
    this.botId = options.botId;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.initialBackoffMs = options.initialBackoffMs ?? 1_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.acceptedRetentionMs = options.acceptedRetentionMs ?? 7 * 24 * 60 * 60 * 1_000;
    this.maxAcceptedRecords = options.maxAcceptedRecords ?? 5_000;
    this.staleDeliveryMs = options.staleDeliveryMs ?? 5 * 60 * 1_000;
    this.now = options.now ?? (() => new Date());

    if (this.maxAttempts < 1) throw new Error('maxAttempts must be at least 1');
    if (this.initialBackoffMs < 0) throw new Error('initialBackoffMs must not be negative');
    if (this.maxBackoffMs < this.initialBackoffMs) {
      throw new Error('maxBackoffMs must be greater than or equal to initialBackoffMs');
    }
    if (this.acceptedRetentionMs < 0) throw new Error('acceptedRetentionMs must not be negative');
    if (this.maxAcceptedRecords < 0) throw new Error('maxAcceptedRecords must not be negative');
    if (this.staleDeliveryMs < 0) throw new Error('staleDeliveryMs must not be negative');
    this.loadRecords();
    this.pruneAccepted();
  }

  journalUpdate(update: TelegramUpdate): JournalUpdateResult {
    const deliveryId = createTelegramDeliveryId(this.agentName, this.botId, update.update_id);
    const existing = this.readRecord(deliveryId);
    if (existing) return { record: existing, created: false };

    const timestamp = this.now().toISOString();
    const record: TelegramDeliveryRecord = {
      version: 1,
      delivery_id: deliveryId,
      agent_name: this.agentName,
      bot_id: this.botId,
      update_id: update.update_id,
      state: 'queued',
      attempts: 0,
      created_at: timestamp,
      updated_at: timestamp,
      update,
    };
    this.writeRecord(record);
    return { record, created: true };
  }

  get(deliveryId: string): TelegramDeliveryRecord | undefined {
    return this.readRecord(deliveryId);
  }

  markDelivering(deliveryId: string): TelegramDeliveryRecord {
    const record = this.requireRecord(deliveryId);
    if (record.state === 'accepted' || record.state === 'dead-letter') return record;
    if (record.state === 'delivering') return record;

    return this.updateRecord(record, {
      state: 'delivering',
      attempts: record.attempts + 1,
      next_attempt_at: undefined,
      last_error: undefined,
    });
  }

  markAccepted(deliveryId: string): TelegramDeliveryRecord {
    const record = this.requireRecord(deliveryId);
    if (record.state === 'accepted') return record;
    if (record.state === 'dead-letter') {
      throw new Error(`Cannot accept dead-letter delivery ${deliveryId}`);
    }
    const accepted = this.updateRecord(record, {
      state: 'accepted',
      next_attempt_at: undefined,
      last_error: undefined,
    });
    this.acceptedSincePrune++;
    if (this.acceptedSincePrune >= 100) this.pruneAccepted();
    return accepted;
  }

  markFailure(
    deliveryId: string,
    error: unknown,
    retryable = true,
  ): TelegramDeliveryRecord {
    const record = this.requireRecord(deliveryId);
    if (record.state === 'accepted' || record.state === 'dead-letter') return record;

    const attempts = record.state === 'delivering'
      ? Math.max(1, record.attempts)
      : record.attempts + 1;
    const lastError = error instanceof Error ? error.message : String(error);

    if (!retryable || attempts >= this.maxAttempts) {
      return this.updateRecord(record, {
        state: 'dead-letter',
        attempts,
        next_attempt_at: undefined,
        last_error: lastError,
      });
    }

    const delay = Math.min(
      this.initialBackoffMs * Math.pow(2, Math.max(0, attempts - 1)),
      this.maxBackoffMs,
    );
    return this.updateRecord(record, {
      state: 'retryable',
      attempts,
      next_attempt_at: new Date(this.now().getTime() + delay).toISOString(),
      last_error: lastError,
    });
  }

  /**
   * Restore interrupted deliveries and return work ready to be dispatched.
   * A `delivering` record has an uncertain outcome after a crash, so recovery
   * retries it immediately. Consumers must make final acceptance idempotent.
   */
  recoverPending(): TelegramDeliveryRecord[] {
    const now = this.now();

    for (const deliveryId of [...this.pendingIds]) {
      const original = this.records.get(deliveryId);
      if (!original) continue;
      if (original.state === 'delivering') {
        this.updateRecord(original, {
          state: 'retryable',
          next_attempt_at: now.toISOString(),
          last_error: original.last_error ?? 'delivery interrupted before acceptance',
        });
      }
    }

    return this.listReady();
  }

  listReady(): TelegramDeliveryRecord[] {
    const now = this.now();
    const ready: TelegramDeliveryRecord[] = [];
    for (const deliveryId of this.pendingIds) {
      const record = this.records.get(deliveryId);
      if (!record) continue;
      if (record.state === 'queued') {
        ready.push(record);
      } else if (
        record.state === 'retryable'
        && (!record.next_attempt_at || Date.parse(record.next_attempt_at) <= now.getTime())
      ) {
        ready.push(record);
      }
    }

    return ready.sort((a, b) => a.update_id - b.update_id);
  }

  /**
   * Aggregate metadata only. Raw updates and failure strings are deliberately
   * excluded so health endpoints cannot leak inbound message bodies.
   */
  getHealth(): TelegramDeliveryHealth {
    const counts: Record<TelegramDeliveryState, number> = {
      queued: 0,
      delivering: 0,
      accepted: 0,
      retryable: 0,
      'dead-letter': 0,
    };
    let oldestPendingAt: string | undefined;
    let nextRetryAt: string | undefined;
    let staleDelivering = 0;
    const records = this.readAll();
    const staleCutoff = this.now().getTime() - this.staleDeliveryMs;

    for (const record of records) {
      counts[record.state]++;
      if (record.state === 'delivering' && Date.parse(record.updated_at) <= staleCutoff) {
        staleDelivering++;
      }
      if (record.state !== 'accepted' && record.state !== 'dead-letter') {
        if (!oldestPendingAt || record.created_at < oldestPendingAt) {
          oldestPendingAt = record.created_at;
        }
      }
      if (
        record.state === 'retryable'
        && record.next_attempt_at
        && (!nextRetryAt || record.next_attempt_at < nextRetryAt)
      ) {
        nextRetryAt = record.next_attempt_at;
      }
    }

    return {
      healthy: counts['dead-letter'] === 0 && staleDelivering === 0 && this.corruptRecordCount === 0,
      total: records.length,
      pending: counts.queued + counts.delivering + counts.retryable,
      stale_delivering: staleDelivering,
      corrupt_records: this.corruptRecordCount,
      counts,
      ...(oldestPendingAt ? { oldest_pending_at: oldestPendingAt } : {}),
      ...(nextRetryAt ? { next_retry_at: nextRetryAt } : {}),
    };
  }

  private recordPath(deliveryId: string): string {
    if (!/^tg-[a-f0-9]{32}$/.test(deliveryId)) {
      throw new Error(`Invalid Telegram delivery ID: ${deliveryId}`);
    }
    return join(this.journalDir, `${deliveryId}.json`);
  }

  private requireRecord(deliveryId: string): TelegramDeliveryRecord {
    const record = this.readRecord(deliveryId);
    if (!record) throw new Error(`Unknown Telegram delivery: ${deliveryId}`);
    return record;
  }

  private readRecord(deliveryId: string): TelegramDeliveryRecord | undefined {
    return this.records.get(deliveryId);
  }

  private readAll(): TelegramDeliveryRecord[] {
    return [...this.records.values()];
  }

  private updateRecord(
    record: TelegramDeliveryRecord,
    changes: Partial<TelegramDeliveryRecord>,
  ): TelegramDeliveryRecord {
    const updated: TelegramDeliveryRecord = {
      ...record,
      ...changes,
      updated_at: this.now().toISOString(),
    };
    this.writeRecord(updated);
    return updated;
  }

  private writeRecord(record: TelegramDeliveryRecord): void {
    ensureDir(this.journalDir);
    atomicWriteDurableSync(this.recordPath(record.delivery_id), JSON.stringify(record));
    this.records.set(record.delivery_id, record);
    if (record.state === 'accepted' || record.state === 'dead-letter') {
      this.pendingIds.delete(record.delivery_id);
    } else {
      this.pendingIds.add(record.delivery_id);
    }
  }

  private loadRecords(): void {
    if (!existsSync(this.journalDir)) return;
    for (const fileName of readdirSync(this.journalDir)) {
      if (!/^tg-[a-f0-9]{32}\.json$/.test(fileName)) continue;
      try {
        const record = JSON.parse(readFileSync(join(this.journalDir, fileName), 'utf-8')) as TelegramDeliveryRecord;
        if (
          record.delivery_id !== fileName.slice(0, -5)
          || !TELEGRAM_DELIVERY_STATES.includes(record.state)
          || !Number.isInteger(record.update_id)
        ) {
          this.corruptRecordCount++;
          continue;
        }
        this.records.set(record.delivery_id, record);
        if (record.state !== 'accepted' && record.state !== 'dead-letter') {
          this.pendingIds.add(record.delivery_id);
        }
      } catch {
        // A corrupt record stays on disk for health/manual inspection but cannot enter dispatch.
        this.corruptRecordCount++;
      }
    }
  }

  private pruneAccepted(): void {
    this.acceptedSincePrune = 0;
    const cutoff = this.now().getTime() - this.acceptedRetentionMs;
    const accepted = [...this.records.values()]
      .filter(record => record.state === 'accepted')
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
    for (let index = 0; index < accepted.length; index++) {
      const record = accepted[index];
      const expired = Date.parse(record.updated_at) < cutoff;
      const overLimit = index >= this.maxAcceptedRecords;
      if (!expired && !overLimit) continue;
      try { unlinkSync(this.recordPath(record.delivery_id)); } catch { continue; }
      this.records.delete(record.delivery_id);
      this.pendingIds.delete(record.delivery_id);
    }
  }
}
