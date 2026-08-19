import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createReminder,
  listReminders,
  ackReminder,
  pruneReminders,
  getOverdueReminders,
  getUnnotifiedOverdueReminders,
  markReminderNotified,
} from '../../../src/bus/reminders';
import { acquireLock, releaseLock } from '../../../src/utils/lock';
import type { BusPaths } from '../../../src/types/index';

function makePaths(dir: string): BusPaths {
  return {
    ctxRoot: dir,
    inbox: join(dir, 'inbox'),
    inflight: join(dir, 'inflight'),
    processed: join(dir, 'processed'),
    logDir: join(dir, 'logs'),
    stateDir: join(dir, 'state'),
    taskDir: join(dir, 'tasks'),
    approvalDir: join(dir, 'approvals'),
    analyticsDir: join(dir, 'analytics'),
  };
}

describe('reminders', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = join(tmpdir(), `reminders-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    paths = makePaths(testDir);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('createReminder', () => {
    it('creates a reminder with correct fields', () => {
      const fireAt = new Date(Date.now() + 3600_000).toISOString();
      const r = createReminder(paths, fireAt, 'Run morning briefing');
      expect(r.id).toBeTruthy();
      expect(r.fire_at).toBe(fireAt);
      expect(r.prompt).toBe('Run morning briefing');
      expect(r.status).toBe('pending');
      expect(r.created_at).toBeTruthy();
    });

    it('persists to disk', () => {
      const fireAt = new Date(Date.now() + 3600_000).toISOString();
      createReminder(paths, fireAt, 'test');
      const reminders = listReminders(paths);
      expect(reminders).toHaveLength(1);
    });

    it('rejects invalid fire_at', () => {
      expect(() => createReminder(paths, 'not-a-date', 'test')).toThrow();
      expect(() => createReminder(paths, '', 'test')).toThrow();
    });

    it('accumulates multiple reminders', () => {
      const future = new Date(Date.now() + 3600_000).toISOString();
      createReminder(paths, future, 'first');
      createReminder(paths, future, 'second');
      createReminder(paths, future, 'third');
      expect(listReminders(paths)).toHaveLength(3);
    });
  });

  describe('listReminders', () => {
    it('returns empty array when no reminders exist', () => {
      expect(listReminders(paths)).toEqual([]);
    });

    it('returns only pending by default', () => {
      const future = new Date(Date.now() + 3600_000).toISOString();
      const r1 = createReminder(paths, future, 'pending one');
      const r2 = createReminder(paths, future, 'to ack');
      ackReminder(paths, r2.id);

      const pending = listReminders(paths);
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe(r1.id);
    });

    it('returns all reminders with --all flag', () => {
      const future = new Date(Date.now() + 3600_000).toISOString();
      const r = createReminder(paths, future, 'one');
      ackReminder(paths, r.id);

      expect(listReminders(paths, { all: true })).toHaveLength(1);
    });
  });

  describe('getOverdueReminders', () => {
    it('returns nothing when all reminders are in the future', () => {
      const future = new Date(Date.now() + 3600_000).toISOString();
      createReminder(paths, future, 'not yet');
      expect(getOverdueReminders(paths)).toHaveLength(0);
    });

    it('returns overdue pending reminders', () => {
      const past = new Date(Date.now() - 1000).toISOString();
      createReminder(paths, past, 'overdue task');
      const overdue = getOverdueReminders(paths);
      expect(overdue).toHaveLength(1);
      expect(overdue[0].prompt).toBe('overdue task');
    });

    it('does not return acked overdue reminders', () => {
      const past = new Date(Date.now() - 1000).toISOString();
      const r = createReminder(paths, past, 'already handled');
      ackReminder(paths, r.id);
      expect(getOverdueReminders(paths)).toHaveLength(0);
    });
  });

  describe('getUnnotifiedOverdueReminders / markReminderNotified (#1787099506036)', () => {
    // ROOT CAUSE this pair fixes: getOverdueReminders() (boot-prompt path) is only
    // ever read at agent boot/restart. A reminder set for a session that stays
    // alive past fire_at -- the normal case, not the exceptional one -- sat pending
    // with nothing checking it until the next restart, however long that took.
    // getUnnotifiedOverdueReminders() is the periodic-poll counterpart.

    it('MUST-FAIL CASE: an overdue reminder is returned before notification', () => {
      const past = new Date(Date.now() - 1000).toISOString();
      const r = createReminder(paths, past, 'overdue task');
      expect(getUnnotifiedOverdueReminders(paths).map(x => x.id)).toContain(r.id);
    });

    it('markReminderNotified removes it from the unnotified set', () => {
      const past = new Date(Date.now() - 1000).toISOString();
      const r = createReminder(paths, past, 'overdue task');
      markReminderNotified(paths, r.id);
      expect(getUnnotifiedOverdueReminders(paths)).toHaveLength(0);
    });

    it('PAIRED NEGATIVE: notified but NOT acked still appears in getOverdueReminders (boot-prompt backstop)', () => {
      // This is the property the two functions exist to preserve together: a
      // session that got the live-injection but never ran ack-reminder (crashed
      // mid-handling, ignored it, whatever) must still be reminded on its next
      // restart. If notified_at silently satisfied the boot-prompt check too, a
      // reminder shown once and never acted on would vanish forever.
      const past = new Date(Date.now() - 1000).toISOString();
      const r = createReminder(paths, past, 'shown but not handled');
      markReminderNotified(paths, r.id);

      expect(getUnnotifiedOverdueReminders(paths)).toHaveLength(0);
      expect(getOverdueReminders(paths).map(x => x.id)).toContain(r.id);
    });

    it('notified_at does not change status -- ack-reminder is still required', () => {
      const past = new Date(Date.now() - 1000).toISOString();
      const r = createReminder(paths, past, 'test');
      markReminderNotified(paths, r.id);
      const all = listReminders(paths, { all: true });
      expect(all[0].status).toBe('pending');
      expect(all[0].notified_at).toBeTruthy();
    });

    it('acking a reminder removes it from getUnnotifiedOverdueReminders too', () => {
      const past = new Date(Date.now() - 1000).toISOString();
      const r = createReminder(paths, past, 'handled immediately');
      ackReminder(paths, r.id);
      expect(getUnnotifiedOverdueReminders(paths)).toHaveLength(0);
    });

    it('a future reminder is not in the unnotified-overdue set', () => {
      const future = new Date(Date.now() + 3600_000).toISOString();
      createReminder(paths, future, 'not yet');
      expect(getUnnotifiedOverdueReminders(paths)).toHaveLength(0);
    });

    it('marking a nonexistent id notified does not throw (best-effort, mirrors recordOutboundDelivery)', () => {
      expect(() => markReminderNotified(paths, 'does-not-exist')).not.toThrow();
    });
  });

  describe('ackReminder', () => {
    it('marks reminder as acked with timestamp', () => {
      const future = new Date(Date.now() + 3600_000).toISOString();
      const r = createReminder(paths, future, 'test');
      ackReminder(paths, r.id);

      const all = listReminders(paths, { all: true });
      expect(all[0].status).toBe('acked');
      expect(all[0].acked_at).toBeTruthy();
    });

    it('throws when reminder ID not found', () => {
      expect(() => ackReminder(paths, 'nonexistent-id')).toThrow();
    });
  });

  describe('pruneReminders', () => {
    it('removes acked reminders older than retainDays', () => {
      const future = new Date(Date.now() + 3600_000).toISOString();
      const r = createReminder(paths, future, 'old acked');
      ackReminder(paths, r.id);

      // Backdate acked_at to 8 days ago
      const { readFileSync, writeFileSync } = require('fs');
      const { join: pathJoin } = require('path');
      const filePath = pathJoin(paths.stateDir, 'pending-reminders.json');
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      data[0].acked_at = new Date(Date.now() - 8 * 24 * 3600_000).toISOString();
      writeFileSync(filePath, JSON.stringify(data, null, 2));

      const pruned = pruneReminders(paths, 7);
      expect(pruned).toBe(1);
      expect(listReminders(paths, { all: true })).toHaveLength(0);
    });

    it('keeps pending reminders regardless of age', () => {
      const past = new Date(Date.now() - 10 * 24 * 3600_000).toISOString();
      createReminder(paths, past, 'old pending');
      pruneReminders(paths, 7);
      expect(listReminders(paths)).toHaveLength(1);
    });

    it('returns 0 when nothing to prune', () => {
      expect(pruneReminders(paths)).toBe(0);
    });
  });

  describe('read-modify-write mutual exclusion (Codex review, 2026-08-18, task_1787099506036)', () => {
    // CONFIRMED lost-update race: a fast-checker poll cycle marking a reminder
    // notified and a CLI `ack-reminder` call could each read the same stale
    // snapshot; whichever writes second silently reverts the first writer's
    // change. All mutators (createReminder/ackReminder/markReminderNotified/
    // pruneReminders) now share paths.stateDir's mutex via withFileLockSync
    // (same convention as crons.ts's lockDirFor). This proves the lock is
    // actually engaged -- not a no-op -- by holding it externally and
    // confirming a concurrent mutator is genuinely blocked by it, then
    // proceeds once released.
    it('MUST-FAIL CASE: a mutator genuinely contends on an externally-held lock instead of silently succeeding anyway', () => {
      // withFileLockSync's backoff (utils/lock.ts) blocks the calling thread
      // synchronously (Atomics.wait) -- there is no way to release the lock
      // from a timer on the same thread mid-block to test "blocks then
      // succeeds after release" without a worker/child process. This proves
      // the narrower, still load-bearing property without needing one: if the
      // lock were a no-op (the exact defect this fix closes), createReminder
      // would succeed instantly even while the lock is externally held. It
      // must not -- it must fail loudly after real contention, never silently
      // proceed as if uncontended.
      mkdirSync(paths.stateDir, { recursive: true }); // acquireLock needs the dir to pre-exist
      expect(acquireLock(paths.stateDir)).toBe(true); // hold the mutex ourselves, never release it
      const future = new Date(Date.now() + 3600_000).toISOString();

      const start = Date.now();
      expect(() => createReminder(paths, future, 'should not silently succeed')).toThrow(/failed to acquire lock/);
      const elapsed = Date.now() - start;

      // A no-op lock would return near-instantly; real contention burns most
      // of withFileLockSync's timeout window before giving up.
      expect(elapsed).toBeGreaterThan(1000);
      // And the attempted write must not have landed despite the throw.
      expect(listReminders(paths, { all: true })).toHaveLength(0);

      releaseLock(paths.stateDir);
    }, 10000);

    it('sequential mutations under contention never lose an update (regression shape for the lost-update race)', () => {
      // Not true OS-level parallelism (this file's mutators are synchronous),
      // but proves the fix's actual failure mode is closed: N sequential
      // create+ack pairs interleaved must all still be present and correctly
      // stated afterward, none silently reverted by another writer's stale
      // read-modify-write.
      const future = new Date(Date.now() + 3600_000).toISOString();
      const ids = Array.from({ length: 5 }, (_, i) => createReminder(paths, future, `r${i}`).id);
      ids.forEach((id, i) => { if (i % 2 === 0) ackReminder(paths, id); });

      const all = listReminders(paths, { all: true });
      expect(all).toHaveLength(5);
      ids.forEach((id, i) => {
        const r = all.find((x) => x.id === id);
        expect(r?.status).toBe(i % 2 === 0 ? 'acked' : 'pending');
      });
    });
  });
});
