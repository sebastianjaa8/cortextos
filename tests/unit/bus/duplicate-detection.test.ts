/**
 * Duplicate-detection safety net for create-task.
 *
 * On 2026-07-18 a retry in the dispatch path re-sent several create-task calls,
 * producing duplicate open tasks that cost real cleanup work before anyone
 * noticed. findRecentDuplicate flags a near-identical OPEN task for the SAME
 * assignee inside a short window so the caller can warn.
 *
 * Advisory by design — the CLI warns and still creates. These tests pin the
 * boundaries that make it advisory-but-useful: it must not fire on completed
 * twins, other assignees, or old tasks, because a noisy false positive is how
 * a warning gets ignored.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createTask,
  updateTask,
  findRecentDuplicate,
  normalizeTaskTitle,
  DUPLICATE_WINDOW_MS,
} from '../../../src/bus/task';
import type { BusPaths } from '../../../src/types';

describe('create-task duplicate detection', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-dup-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'builder'),
      inflight: join(testDir, 'inflight', 'builder'),
      processed: join(testDir, 'processed', 'builder'),
      logDir: join(testDir, 'logs', 'builder'),
      stateDir: join(testDir, 'state', 'builder'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('normalizeTaskTitle', () => {
    it('ignores case, punctuation and whitespace runs', () => {
      expect(normalizeTaskTitle('Fix   the Bug!')).toBe(normalizeTaskTitle('fix the bug'));
      expect(normalizeTaskTitle('Retire dream tier1/tier2 flags')).toBe(
        normalizeTaskTitle('retire dream tier1 tier2 flags')
      );
    });

    it('keeps genuinely different titles distinct (no fuzzy matching)', () => {
      expect(normalizeTaskTitle('Phase 3 plan')).not.toBe(normalizeTaskTitle('Phase 4 plan'));
    });
  });

  it('flags the real case: same title, same assignee, moments apart', () => {
    const first = createTask(paths, 'seb_boss', 'acme', 'Retire dream tier1 flags', {
      assignee: 'builder_1',
    });
    const dup = findRecentDuplicate(paths, 'Retire dream tier1 flags', 'builder_1');
    expect(dup?.id).toBe(first);
  });

  it('matches through punctuation/case drift between two dispatches', () => {
    const first = createTask(paths, 'seb_boss', 'acme', 'Fix create-task priority validation', {
      assignee: 'builder_1',
    });
    const dup = findRecentDuplicate(paths, 'Fix create task priority validation!', 'builder_1');
    expect(dup?.id).toBe(first);
  });

  it('does NOT flag a different assignee', () => {
    createTask(paths, 'seb_boss', 'acme', 'Same title', { assignee: 'builder_1' });
    expect(findRecentDuplicate(paths, 'Same title', 'nanoneuro_dev')).toBeNull();
  });

  it('does NOT flag a completed twin — that is history, not a duplicate', () => {
    const id = createTask(paths, 'seb_boss', 'acme', 'Recurring weekly job', {
      assignee: 'builder_1',
    });
    updateTask(paths, id, 'completed');
    expect(findRecentDuplicate(paths, 'Recurring weekly job', 'builder_1')).toBeNull();
  });

  it('does NOT flag a cancelled twin', () => {
    const id = createTask(paths, 'seb_boss', 'acme', 'Abandoned idea', { assignee: 'builder_1' });
    updateTask(paths, id, 'cancelled');
    expect(findRecentDuplicate(paths, 'Abandoned idea', 'builder_1')).toBeNull();
  });

  it('does NOT flag outside the window', () => {
    createTask(paths, 'seb_boss', 'acme', 'Old task', { assignee: 'builder_1' });
    const wayLater = Date.now() + DUPLICATE_WINDOW_MS + 60_000;
    expect(findRecentDuplicate(paths, 'Old task', 'builder_1', wayLater)).toBeNull();
  });

  it('still flags just inside the window', () => {
    const id = createTask(paths, 'seb_boss', 'acme', 'Edge task', { assignee: 'builder_1' });
    const justInside = Date.now() + DUPLICATE_WINDOW_MS - 5_000;
    expect(findRecentDuplicate(paths, 'Edge task', 'builder_1', justInside)?.id).toBe(id);
  });

  it('ignores a clock-skewed future task rather than matching it forever', () => {
    createTask(paths, 'seb_boss', 'acme', 'Future task', { assignee: 'builder_1' });
    // "now" earlier than created_at => negative age, must not match.
    const inThePast = Date.now() - 60_000;
    expect(findRecentDuplicate(paths, 'Future task', 'builder_1', inThePast)).toBeNull();
  });

  it('returns one of the matches when several exist in the same second', () => {
    const first = createTask(paths, 'seb_boss', 'acme', 'Triple send', { assignee: 'builder_1' });
    const second = createTask(paths, 'seb_boss', 'acme', 'Triple send', { assignee: 'builder_1' });
    const dup = findRecentDuplicate(paths, 'Triple send', 'builder_1');
    // created_at is truncated to whole seconds, so a fast retry burst produces
    // identical timestamps and there is no "most recent" to assert. Any open
    // twin is equally good evidence for the warning — pin that, not an order
    // the data cannot support.
    expect([first, second]).toContain(dup?.id);
  });

  it('returns null on an empty/punctuation-only title rather than matching everything', () => {
    createTask(paths, 'seb_boss', 'acme', '!!!', { assignee: 'builder_1' });
    expect(findRecentDuplicate(paths, '???', 'builder_1')).toBeNull();
  });

  it('finds nothing in an empty task dir', () => {
    expect(findRecentDuplicate(paths, 'anything', 'builder_1')).toBeNull();
  });
});
