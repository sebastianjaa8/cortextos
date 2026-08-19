/**
 * Persistent reminder queue (pending-reminders.json).
 *
 * Solves the cron-loss-on-hard-restart problem (#69).
 * Claude Code CronCreate records are in-memory only — they evaporate on hard-restart.
 * This module provides a file-backed queue in state/{agent}/pending-reminders.json
 * that survives any restart type and is injected into the agent boot prompt.
 *
 * Lifecycle:
 *   1. Agent calls `cortextos bus create-reminder <fire-at> <prompt>`
 *   2. Daemon boot prompt includes any overdue pending reminders
 *   3. Agent processes the reminder, calls `cortextos bus ack-reminder <id>`
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { withFileLockSync } from '../utils/lock.js';
import type { BusPaths } from '../types/index.js';

export interface Reminder {
  id: string;
  created_at: string;
  fire_at: string;      // ISO 8601 UTC — when the reminder should fire
  prompt: string;       // The text to inject into the boot prompt when overdue
  status: 'pending' | 'acked';
  acked_at?: string;
  /**
   * Set the first time an overdue reminder is live-injected into a running session
   * (fast-checker.ts's pollCycle, not a restart). Distinct from `status`/`acked_at`:
   * notification means "the agent was shown this", acking means "the agent handled
   * it" — a session that gets notified but is mid-tool-call when it happens should
   * not be re-shown the same reminder every poll tick until it gets around to
   * ack-reminder. getOverdueReminders() (the boot-prompt path) ignores this field on
   * purpose: it is the backstop for anything notified-but-never-acked, and a restart
   * should still surface it.
   */
  notified_at?: string;
}

function remindersPath(paths: BusPaths): string {
  return join(paths.stateDir, 'pending-reminders.json');
}

function readReminders(paths: BusPaths): Reminder[] {
  const filePath = remindersPath(paths);
  if (!existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeReminders(paths: BusPaths, reminders: Reminder[]): void {
  // atomicWriteSync creates paths.stateDir if needed and writes via a temp-file +
  // rename, so a concurrent reader never observes a truncated/torn file — it sees
  // either the old complete state or the new one, never garbage.
  atomicWriteSync(remindersPath(paths), JSON.stringify(reminders, null, 2));
}

/**
 * Read-modify-write under paths.stateDir's mutex (same convention as crons.ts's
 * lockDirFor — lock on the directory containing the target file). Without this,
 * two concurrent mutators (e.g. a live pollCycle marking a reminder notified while
 * `cortextos bus ack-reminder` runs from a CLI) can each read the same stale
 * snapshot and the second writer's save silently reverts the first writer's
 * change — a real, reproducible lost-update race, not a hypothetical one (Codex
 * review, 2026-08-18, task_1787099506036).
 */
function withReminders<T>(paths: BusPaths, fn: (reminders: Reminder[]) => T): T {
  // acquireLock (utils/lock.ts) mkdirs a `.lock.d` subdirectory INSIDE paths.stateDir
  // and treats a missing parent as ENOENT -> "could not acquire", not "create it for
  // me" -- it retries silently for the full timeout window (5000ms default) rather
  // than failing fast, since a torn-mkdir mid-race looks identical from the inside.
  // The old code created stateDir lazily on first write; locking happens BEFORE any
  // write now, so the directory must exist before the lock attempt, not after it.
  ensureDir(paths.stateDir);
  return withFileLockSync(paths.stateDir, () => fn(readReminders(paths)));
}

/**
 * Create a new persistent reminder.
 * fire_at: ISO 8601 UTC string (e.g. "2026-04-05T08:00:00Z")
 * prompt: text to inject into agent boot prompt when overdue
 */
export function createReminder(paths: BusPaths, fireAt: string, prompt: string): Reminder {
  // Validate fire_at is a parseable date
  const ts = Date.parse(fireAt);
  if (isNaN(ts)) {
    throw new Error(`Invalid fire_at date: "${fireAt}". Use ISO 8601 format, e.g. 2026-04-05T08:00:00Z`);
  }

  const id = `${Date.now()}-reminder-${randomBytes(3).toString('hex')}`;
  const reminder: Reminder = {
    id,
    created_at: new Date().toISOString(),
    fire_at: new Date(ts).toISOString(),
    prompt,
    status: 'pending',
  };

  return withReminders(paths, reminders => {
    reminders.push(reminder);
    writeReminders(paths, reminders);
    return reminder;
  });
}

/**
 * List reminders. By default returns only pending ones.
 */
export function listReminders(paths: BusPaths, opts: { all?: boolean } = {}): Reminder[] {
  const reminders = readReminders(paths);
  if (opts.all) return reminders;
  return reminders.filter(r => r.status === 'pending');
}

/**
 * Return pending reminders whose fire_at is in the past (overdue).
 * Used by agent-process.ts to inject into the boot prompt. Deliberately ignores
 * notified_at — a restart is the backstop for anything the live-injection path
 * (fast-checker.ts) already showed the agent but that never got ack-reminder'd.
 */
export function getOverdueReminders(paths: BusPaths): Reminder[] {
  const now = Date.now();
  return readReminders(paths).filter(
    r => r.status === 'pending' && Date.parse(r.fire_at) <= now,
  );
}

/**
 * Return pending, overdue reminders that have NOT yet been live-injected into a
 * running session. Used by fast-checker.ts's pollCycle (#1787099506036) — the case
 * getOverdueReminders()/the boot prompt never covers: a session that stays alive
 * past fire_at without ever restarting, which is the NORMAL case for a reminder.
 */
export function getUnnotifiedOverdueReminders(paths: BusPaths): Reminder[] {
  const now = Date.now();
  return readReminders(paths).filter(
    r => r.status === 'pending' && !r.notified_at && Date.parse(r.fire_at) <= now,
  );
}

/**
 * Mark a reminder as having been shown to the agent via live injection.
 * Does NOT change status — the agent still owes an explicit ack-reminder call.
 * Never throws: a failed notification-stamp must not crash the poll loop that
 * calls it, same discipline as recordOutboundDelivery.
 */
export function markReminderNotified(paths: BusPaths, id: string): void {
  try {
    withReminders(paths, reminders => {
      const idx = reminders.findIndex(r => r.id === id);
      if (idx === -1) return;
      reminders[idx] = { ...reminders[idx], notified_at: new Date().toISOString() };
      writeReminders(paths, reminders);
    });
  } catch {
    /* best-effort: worst case this reminder gets re-injected next poll tick */
  }
}

/**
 * Acknowledge a reminder by ID — marks it as handled.
 */
export function ackReminder(paths: BusPaths, id: string): void {
  withReminders(paths, reminders => {
    const idx = reminders.findIndex(r => r.id === id);
    if (idx === -1) {
      throw new Error(`Reminder ${id} not found`);
    }
    reminders[idx] = {
      ...reminders[idx],
      status: 'acked',
      acked_at: new Date().toISOString(),
    };
    writeReminders(paths, reminders);
  });
}

/**
 * Delete acked reminders older than retainDays (default 7).
 * Call periodically to prevent unbounded file growth.
 */
export function pruneReminders(paths: BusPaths, retainDays: number = 7): number {
  const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1000;
  return withReminders(paths, reminders => {
    const kept = reminders.filter(r => {
      if (r.status !== 'acked') return true;
      const ackedAt = r.acked_at ? Date.parse(r.acked_at) : 0;
      return ackedAt > cutoff;
    });
    const pruned = reminders.length - kept.length;
    if (pruned > 0) writeReminders(paths, kept);
    return pruned;
  });
}
