import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

/**
 * Durable record of outbound Telegram send ATTEMPTS, including the ones that fail.
 *
 * Why this exists: `logOutboundMessage` is called after a successful send, so
 * `outbound-messages.jsonl` contains successes only. A failed send printed its
 * reason to the calling agent's stderr and then vanished with the session —
 * leaving no way to answer "how often does a send fail" or "which message was
 * lost". Worse, the success-only log reads as evidence of health: analysing it
 * on 2026-07-28 produced a confident "delivery is fine" that was survivorship
 * bias, because the failures were never in the file to be counted.
 *
 * This journal records every attempt and its outcome. It is a SEPARATE file
 * from outbound-messages.jsonl on purpose — that log has existing readers
 * (fleet analysis, per-agent tooling) and changing its semantics to include
 * failures would silently corrupt anything counting it as "messages sent".
 *
 * State vocabulary deliberately matches src/telegram/delivery-journal.ts so the
 * inbound and outbound sides read alike.
 */
export const OUTBOUND_DELIVERY_STATES = [
  'delivering',
  'accepted',
  'retryable',
  'dead-letter',
] as const;

export type OutboundDeliveryState = typeof OUTBOUND_DELIVERY_STATES[number];

export interface OutboundDeliveryRecord {
  version: 1;
  delivery_id: string;
  timestamp: string;
  agent: string;
  chat_id: string;
  state: OutboundDeliveryState;
  attempts: number;
  kind: 'message' | 'photo' | 'document';
  /** Telegram's own message_id, present only once accepted. */
  message_id?: number;
  /**
   * Which call site produced this record, e.g. 'cli:send-telegram' or
   * 'hook:planmode'. Added after the first next-cycle check on this feature
   * could not answer "has the planmode hook ever fired" or "which site is
   * failing" — the records were indistinguishable once written. That second
   * question is the one a retry policy depends on, so the journal has to carry
   * the answer rather than leave it to be inferred from message text.
   */
  source?: string;
  /**
   * Which logical thing triggered this send, e.g. 'morning-brief'. Distinct from
   * `source`: source names the TRANSPORT (cli:send-telegram, hook:planmode) and is
   * present on nearly every row, which makes it useless for asking "did the
   * 7am brief go out" -- title-matching text is the only fallback, and titles
   * vary run to run. Optional and unset by default: only call sites that know
   * their own logical purpose (cron prompts) pass it. task_1785722971327.
   */
  producer?: string;
  /** Telegram's own description, or the transport error, on a non-accepted state. */
  error?: string;
  /**
   * Payload size. Matters because TelegramAPI.sendMessage splits at 4096
   * (api.ts:219) and sends chunks sequentially: if chunk 2 of 3 fails, chunk 1
   * ALREADY arrived. A dead-letter with bytes > 4096 may therefore be a PARTIAL
   * delivery, not a non-delivery. Without this field the journal would report
   * those identically -- and it would be least accurate for the long messages
   * most likely to fail in the first place.
   */
  bytes?: number;
  /** First 120 chars, so a lost message is identifiable without duplicating the whole log. */
  preview: string;
}

export function createOutboundDeliveryId(): string {
  return `otx_${randomUUID()}`;
}

/**
 * Classify a send failure. Retryable means the same payload could plausibly
 * succeed later; anything else is dead-letter and must NOT be retried, or a
 * permanent error (bad chat_id, blocked bot, malformed markdown) becomes an
 * infinite loop that also floods the journal.
 *
 * Conservative by design: only errors positively identified as transient are
 * retryable. An unrecognised error is dead-lettered, because retrying an
 * unknown failure is how one lost message becomes six.
 */
export function classifyOutboundError(message: string): OutboundDeliveryState {
  const m = message.toLowerCase();
  if (m.includes('timed out') || m.includes('timeout')) return 'retryable';
  if (m.includes('429') || m.includes('too many requests') || m.includes('retry after')) return 'retryable';
  if (/\b5\d\d\b/.test(m) || m.includes('bad gateway') || m.includes('gateway timeout')) return 'retryable';
  if (m.includes('request failed') && (m.includes('econn') || m.includes('enotfound') || m.includes('socket'))) {
    return 'retryable';
  }
  return 'dead-letter';
}

/** Append one record. Never throws: journalling must not break the send path it observes. */
export function recordOutboundDelivery(
  ctxRoot: string,
  agentName: string,
  record: Omit<OutboundDeliveryRecord, 'version' | 'timestamp'>,
): void {
  try {
    const logDir = join(ctxRoot, 'logs', agentName);
    mkdirSync(logDir, { recursive: true });
    const entry: OutboundDeliveryRecord = {
      version: 1,
      timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      ...record,
    };
    appendFileSync(join(logDir, 'outbound-deliveries.jsonl'), JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    /* journalling is observability, never a reason to fail a real send */
  }
}
