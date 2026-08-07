import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type {
  BusPaths,
  TelegramCallbackQuery,
  TelegramMessage,
  TelegramMessageReaction,
  TelegramUpdate,
} from '../types/index.js';
import { logEvent } from '../bus/event.js';
import { atomicWriteDurableSync } from '../utils/atomic.js';
import { TelegramAPI } from './api.js';
import {
  TelegramDeliveryJournal,
  type TelegramDeliveryHealth,
  type TelegramDeliveryRecord,
} from './delivery-journal.js';

export interface TelegramDeliveryContext {
  deliveryId: string;
  updateId: number;
  attempt: number;
}

export type TelegramDeliveryOutcome =
  | { ok: true; disposition: 'confirmed' | 'idempotent' | 'deferred' }
  | { ok: false; retryable: true; error: string };

export type MessageHandler = (
  msg: TelegramMessage,
  delivery: TelegramDeliveryContext,
) => TelegramDeliveryOutcome | void | Promise<TelegramDeliveryOutcome | void>;
export type CallbackHandler = (
  query: TelegramCallbackQuery,
  delivery: TelegramDeliveryContext,
) => TelegramDeliveryOutcome | void | Promise<TelegramDeliveryOutcome | void>;
export type ReactionHandler = (
  reaction: TelegramMessageReaction,
  delivery: TelegramDeliveryContext,
) => TelegramDeliveryOutcome | void | Promise<TelegramDeliveryOutcome | void>;

export interface TelegramPollerObservability {
  paths?: BusPaths;
  agentName?: string;
  org?: string;
  botId?: string;
  log?: (m: string) => void;
}

/**
 * Telegram polling loop with a durable handoff boundary.
 * Updates are atomically journaled before their Telegram offset is committed.
 */
export class TelegramPoller {
  private offset = 0;
  private running = false;
  private readonly offsetFileName: string;
  private readonly messageHandlers: MessageHandler[] = [];
  private readonly callbackHandlers: CallbackHandler[] = [];
  private readonly reactionHandlers: ReactionHandler[] = [];
  private readonly deliveryJournal: TelegramDeliveryJournal;
  private readonly routedDeliveryIds = new Set<string>();
  private runGeneration = 0;
  private recoveryComplete = false;

  /** Why the poll loop last exited; consumed by AgentManager supervision. */
  lastExitReason = '';

  /**
   * @param offsetFileSuffix Optional distinct suffix for the offset file.
   *   When omitted, offset persists to `.telegram-offset`. Provide a suffix
   *   when running a second poller in the same stateDir against a different
   *   bot token (e.g. an activity-channel bot alongside the agent's own bot),
   *   so the two pollers do not clobber each other's offsets.
   */
  constructor(
    private readonly api: TelegramAPI,
    private readonly stateDir: string,
    private readonly pollInterval: number = 1000,
    offsetFileSuffix?: string,
    private readonly observability?: TelegramPollerObservability,
  ) {
    this.offsetFileName = offsetFileSuffix
      ? `.telegram-offset-${offsetFileSuffix}`
      : '.telegram-offset';
    const apiWithIdentity = api as TelegramAPI & { getBotIdentity?: () => string };
    this.deliveryJournal = new TelegramDeliveryJournal(stateDir, {
      agentName: observability?.agentName ?? 'telegram',
      botId: observability?.botId ?? apiWithIdentity.getBotIdentity?.() ?? offsetFileSuffix ?? 'primary',
    });
    this.loadOffset();
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onCallback(handler: CallbackHandler): void {
    this.callbackHandlers.push(handler);
  }

  /**
   * Register a handler for message_reaction updates. These fire when a
   * user adds or removes an emoji reaction on a chat message the bot can
   * see. Requires the bot's getUpdates call to include `message_reaction`
   * in allowed_updates (handled by TelegramAPI.getUpdates).
   */
  onReaction(handler: ReactionHandler): void {
    this.reactionHandlers.push(handler);
  }

  async start(): Promise<void> {
    this.running = true;
    const generation = ++this.runGeneration;
    this.lastExitReason = '';

    while (this.isGenerationActive(generation)) {
      try {
        await this.pollOnceForGeneration(generation);
      } catch (err) {
        if (!this.isGenerationActive(generation)) {
          this.lastExitReason = 'stopped-externally';
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        if (/Conflict/i.test(message)) {
          this.lastExitReason = 'conflict-self-die';
          this.running = false;
          return;
        }
        if (/Unauthorized|\b401\b/i.test(message)) {
          console.error('[telegram-poller] Auth failure (401 Unauthorized) - BOT_TOKEN invalid or unloaded. Exiting loop; supervisor will back off.');
          this.lastExitReason = 'auth-failed';
          this.running = false;
          return;
        }
        console.error('[telegram-poller] Poll error:', err);
      }

      if (!this.isGenerationActive(generation)) break;
      await sleep(this.pollInterval);
    }
  }

  /** Fence the active run so an in-flight getUpdates cannot commit an offset. */
  stop(): void {
    this.running = false;
    this.runGeneration++;
    this.lastExitReason = 'stopped-externally';
  }

  getDeliveryJournal(): TelegramDeliveryJournal {
    return this.deliveryJournal;
  }

  markDeliveryDispatch(deliveryId: string): TelegramDeliveryRecord {
    return this.deliveryJournal.markDelivering(deliveryId);
  }

  markDeliveryAccepted(deliveryId: string): TelegramDeliveryRecord {
    const record = this.deliveryJournal.markAccepted(deliveryId);
    this.routedDeliveryIds.add(deliveryId);
    return record;
  }

  markDeliveryFailure(
    deliveryId: string,
    error: unknown,
    retryable = true,
  ): TelegramDeliveryRecord {
    const record = this.deliveryJournal.markFailure(deliveryId, error, retryable);
    if (record.state === 'retryable') this.routedDeliveryIds.delete(deliveryId);
    return record;
  }

  getDeliveryHealth(): TelegramDeliveryHealth {
    return this.deliveryJournal.getHealth();
  }

  /** Recover unfinished records after process restart and route ready work. */
  async recoverPendingDeliveries(): Promise<number> {
    const records = this.deliveryJournal.recoverPending();
    this.recoveryComplete = true;
    return this.routeRecords(records);
  }

  async pollOnce(): Promise<void> {
    await this.pollOnceForGeneration();
  }

  private async pollOnceForGeneration(generation?: number): Promise<void> {
    if (!this.isGenerationActive(generation)) return;

    if (!this.recoveryComplete) {
      await this.recoverPendingDeliveries();
    } else {
      await this.routeRecords(this.deliveryJournal.listReady());
    }
    if (!this.isGenerationActive(generation)) return;

    const result = await this.api.getUpdates(this.offset, 1);
    if (!this.isGenerationActive(generation) || !result?.result?.length) return;

    for (const update of result.result as TelegramUpdate[]) {
      if (!this.isGenerationActive(generation)) return;
      const { record } = this.deliveryJournal.journalUpdate(update);
      if (!this.isGenerationActive(generation)) return;

      const nextOffset = update.update_id + 1;
      this.saveOffset(nextOffset);
      this.offset = nextOffset;
      await this.routeDelivery(record);
    }
  }

  private async routeRecords(records: TelegramDeliveryRecord[]): Promise<number> {
    let routed = 0;
    for (const record of records) {
      if (this.routedDeliveryIds.has(record.delivery_id)) continue;
      if (await this.routeDelivery(record)) routed++;
    }
    return routed;
  }

  private async routeDelivery(record: TelegramDeliveryRecord): Promise<boolean> {
    if (record.state === 'accepted' || record.state === 'dead-letter') return false;
    if (this.routedDeliveryIds.has(record.delivery_id)) return false;

    const update = record.update;
    const updateType = detectUpdateType(update);
    const delivering = this.deliveryJournal.markDelivering(record.delivery_id);
    const context: TelegramDeliveryContext = {
      deliveryId: record.delivery_id,
      updateId: record.update_id,
      attempt: delivering.attempts,
    };
    this.observability?.log?.(
      `[telegram-poller] update_id=${update.update_id} type=${updateType} delivery_id=${record.delivery_id}`,
    );

    try {
      let shouldAccept = false;
      if (update.message) {
        if (this.messageHandlers.length === 0) this.deliveryJournal.markAccepted(record.delivery_id);
        else for (const handler of this.messageHandlers) {
          const outcome = await handler(update.message, context);
          if (outcome && !outcome.ok) throw new Error(outcome.error);
          if (outcome?.ok && outcome.disposition !== 'deferred') shouldAccept = true;
        }
      } else if (update.callback_query) {
        if (this.callbackHandlers.length === 0) this.deliveryJournal.markAccepted(record.delivery_id);
        else for (const handler of this.callbackHandlers) {
          const outcome = await handler(update.callback_query, context);
          if (outcome && !outcome.ok) throw new Error(outcome.error);
          if (outcome?.ok && outcome.disposition !== 'deferred') shouldAccept = true;
        }
      } else if (update.message_reaction) {
        if (this.reactionHandlers.length === 0) this.deliveryJournal.markAccepted(record.delivery_id);
        else for (const handler of this.reactionHandlers) {
          const outcome = await handler(update.message_reaction, context);
          if (outcome && !outcome.ok) throw new Error(outcome.error);
          if (outcome?.ok && outcome.disposition !== 'deferred') shouldAccept = true;
        }
      } else {
        this.logUnknownUpdate(update);
        this.deliveryJournal.markAccepted(record.delivery_id);
      }
      if (shouldAccept) this.deliveryJournal.markAccepted(record.delivery_id);
      this.routedDeliveryIds.add(record.delivery_id);
      return true;
    } catch (err) {
      console.error(`[telegram-poller] ${updateType} handler error:`, err);
      this.deliveryJournal.markFailure(record.delivery_id, err, true);
      this.routedDeliveryIds.delete(record.delivery_id);
      return false;
    }
  }

  private logUnknownUpdate(update: TelegramUpdate): void {
    const keys = Object.keys(update);
    console.warn(
      `[telegram-poller] UNKNOWN update shape: update_id=${update.update_id} keys=${keys.join(',')}`,
    );
    if (this.observability?.paths && this.observability.agentName && this.observability.org) {
      logEvent(
        this.observability.paths,
        this.observability.agentName,
        this.observability.org,
        'error',
        'telegram_unknown_update',
        'warning',
        { update_id: update.update_id, keys },
      );
    }
  }

  private isGenerationActive(generation?: number): boolean {
    return generation === undefined || (this.running && generation === this.runGeneration);
  }

  private loadOffset(): void {
    const offsetFile = join(this.stateDir, this.offsetFileName);
    try {
      if (!existsSync(offsetFile)) return;
      const parsed = parseInt(readFileSync(offsetFile, 'utf-8').trim(), 10);
      if (!Number.isNaN(parsed)) this.offset = parsed;
    } catch {
      // Start from zero when the state file cannot be read.
    }
  }

  private saveOffset(offset: number): void {
    atomicWriteDurableSync(join(this.stateDir, this.offsetFileName), String(offset));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function detectUpdateType(
  update: TelegramUpdate,
): 'message' | 'callback_query' | 'message_reaction' | 'unknown' {
  if (update.message) return 'message';
  if (update.callback_query) return 'callback_query';
  if (update.message_reaction) return 'message_reaction';
  return 'unknown';
}
