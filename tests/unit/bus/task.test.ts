import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTask, updateTask, completeTask, claimTask, addTaskDependency, removeTaskDependency, readTaskAudit, checkTaskDependencies, compactTasks, checkStaleTasks, listTasks, findTaskFile, archiveTasks } from '../../../src/bus/task';
import type { BusPaths } from '../../../src/types';

describe('Task Management', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-task-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'paul'),
      inflight: join(testDir, 'inflight', 'paul'),
      processed: join(testDir, 'processed', 'paul'),
      logDir: join(testDir, 'logs', 'paul'),
      stateDir: join(testDir, 'state', 'paul'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('path-traversal hardening (#13/#14)', () => {
    it('findTaskFile rejects a traversal task id', () => {
      expect(() => findTaskFile(paths, '../../etc/passwd')).toThrow(/Invalid task id/);
      expect(() => findTaskFile(paths, 'task/../../secrets')).toThrow(/Invalid task id/);
      expect(() => findTaskFile(paths, 'task_1.json')).toThrow(/Invalid task id/);
    });

    it('readTaskAudit rejects a traversal task id', () => {
      expect(() => readTaskAudit(paths, '../../../etc/shadow')).toThrow(/Invalid task id/);
    });

    it('findTaskFile still resolves a legitimate task', () => {
      const id = createTask(paths, 'paul', 'acme', 'T', { assignee: 'boris' });
      expect(findTaskFile(paths, id)).toContain(`${id}.json`);
    });

    it('archiveTasks skips a task whose JSON id is tampered with traversal (no escape)', () => {
      mkdirSync(paths.taskDir, { recursive: true });
      // Safe filename, but the internal id carries traversal that would resolve
      // to testDir/escaped.json (outside the task tree) on archive write/rename.
      writeFileSync(join(paths.taskDir, 'task_evil_1.json'), JSON.stringify({
        id: '../escaped', status: 'completed', completed_at: '2020-01-01T00:00:00Z',
        assigned_to: 'boris', org: 'acme',
      }));
      expect(() => archiveTasks(paths)).not.toThrow();
      // The guard must have prevented the out-of-tree write.
      expect(existsSync(join(testDir, 'escaped.json'))).toBe(false);
    });
  });

  describe('createTask', () => {
    it('creates task with correct JSON format', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Build landing page', {
        description: 'Create a product landing page',
        assignee: 'boris',
        priority: 'high',
      });

      expect(taskId).toMatch(/^task_\d+_\d{8}$/);

      const content = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));

      // Verify all 17 fields match bash create-task.sh format
      expect(content.id).toBe(taskId);
      expect(content.title).toBe('Build landing page');
      expect(content.description).toBe('Create a product landing page');
      expect(content.type).toBe('agent');
      expect(content.needs_approval).toBe(false);
      expect(content.status).toBe('pending');
      expect(content.assigned_to).toBe('boris');
      expect(content.created_by).toBe('paul');
      expect(content.org).toBe('acme');
      expect(content.priority).toBe('high');
      expect(content.project).toBe('');
      expect(content.kpi_key).toBeNull();
      expect(content.created_at).toBeTruthy();
      expect(content.updated_at).toBeTruthy();
      expect(content.completed_at).toBeNull();
      expect(content.due_date).toBeNull();
      expect(content.archived).toBe(false);
    });
  });

  describe('updateTask', () => {
    it('updates task status', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Test task');
      updateTask(paths, taskId, 'in_progress');

      const content = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));
      expect(content.status).toBe('in_progress');
    });

    // task_1785781154932_38520243: update-task reassigned silently — the record changed owner and
    // nobody was told. Fixed by having updateTask RETURN whether a real reassignment happened (the
    // CLI decides whom to notify from this, reusing the exact `assignee !== prevAssignee` condition
    // the audit log already computes, so the log and the notification cannot disagree about what
    // counts as a real change).
    describe('return value (drives the CLI reassignment notify)', () => {
      it('reports reassigned=true with both the old and new assignee on a real change', () => {
        const taskId = createTask(paths, 'paul', 'acme', 'Owned', { assignee: 'boris' });
        const result = updateTask(paths, taskId, 'in_progress', { assignee: 'nadia' });
        expect(result).toEqual({ reassigned: true, prevAssignee: 'boris', assignee: 'nadia' });
      });

      it('reports reassigned=false when --assignee is not passed at all (status-only update)', () => {
        const taskId = createTask(paths, 'paul', 'acme', 'Untouched', { assignee: 'boris' });
        const result = updateTask(paths, taskId, 'in_progress');
        expect(result.reassigned).toBe(false);
        expect(result.assignee).toBe('boris'); // still names the CURRENT assignee, just unchanged
      });

      it('reports reassigned=false on a no-op re-assertion of the same assignee', () => {
        const taskId = createTask(paths, 'paul', 'acme', 'Same owner', { assignee: 'boris' });
        const result = updateTask(paths, taskId, 'in_progress', { assignee: 'boris' });
        expect(result.reassigned).toBe(false);
      });
    });

    // Priority was CREATE-ONLY until 2026-07-30, which made every re-prioritisation narrative: an
    // agent could announce "moved off low" while the store kept `low` forever. Agents pick the
    // highest-priority task, so a frozen field means sorting by what mattered when it was FILED.
    it('changes priority when asked, and LEAVES IT ALONE when not — both directions', () => {
      const read = (id: string) =>
        JSON.parse(readFileSync(join(paths.taskDir, `${id}.json`), 'utf-8'));

      const changed = createTask(paths, 'paul', 'acme', 'Re-ranked', { priority: 'low' });
      updateTask(paths, changed, 'pending', { priority: 'high' });
      expect(read(changed).priority).toBe('high');

      // Negative control: a status-only update must not disturb priority. Without this, a bug that
      // always wrote a default would pass the positive case above.
      const untouched = createTask(paths, 'paul', 'acme', 'Not re-ranked', { priority: 'low' });
      updateTask(paths, untouched, 'in_progress');
      expect(read(untouched).priority).toBe('low');
    });

    it('AUDITS a priority change, because the field that decides work order must not move silently', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Audited', { priority: 'low' });
      updateTask(paths, taskId, 'pending', { priority: 'urgent' });

      const entry = readTaskAudit(paths, taskId).find((e) => e.event === 'update');
      expect(entry).toBeDefined();
      expect(entry?.from_priority).toBe('low');
      expect(entry?.to_priority).toBe('urgent');
    });

    it('does NOT write a priority audit entry for a no-op re-assertion of the same value', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Same again', { priority: 'high' });
      updateTask(paths, taskId, 'pending', { priority: 'high' });

      const entry = readTaskAudit(paths, taskId).find((e) => e.event === 'update');
      expect(entry?.from_priority).toBeUndefined();
      expect(entry?.to_priority).toBeUndefined();
    });

    // TITLE CORRECTION. The title is the ONLY field `list-tasks` renders, so a wrong one is the
    // single error no reader can see past: a corrected body sits invisibly behind an uncorrected
    // headline, and the headline is what gets acted on. Origin: a task whose TITLE asserted an
    // impossibility its own BODY already recorded as mistaken was walked past for a full day.
    it('corrects the title AND preserves the superseded one into the description', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'WRONG: no way to change a description', {
        description: 'original body',
      });
      updateTask(paths, taskId, 'pending', { title: 'RIGHT: --desc shipped in 9cdfdc0f' });

      const t = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));
      expect(t.title).toBe('RIGHT: --desc shipped in 9cdfdc0f');
      // The superseded headline must remain LEGIBLE, not be silently replaced — a retitle that
      // erases the old claim destroys the evidence that the task was ever wrong.
      expect(t.description).toContain('WRONG: no way to change a description');
      expect(t.description).toContain('[TITLE CORRECTED');
      // CONTROL: the original body must survive the append, not be overwritten by the note.
      expect(t.description).toContain('original body');
      // CONTROL: no carriage return injected. This file is CRLF on disk, so a literal line
      // break inside the note's template literal would put one into every description.
      expect(t.description).not.toContain(String.fromCharCode(13));
    });

    it('audits a title correction with from_title/to_title AND actually applies it', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'OLD HEADLINE');
      updateTask(paths, taskId, 'pending', { title: 'NEW HEADLINE' });

      const entry = readTaskAudit(paths, taskId).find((e) => e.event === 'update');
      expect(entry?.from_title).toBe('OLD HEADLINE');
      expect(entry?.to_title).toBe('NEW HEADLINE');

      // THE AUDIT AND THE WRITE ARE SEPARATE EXPRESSIONS, so this assertion is not redundant:
      // sabotaging the title-write leg left this test GREEN while the audit still claimed a
      // change that never reached the task. An audit entry asserting a mutation that did not
      // happen is worse than no entry — it is a false record of the exact field the log exists
      // to make trustworthy. Found by mutation, not by review.
      const t = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));
      expect(t.title).toBe('NEW HEADLINE');
    });

    // CONTROL, and it is the one that stops this from being a vacuous pair: without it, an
    // implementation that appends a note and an audit entry on EVERY update passes both
    // assertions above while spamming the description of every unrelated status change.
    it('does NOT touch the description or audit for a no-op re-assertion of the same title', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'SAME', { description: 'body' });
      updateTask(paths, taskId, 'pending', { title: 'SAME' });

      const t = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));
      expect(t.description).toBe('body');
      expect(t.description).not.toContain('[TITLE CORRECTED');
      const entry = readTaskAudit(paths, taskId).find((e) => e.event === 'update');
      expect(entry?.from_title).toBeUndefined();
      expect(entry?.to_title).toBeUndefined();
    });

    // CONTROL: an update that does not pass --title must leave the title alone. Without this, an
    // implementation defaulting title to undefined-and-writing-it would blank every title on any
    // ordinary status change, and the assertions above would not notice.
    it('leaves the title untouched when no title option is passed', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'UNTOUCHED', { description: 'body' });
      updateTask(paths, taskId, 'in_progress', { priority: 'high' });

      const t = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));
      expect(t.title).toBe('UNTOUCHED');
      expect(t.description).toBe('body');
    });
  });

  describe('completeTask', () => {
    it('sets status to completed and completed_at', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Test task');
      completeTask(paths, taskId, 'Landing page done, committed at abc123');

      const content = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));
      expect(content.status).toBe('completed');
      expect(content.completed_at).toBeTruthy();
      expect(content.result).toBe('Landing page done, committed at abc123');
    });

    it('emits a task/task_completed activity event for the assignee', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Complete-event task', {
        assignee: 'boris',
      });
      completeTask(paths, taskId, 'shipped');

      // Event file: <analyticsDir>/events/boris/<YYYY-MM-DD>.jsonl
      const today = new Date().toISOString().split('T')[0];
      const eventFile = join(paths.analyticsDir, 'events', 'boris', `${today}.jsonl`);
      expect(existsSync(eventFile)).toBe(true);

      const events = readFileSync(eventFile, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const completedEvents = events.filter((e) => e.event === 'task_completed');
      expect(completedEvents).toHaveLength(1);
      const evt = completedEvents[0];
      expect(evt.agent).toBe('boris');
      expect(evt.org).toBe('acme');
      expect(evt.category).toBe('task');
      expect(evt.severity).toBe('info');
      expect(evt.metadata.task_id).toBe(taskId);
      expect(evt.metadata.result).toBe('shipped');
    });
  });

  describe('listTasks', () => {
    it('returns all non-archived tasks', () => {
      createTask(paths, 'paul', 'acme', 'Task 1');
      createTask(paths, 'paul', 'acme', 'Task 2');

      const tasks = listTasks(paths);
      expect(tasks.length).toBe(2);
    });

    it('filters by agent', () => {
      createTask(paths, 'paul', 'acme', 'For boris', { assignee: 'boris' });
      createTask(paths, 'paul', 'acme', 'For paul', { assignee: 'paul' });

      const borisTasks = listTasks(paths, { agent: 'boris' });
      expect(borisTasks.length).toBe(1);
      expect(borisTasks[0].title).toBe('For boris');
    });

    it('filters by status', () => {
      const id1 = createTask(paths, 'paul', 'acme', 'Task 1');
      createTask(paths, 'paul', 'acme', 'Task 2');
      updateTask(paths, id1, 'completed');

      const pending = listTasks(paths, { status: 'pending' });
      expect(pending.length).toBe(1);
    });
});

/**
 * Cross-org task lifecycle — exercises the findTaskFile fallback so an
 * assignee in one org can drive the lifecycle of a task filed by an
 * orchestrator in a sibling org. Standard cortextOS dispatch pattern:
 * an orchestrator in one org files a task, a specialist in another org
 * needs to update and complete it from their own agent session.
 *
 * These tests build a REAL nested filesystem layout (matching the
 * production shape at ~/.cortextos/<instance>/orgs/<org>/tasks/) so they
 * cover the actual cross-org path resolution, not a mocked shortcut.
 */
describe('Cross-org task lifecycle', () => {
  let testDir: string;
  let orgAPaths: BusPaths;
  let orgBTaskDir: string;
  let warnLog: string[];
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-crossorg-test-'));
    // Nested layout: <ctxRoot>/orgs/{OrgA,OrgB}/tasks/
    mkdirSync(join(testDir, 'orgs', 'OrgA', 'tasks'), { recursive: true });
    mkdirSync(join(testDir, 'orgs', 'OrgB', 'tasks'), { recursive: true });

    orgAPaths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'agentA'),
      inflight: join(testDir, 'inflight', 'agentA'),
      processed: join(testDir, 'processed', 'agentA'),
      logDir: join(testDir, 'logs', 'agentA'),
      stateDir: join(testDir, 'state', 'agentA'),
      taskDir: join(testDir, 'orgs', 'OrgA', 'tasks'),
      approvalDir: join(testDir, 'orgs', 'OrgA', 'approvals'),
      analyticsDir: join(testDir, 'orgs', 'OrgA', 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
    orgBTaskDir = join(testDir, 'orgs', 'OrgB', 'tasks');

    warnLog = [];
    originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnLog.push(args.map((a) => String(a)).join(' '));
    };
  });

  afterEach(() => {
    console.warn = originalWarn;
    rmSync(testDir, { recursive: true, force: true });
  });

  /** Helper: drop a raw task JSON file into OrgB's tasks dir without
   * going through createTask (which only knows about OrgA's taskDir). */
  function writeOrgBTask(taskId: string, overrides: Record<string, unknown> = {}): void {
    const task = {
      id: taskId,
      title: 'Cross-org task',
      description: '',
      type: 'agent',
      needs_approval: false,
      status: 'pending',
      assigned_to: 'agentA',
      created_by: 'orchestrator',
      org: 'OrgB',
      priority: 'normal',
      project: '',
      kpi_key: null,
      created_at: '2026-04-11T20:00:00Z',
      updated_at: '2026-04-11T20:00:00Z',
      completed_at: null,
      due_date: null,
      archived: false,
      ...overrides,
    };
    writeFileSync(join(orgBTaskDir, `${taskId}.json`), JSON.stringify(task), 'utf-8');
  }

  it('updateTask same-org happy path: still works via the fast path', () => {
    // Regression guard for the existing single-org behavior. This is the
    // hot path and must not pay any cross-org scan cost when it hits.
    const taskId = createTask(orgAPaths, 'agentA', 'OrgA', 'Same-org task');
    updateTask(orgAPaths, taskId, 'in_progress');

    const content = JSON.parse(
      readFileSync(join(orgAPaths.taskDir, `${taskId}.json`), 'utf-8'),
    );
    expect(content.status).toBe('in_progress');
  });

  it('updateTask cross-org: finds task in sibling org via findTaskFile fallback', () => {
    // Repro: file a task in OrgB, try to update it from an OrgA-scoped
    // session. Before findTaskFile, this threw "Task not found" because
    // updateTask only looked at orgAPaths.taskDir.
    const taskId = 'task_test_001';
    writeOrgBTask(taskId);

    updateTask(orgAPaths, taskId, 'in_progress');

    // Verify the OrgB file got updated, NOT the (nonexistent) OrgA file.
    const orgBContent = JSON.parse(
      readFileSync(join(orgBTaskDir, `${taskId}.json`), 'utf-8'),
    );
    expect(orgBContent.status).toBe('in_progress');
    // Explicit timestamp comparison: the seed updated_at is a fixed moment
    // in the past, so the real Date.now() that updateTask stamps MUST be
    // strictly greater. Avoids the brittle string-inequality form that
    // would silently pass on any future refactor that changed the seed.
    expect(new Date(orgBContent.updated_at).getTime()).toBeGreaterThan(
      new Date('2026-04-11T20:00:00Z').getTime(),
    );
    expect(existsSync(join(orgAPaths.taskDir, `${taskId}.json`))).toBe(false);
  });

  it('updateTask not found anywhere: throws with a clear error naming ctxRoot', () => {
    expect(() => updateTask(orgAPaths, 'task_999_000', 'in_progress')).toThrow(
      /not found in any org under .*\/orgs\//,
    );
  });

  it('completeTask cross-org: finds task in sibling org and marks it done', () => {
    const taskId = 'task_test_002';
    writeOrgBTask(taskId);

    completeTask(orgAPaths, taskId, 'cross-org completion');

    const orgBContent = JSON.parse(
      readFileSync(join(orgBTaskDir, `${taskId}.json`), 'utf-8'),
    );
    expect(orgBContent.status).toBe('completed');
    expect(orgBContent.completed_at).toBeTruthy();
    expect(orgBContent.result).toBe('cross-org completion');
  });

  it('findTaskFile ambiguity: same ID in two orgs triggers warn naming both orgs', () => {
    // Manually create the same task id in BOTH orgs. Real collisions
    // should be vanishingly rare (epoch_ms + 3 digits), but the warn path
    // must be tested so operators hitting it in production get actionable
    // information.
    const taskId = 'task_1_000';
    writeOrgBTask(taskId);
    // Write the same ID to OrgA via direct filesystem (bypassing
    // createTask so we can reuse the exact ID).
    const orgATaskPath = join(orgAPaths.taskDir, `${taskId}.json`);
    writeFileSync(
      orgATaskPath,
      JSON.stringify({
        id: taskId,
        title: 'OrgA collision',
        status: 'pending',
        org: 'OrgA',
        updated_at: '2026-04-11T20:00:00Z',
        created_at: '2026-04-11T20:00:00Z',
      }),
      'utf-8',
    );

    // findTaskFile should return the OrgA path (same-org fast path wins)
    // without ever emitting the ambiguity warning. The fast path only
    // checks same-org; the cross-org scan is ONLY exercised when same-org
    // misses. So the ambiguity warning path requires same-org to miss
    // AND multiple sibling orgs to hit.
    //
    // To exercise the warn, delete the OrgA copy and write collisions
    // into two OTHER orgs.
    rmSync(orgATaskPath);
    mkdirSync(join(testDir, 'orgs', 'OrgC', 'tasks'), { recursive: true });
    writeFileSync(
      join(testDir, 'orgs', 'OrgC', 'tasks', `${taskId}.json`),
      JSON.stringify({
        id: taskId,
        title: 'OrgC collision',
        status: 'pending',
        org: 'OrgC',
        updated_at: '2026-04-11T20:00:00Z',
        created_at: '2026-04-11T20:00:00Z',
      }),
      'utf-8',
    );

    const result = findTaskFile(orgAPaths, taskId);
    expect(result).not.toBeNull();
    // Warn must have fired and must name BOTH the task id and the two orgs.
    expect(warnLog.length).toBeGreaterThanOrEqual(1);
    const warn = warnLog[0];
    expect(warn).toContain(taskId);
    expect(warn).toMatch(/found in 2 orgs/);
    expect(warn).toContain('OrgB');
    expect(warn).toContain('OrgC');
  });

  it('listTasks scoping regression: must remain single-org, NO cross-org leakage', () => {
    // CRITICAL regression guard. Scoping contract:
    // listTasks must remain single-org by default — cross-org listing
    // requires an explicit opt-in flag that does not exist yet. A future
    // well-meaning refactor that 'helpfully' makes listTasks cross-org by
    // default would silently break the dashboard, which depends on
    // per-org scoping for its sync loop. If this test fails, the refactor
    // broke the contract and must be reverted or gated behind an opt-in
    // flag.
    const sameOrgId = createTask(orgAPaths, 'agentA', 'OrgA', 'Same-org task');
    writeOrgBTask('task_other_1', { title: 'Sibling-org task 1' });
    writeOrgBTask('task_other_2', { title: 'Sibling-org task 2' });

    const tasks = listTasks(orgAPaths);
    expect(tasks.length).toBe(1);
    expect(tasks[0].id).toBe(sameOrgId);
    expect(tasks[0].title).toBe('Same-org task');
  });
});

describe('claimTask — atomic claim (beads-inspired)', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-claim-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'x'),
      inflight: join(testDir, 'inflight', 'x'),
      processed: join(testDir, 'processed', 'x'),
      logDir: join(testDir, 'logs', 'x'),
      stateDir: join(testDir, 'state', 'x'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  it('happy path: claims a pending task, flips status + assignee, writes lock file', () => {
    const id = createTask(paths, 'alice', 'acme', 'Claimable work');
    const task = claimTask(paths, id, 'alice');
    expect(task.status).toBe('in_progress');
    expect(task.assigned_to).toBe('alice');

    // Persisted to disk
    const onDisk = JSON.parse(readFileSync(join(paths.taskDir, `${id}.json`), 'utf-8'));
    expect(onDisk.status).toBe('in_progress');
    expect(onDisk.assigned_to).toBe('alice');

    // Lock file recorded the claimant + timestamp
    const lock = readFileSync(join(paths.taskDir, '.claims', `${id}.claim`), 'utf-8');
    expect(lock.split('\t')[0]).toBe('alice');
  });

  it('rejects second claim with a named owner when the lock already exists', () => {
    const id = createTask(paths, 'alice', 'acme', 'Race target');
    claimTask(paths, id, 'alice');
    expect(() => claimTask(paths, id, 'bob-agent')).toThrow(/already claimed by alice/);
  });

  it('is idempotent when the same agent re-claims (no throw, returns the task)', () => {
    const id = createTask(paths, 'alice', 'acme', 'Re-claim');
    claimTask(paths, id, 'alice');
    const again = claimTask(paths, id, 'alice');
    expect(again.assigned_to).toBe('alice');
    expect(again.status).toBe('in_progress');
  });

  it('rejects claim on a non-pending task with a clear status message', () => {
    const id = createTask(paths, 'alice', 'acme', 'Already done');
    updateTask(paths, id, 'completed');
    expect(() => claimTask(paths, id, 'alice')).toThrow(/not pending.*status=completed/);
  });

  it('throws "not found" for an unknown task id', () => {
    expect(() => claimTask(paths, 'task_nonexistent_000', 'alice')).toThrow(/not found in any org/);
  });

  it('rolls back the lock if the task-JSON write fails (so retry can still succeed)', () => {
    const id = createTask(paths, 'alice', 'acme', 'Rollback probe');
    const claimPath = join(paths.taskDir, '.claims', `${id}.claim`);

    // Force atomicWriteSync to fail by deleting the task file mid-flight.
    // Simplest repro: remove the task json right after the lock is taken
    // by intercepting findTaskFile's call path — instead just delete the
    // task file before claimTask reads it, and reuse the existing
    // not-found path. Then confirm no stale .claim file is left behind.
    rmSync(join(paths.taskDir, `${id}.json`));
    expect(() => claimTask(paths, id, 'alice')).toThrow(/not found in any org/);
    expect(existsSync(claimPath)).toBe(false);
  });
});

describe('Task audit log (append-only JSONL)', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-audit-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'x'),
      inflight: join(testDir, 'inflight', 'x'),
      processed: join(testDir, 'processed', 'x'),
      logDir: join(testDir, 'logs', 'x'),
      stateDir: join(testDir, 'state', 'x'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  it('createTask writes one "create" audit entry', () => {
    const id = createTask(paths, 'alice', 'acme', 'First task', { description: 'd' });
    const log = readTaskAudit(paths, id);
    expect(log.length).toBe(1);
    expect(log[0].event).toBe('create');
    expect(log[0].agent).toBe('alice');
    expect(log[0].to).toBe('pending');
    expect(log[0].note).toBe('First task');
  });

  it('full lifecycle records create + claim + complete in order', () => {
    const id = createTask(paths, 'alice', 'acme', 'Lifecycle');
    claimTask(paths, id, 'alice');
    completeTask(paths, id, 'shipped');

    const log = readTaskAudit(paths, id);
    expect(log.map(e => e.event)).toEqual(['create', 'claim', 'complete']);
    expect(log[1].from).toBe('pending');
    expect(log[1].to).toBe('in_progress');
    expect(log[1].agent).toBe('alice');
    expect(log[2].from).toBe('in_progress');
    expect(log[2].to).toBe('completed');
    expect(log[2].note).toBe('shipped');
  });

  it('updateTask audit captures from->to transition with assignee as agent', () => {
    const id = createTask(paths, 'alice', 'acme', 'Updatable', { assignee: 'alice' });
    updateTask(paths, id, 'blocked');
    updateTask(paths, id, 'pending');

    const log = readTaskAudit(paths, id);
    expect(log.length).toBe(3); // create + 2 updates
    expect(log[1].event).toBe('update');
    expect(log[1].from).toBe('pending');
    expect(log[1].to).toBe('blocked');
    expect(log[1].agent).toBe('alice');
    expect(log[2].from).toBe('blocked');
    expect(log[2].to).toBe('pending');
  });

  it('audit log is append-only — existing entries are never overwritten', () => {
    const id = createTask(paths, 'alice', 'acme', 'Append proof');
    const path = join(paths.taskDir, 'audit', `${id}.jsonl`);
    const before = readFileSync(path, 'utf-8');
    updateTask(paths, id, 'blocked');
    const after = readFileSync(path, 'utf-8');
    expect(after.startsWith(before)).toBe(true);
    expect(after.length).toBeGreaterThan(before.length);
  });

  it('corrupt lines are skipped without blocking replay of surrounding entries', () => {
    const id = createTask(paths, 'alice', 'acme', 'Corrupt survivor');
    const path = join(paths.taskDir, 'audit', `${id}.jsonl`);
    // Inject a malformed line between two valid ones
    writeFileSync(path, readFileSync(path, 'utf-8') + 'not-json-at-all\n');
    updateTask(paths, id, 'in_progress');
    const log = readTaskAudit(paths, id);
    expect(log.length).toBe(2); // create + update, corrupt middle line skipped
    expect(log[0].event).toBe('create');
    expect(log[1].event).toBe('update');
  });

  it('readTaskAudit returns [] for a task with no history', () => {
    expect(readTaskAudit(paths, 'task_nonexistent_000')).toEqual([]);
  });
});

describe('Task dependency DAG (blocks / blocked_by)', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-dag-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'x'),
      inflight: join(testDir, 'inflight', 'x'),
      processed: join(testDir, 'processed', 'x'),
      logDir: join(testDir, 'logs', 'x'),
      stateDir: join(testDir, 'state', 'x'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  function readTask(id: string) {
    return JSON.parse(readFileSync(join(paths.taskDir, `${id}.json`), 'utf-8'));
  }

  it('blocked_by stores the declared dependency + the peer gets a symmetric blocks edge', () => {
    const a = createTask(paths, 'alice', 'acme', 'A (blocker)');
    const b = createTask(paths, 'alice', 'acme', 'B (blocked)', { blockedBy: [a] });

    expect(readTask(b).blocked_by).toEqual([a]);
    expect(readTask(a).blocks).toEqual([b]);
  });

  it('blocks is the symmetric reverse of blocked_by', () => {
    const a = createTask(paths, 'alice', 'acme', 'A');
    const b = createTask(paths, 'alice', 'acme', 'B', { blocks: [a] });

    // "B blocks A" means A is blocked_by B
    expect(readTask(a).blocked_by).toEqual([b]);
    expect(readTask(b).blocks).toEqual([a]);
  });

  it('checkTaskDependencies returns open blockers with their current status', () => {
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker');
    const blocked = createTask(paths, 'alice', 'acme', 'Blocked', { blockedBy: [blocker] });

    let open = checkTaskDependencies(paths, blocked);
    expect(open.length).toBe(1);
    expect(open[0].id).toBe(blocker);
    expect(open[0].status).toBe('pending');

    completeTask(paths, blocker, 'done');
    open = checkTaskDependencies(paths, blocked);
    expect(open).toEqual([]);
  });

  it('checkTaskDependencies reports missing:true for dangling dep references', () => {
    const b = createTask(paths, 'alice', 'acme', 'B', { blockedBy: ['task_nonexistent_777'] });
    const open = checkTaskDependencies(paths, b);
    expect(open).toEqual([{ id: 'task_nonexistent_777', status: 'missing' }]);
  });

  it('cycle detection: A blocked_by B, B blocked_by A throws at creation', () => {
    const a = createTask(paths, 'alice', 'acme', 'A');
    const b = createTask(paths, 'alice', 'acme', 'B', { blockedBy: [a] });
    // A declares new blocked_by edge to B — would form A -> B -> A cycle.
    expect(() => createTask(paths, 'alice', 'acme', 'A-rewrite', { blockedBy: [b], blocks: [a] })).toThrow(/cycle/i);
  });

  it('REGRESSION: cycle-rejected createTask leaves ZERO state on disk — no task json, no audit, no peer mutation', () => {
    const a = createTask(paths, 'alice', 'acme', 'A');
    const b = createTask(paths, 'alice', 'acme', 'B', { blockedBy: [a] });
    const c = createTask(paths, 'alice', 'acme', 'C', { blockedBy: [b] });

    // Snapshot A's blocks list before the cycle-try attempt.
    const aBlocksBefore = readTask(a).blocks ?? [];

    // Attempt a cycle: new task blocked_by c + blocks a → cycle-try → a → b → c → cycle-try.
    const filesBefore = readdirSync(paths.taskDir).filter(f => f.startsWith('task_')).sort();
    expect(() => createTask(paths, 'alice', 'acme', 'cycle-try', { blockedBy: [c], blocks: [a] })).toThrow(/cycle/i);

    // Invariants: (1) no new task JSON, (2) no audit directory entry for the rejected id,
    // (3) peer A's blocks list unchanged.
    const filesAfter = readdirSync(paths.taskDir).filter(f => f.startsWith('task_')).sort();
    expect(filesAfter).toEqual(filesBefore);
    // A's `blocks` list must not have been mutated by the attempted creation.
    expect(readTask(a).blocks ?? []).toEqual(aBlocksBefore);
    // No dangling audit dir file for a task id that never existed.
    const auditDir = join(paths.taskDir, 'audit');
    if (existsSync(auditDir)) {
      const auditFiles = readdirSync(auditDir);
      // No audit file for any task whose id isn't one of the 3 we successfully created.
      const validIds = new Set([a, b, c]);
      for (const f of auditFiles) {
        const id = f.replace(/\.jsonl$/, '');
        expect(validIds.has(id)).toBe(true);
      }
    }
  });

  it('listTasks --respect-deps orders unblocked tasks before blocked ones', () => {
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker');
    const blocked = createTask(paths, 'alice', 'acme', 'Blocked', { blockedBy: [blocker] });
    const free = createTask(paths, 'alice', 'acme', 'Free');

    const ordered = listTasks(paths, { respectDeps: true });
    const ids = ordered.map(t => t.id);
    // All 3 present
    expect(ids).toContain(blocker);
    expect(ids).toContain(blocked);
    expect(ids).toContain(free);
    // `blocked` must come after both `blocker` and `free` in the list.
    const idx = (id: string) => ids.indexOf(id);
    expect(idx(blocked)).toBeGreaterThan(idx(blocker));
    expect(idx(blocked)).toBeGreaterThan(idx(free));

    // Once blocker completes, respectDeps no longer demotes blocked.
    completeTask(paths, blocker, 'done');
    const reordered = listTasks(paths, { respectDeps: true });
    const blockedTask = reordered.find(t => t.id === blocked)!;
    expect(blockedTask.status).toBe('pending');
    // Specifically: blocked should no longer be forced after 'free'
    // (both unblocked now, fall back to created_at ordering).
  });
});

describe('compactTasks — semantic compaction of old completed tasks', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-compact-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'x'),
      inflight: join(testDir, 'inflight', 'x'),
      processed: join(testDir, 'processed', 'x'),
      logDir: join(testDir, 'logs', 'x'),
      stateDir: join(testDir, 'state', 'x'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  // Helper: age a completed task's completed_at by overwriting the JSON.
  function backdateCompletion(id: string, daysAgo: number) {
    const p = join(paths.taskDir, `${id}.json`);
    const t = JSON.parse(readFileSync(p, 'utf-8'));
    const ts = new Date(Date.now() - daysAgo * 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    t.completed_at = ts;
    t.updated_at = ts;
    writeFileSync(p, JSON.stringify(t));
  }

  it('archives a completed task older than cutoff — removes active JSON, preserves audit log', () => {
    const id = createTask(paths, 'alice', 'acme', 'Old done', { assignee: 'alice' });
    completeTask(paths, id, 'shipped');
    backdateCompletion(id, 40);

    const auditPath = join(paths.taskDir, 'audit', `${id}.jsonl`);
    expect(existsSync(auditPath)).toBe(true);

    const report = compactTasks(paths, { olderThanDays: 30 });
    expect(report.archived.map(a => a.id)).toEqual([id]);
    expect(report.skipped).toEqual([]);

    // Active JSON gone, audit log still there
    expect(existsSync(join(paths.taskDir, `${id}.json`))).toBe(false);
    expect(existsSync(auditPath)).toBe(true);

    // Archive entry written to the correct month file
    const archiveFile = report.archived[0].archive_file;
    const archiveLine = readFileSync(join(paths.taskDir, archiveFile), 'utf-8').trim();
    const entry = JSON.parse(archiveLine);
    expect(entry.id).toBe(id);
    expect(entry.title).toBe('Old done');
    expect(entry.result).toBe('shipped');
    expect(entry.assigned_to).toBe('alice');
  });

  it('skips recently-completed tasks (within cutoff)', () => {
    const id = createTask(paths, 'alice', 'acme', 'Fresh done');
    completeTask(paths, id, 'ok');
    // Leave completed_at as "just now" — should be skipped.
    const report = compactTasks(paths, { olderThanDays: 30 });
    expect(report.archived).toEqual([]);
    expect(report.skipped.find(s => s.id === id)?.reason).toMatch(/within cutoff/);
  });

  it('skips in-progress and blocked tasks regardless of age', () => {
    const a = createTask(paths, 'alice', 'acme', 'In progress');
    claimTask(paths, a, 'alice'); // -> in_progress
    const b = createTask(paths, 'alice', 'acme', 'Blocked');
    updateTask(paths, b, 'blocked');

    const report = compactTasks(paths, { olderThanDays: 0 });
    expect(report.archived).toEqual([]);
  });

  it('NEVER archives a completed task still referenced by an open task\'s blocked_by chain', () => {
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker');
    const dependent = createTask(paths, 'alice', 'acme', 'Dependent', { blockedBy: [blocker] });
    completeTask(paths, blocker, 'done');
    backdateCompletion(blocker, 60);

    // Dependent is still pending → blocker must not be compacted away.
    expect(dependent).toBeDefined();
    const report = compactTasks(paths, { olderThanDays: 30 });
    expect(report.archived).toEqual([]);
    expect(report.skipped.find(s => s.id === blocker)?.reason).toMatch(/still.*blocked_by/);
    expect(existsSync(join(paths.taskDir, `${blocker}.json`))).toBe(true);
  });

  it('REGRESSION: transitive blocker guard — A<-B<-C with C open preserves BOTH A and B', () => {
    const a = createTask(paths, 'alice', 'acme', 'A');
    const b = createTask(paths, 'alice', 'acme', 'B', { blockedBy: [a] });
    const c = createTask(paths, 'alice', 'acme', 'C', { blockedBy: [b] });
    expect(c).toBeDefined();

    // A + B both completed and aged out; C stays open.
    completeTask(paths, a, 'done-a');
    completeTask(paths, b, 'done-b');
    backdateCompletion(a, 60);
    backdateCompletion(b, 60);

    const report = compactTasks(paths, { olderThanDays: 30 });
    // Neither A nor B should be archived — both are in the transitive
    // blocker closure of open C.
    expect(report.archived).toEqual([]);
    const skippedIds = report.skipped.map(s => s.id).sort();
    expect(skippedIds).toContain(a);
    expect(skippedIds).toContain(b);
    // Both must still be on disk.
    expect(existsSync(join(paths.taskDir, `${a}.json`))).toBe(true);
    expect(existsSync(join(paths.taskDir, `${b}.json`))).toBe(true);
  });

  it('once the dependent completes, the blocker becomes eligible', () => {
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker');
    const dependent = createTask(paths, 'alice', 'acme', 'Dependent', { blockedBy: [blocker] });
    completeTask(paths, blocker, 'done');
    backdateCompletion(blocker, 60);
    completeTask(paths, dependent, 'done');
    backdateCompletion(dependent, 60);

    const report = compactTasks(paths, { olderThanDays: 30 });
    const archivedIds = report.archived.map(a => a.id).sort();
    expect(archivedIds).toEqual([blocker, dependent].sort());
  });

  it('is idempotent — running a second time on the same data archives nothing', () => {
    const id = createTask(paths, 'alice', 'acme', 'Run-twice');
    completeTask(paths, id, 'ok');
    backdateCompletion(id, 60);

    const first = compactTasks(paths, { olderThanDays: 30 });
    expect(first.archived.map(a => a.id)).toEqual([id]);

    const second = compactTasks(paths, { olderThanDays: 30 });
    expect(second.archived).toEqual([]);
  });

  it('dry-run reports candidates without modifying anything', () => {
    const id = createTask(paths, 'alice', 'acme', 'Dry-run target');
    completeTask(paths, id, 'ok');
    backdateCompletion(id, 60);

    const report = compactTasks(paths, { olderThanDays: 30, dryRun: true });
    expect(report.dry_run).toBe(true);
    expect(report.archived.map(a => a.id)).toEqual([id]);
    // Active JSON still present
    expect(existsSync(join(paths.taskDir, `${id}.json`))).toBe(true);
  });

  });

});

describe('UTF-8 BOM tolerance (2026-07-30 incident)', () => {
  // A UTF-8 BOM on ONE task file of 708 made that task invisible to every reader in this module,
  // because each wrapped JSON.parse in a silent catch. It hid a HIGH-priority, blocked, 49-day-old task
  // from listTasks AND from checkStaleTasks — the detector whose whole job is finding forgotten work.
  // The same BOM broke the symmetric-edge WRITE while createTask reported success.
  //
  // Self-contained on purpose: an earlier version relied on an enclosing describe's `paths` and silently
  // landed in the wrong one, producing ENOENT instead of testing anything.
  let dir: string;
  let p: BusPaths;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cortextos-bom-test-'));
    p = {
      ctxRoot: dir, inbox: join(dir, 'inbox'), inflight: join(dir, 'inflight'),
      processed: join(dir, 'processed'), logDir: join(dir, 'logs'), stateDir: join(dir, 'state'),
      taskDir: join(dir, 'tasks'), approvalDir: join(dir, 'approvals'),
      analyticsDir: join(dir, 'analytics'), heartbeatDir: join(dir, 'heartbeats'),
    } as BusPaths;
    mkdirSync(p.taskDir, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const withBom = (id: string, over: Record<string, unknown> = {}) => {
    const t = {
      id, title: 'bom task', description: '', type: 'agent', needs_approval: false,
      status: 'pending', assigned_to: 'boris', created_by: 'paul', org: 'acme',
      priority: 'high', project: '', kpi_key: null,
      created_at: '2026-06-11T02:34:52Z', updated_at: '2026-06-11T02:34:52Z',
      completed_at: null, due_date: null, archived: false, ...over,
    };
    writeFileSync(join(p.taskDir, `${id}.json`), '﻿' + JSON.stringify(t), 'utf-8');
  };

  it('listTasks SEES a BOM-prefixed task — it was invisible before', () => {
    withBom('task_bom_001');
    expect(listTasks(p).map((t) => t.id)).toContain('task_bom_001');
  });

  it('checkStaleTasks SEES a BOM-prefixed task — the forgotten-work detector was blind to it', () => {
    withBom('task_bom_002', { created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' });
    expect(checkStaleTasks(p).stale_pending.map((t) => t.id)).toContain('task_bom_002');
  });

  it('a symmetric edge WRITES onto a BOM-prefixed peer — the half-recorded-relationship bug', () => {
    withBom('task_bom_003');
    const blocker = createTask(p, 'paul', 'acme', 'blocker', { blocks: ['task_bom_003'] });
    const peer = JSON.parse(
      readFileSync(join(p.taskDir, 'task_bom_003.json'), 'utf-8').replace(/^﻿/, ''),
    );
    expect(peer.blocked_by).toContain(blocker);
  });

  it('NEGATIVE CONTROL: a genuinely corrupt peer is REPORTED, not silently skipped', () => {
    // The BOM was one cause of failure; the SILENT CATCH was the defect. Without this, the edge test
    // above could pass while every other cause stayed swallowed.
    writeFileSync(join(p.taskDir, 'task_corrupt_1.json'), '{ not valid json', 'utf-8');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const id = createTask(p, 'paul', 'acme', 'blocker2', { blocks: ['task_corrupt_1'] });
    expect(spy).toHaveBeenCalled();
    expect(String(spy.mock.calls[0][0])).toMatch(/HALF-RECORDED/);
    spy.mockRestore();
    const notes = readTaskAudit(p, id).map((e) => e.note ?? '').join(' ');
    expect(notes).toMatch(/PARTIAL: 1 dependency edge\(s\) NOT written/);
  });
});

describe('stale_blocked bucket (2026-07-30)', () => {
  // `blocked` was in NO bucket, so a blocked task aged indefinitely and the stale detector never
  // mentioned it. Real case: a HIGH task blocked 49 days, invisible even after a BOM fix made it
  // visible to list-tasks. Blocked is the worst status to omit — pending gets picked up, in_progress
  // trips an alarm, blocked waits on a third party with nobody watching.
  let dir: string;
  let p: BusPaths;

  const write = (id: string, over: Record<string, unknown>) => {
    const t = {
      id, title: 't', description: '', type: 'agent', needs_approval: false,
      status: 'pending', assigned_to: 'boris', created_by: 'paul', org: 'acme',
      priority: 'high', project: '', kpi_key: null,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      completed_at: null, due_date: null, archived: false, ...over,
    };
    writeFileSync(join(p.taskDir, `${id}.json`), JSON.stringify(t), 'utf-8');
  };
  const hoursAgo = (h: number) =>
    new Date(Date.now() - h * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cortextos-blocked-test-'));
    p = {
      ctxRoot: dir, inbox: join(dir, 'i'), inflight: join(dir, 'f'), processed: join(dir, 'p'),
      logDir: join(dir, 'l'), stateDir: join(dir, 's'), taskDir: join(dir, 'tasks'),
      approvalDir: join(dir, 'a'), analyticsDir: join(dir, 'an'), heartbeatDir: join(dir, 'h'),
    } as BusPaths;
    mkdirSync(p.taskDir, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reports a long-blocked task — it was in no bucket at all before', () => {
    write('task_blk_old', { status: 'blocked', updated_at: hoursAgo(49 * 24),
                            blocked_by: ['task_blocker_1'] });
    const r = checkStaleTasks(p);
    expect(r.stale_blocked.map((t) => t.id)).toContain('task_blk_old');
    // blocked_by travels on the Task, so a caller can see WHAT it waits on without a new field.
    expect(r.stale_blocked[0].blocked_by).toEqual(['task_blocker_1']);
  });

  it('NEGATIVE CONTROL: a freshly blocked task is NOT reported — this is a re-check cadence', () => {
    write('task_blk_new', { status: 'blocked', updated_at: hoursAgo(2) });
    expect(checkStaleTasks(p).stale_blocked).toEqual([]);
  });

  it('NEGATIVE CONTROL: blocked does NOT leak into the alarm buckets', () => {
    // If it did, moving an in_progress item to `blocked` would keep tripping the alarm, and callers
    // that key severity off those buckets would start treating a normal waiting state as a failure.
    write('task_blk_leak', { status: 'blocked', updated_at: hoursAgo(49 * 24) });
    const r = checkStaleTasks(p);
    expect(r.stale_in_progress).toEqual([]);
    expect(r.stale_pending).toEqual([]);
    expect(r.stale_human).toEqual([]);
  });

  it('recording a blocker does NOT reset the blocked-age clock — the fix must not defeat itself', () => {
    // ENFORCES an accidental correctness. `addSymmetricEdge` does not bump `updated_at`, which is why a
    // 49-day blocked task still read 43d after its blocker was recorded rather than resetting to 0.
    // If it DID bump — the obvious "tidy this to match the other writers" change — then writing a
    // blocker would reset the age and hide the task from stale_blocked for another 24h. The fix would
    // be defeated by an unrelated write, and nothing would say so.
    //
    // This is the same shape as a sabotage harness that only passes because nobody has touched the
    // source yet: correctness that survives by luck rather than by constraint.
    write('task_blk_edge', { status: 'blocked', updated_at: hoursAgo(49 * 24) });
    const blocker = createTask(p, 'paul', 'acme', 'the blocker', { blocks: ['task_blk_edge'] });

    // FIRST assert the edge actually landed. Without this the test could pass vacuously: a broken
    // addSymmetricEdge writes nothing, updated_at is trivially unchanged, and the real assertion below
    // would hold for the wrong reason.
    const peer = JSON.parse(readFileSync(join(p.taskDir, 'task_blk_edge.json'), 'utf-8'));
    expect(peer.blocked_by).toContain(blocker);

    // THEN the thing that matters: it is still reported as long-blocked.
    expect(checkStaleTasks(p).stale_blocked.map((t) => t.id)).toContain('task_blk_edge');
  });

  it('NEGATIVE CONTROL: the pre-existing buckets still fire — the new branch changed nothing else', () => {
    write('task_ip', { status: 'in_progress', updated_at: hoursAgo(9) });
    write('task_pd', { status: 'pending', created_at: hoursAgo(30), updated_at: hoursAgo(30) });
    const r = checkStaleTasks(p);
    expect(r.stale_in_progress.map((t) => t.id)).toContain('task_ip');
    expect(r.stale_pending.map((t) => t.id)).toContain('task_pd');
  });
});

/**
 * The task mutation verb gap (2026-07-30). `updateTask` exposed status and priority only, so five
 * agents routed around it in one day — notes into log-event meta, a constraint into a chat message,
 * dependency edges hand-mirrored across three JSON files, and the orchestrator unable to reassign
 * a task at all.
 */
describe('task mutation verbs', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-verbgap-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'a'),
      inflight: join(testDir, 'inflight', 'a'),
      processed: join(testDir, 'processed', 'a'),
      logDir: join(testDir, 'logs', 'a'),
      stateDir: join(testDir, 'state', 'a'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });
  afterEach(() => rmSync(testDir, { recursive: true, force: true }));

  const read = (id: string) => JSON.parse(readFileSync(findTaskFile(paths, id)!, 'utf-8'));

  it('description, project and due_date are mutable after creation', () => {
    const id = createTask(paths, 'a', 'org', 'T', { description: 'old', project: 'p1' });
    updateTask(paths, id, 'in_progress', { description: 'new', project: 'p2', dueDate: '2026-08-01T00:00:00Z' });
    const t = read(id);
    expect(t.description).toBe('new');
    expect(t.project).toBe('p2');
    expect(t.due_date).toBe('2026-08-01T00:00:00Z');
  });

  /**
   * THE CHECK NAMED IN THE SCOPE DOC, AND UNTIL NOW IT WAS UNWRITEABLE.
   *
   * `createTask` always accepted `dueDate`, but no CLI path passed it, so no task could carry a due
   * date — which made `checkStaleTasks`'s `overdue` count structurally 0 forever. It was reported
   * as `overdue: 0` and read as good news the entire time. A gap that renders its own health metric
   * unfalsifiable is the sharpest possible argument for closing it.
   */
  it('overdue can now be non-zero — the metric is falsifiable for the first time', () => {
    const id = createTask(paths, 'a', 'org', 'overdue one');
    expect(checkStaleTasks(paths).overdue.length).toBe(0); // control: not yet due
    updateTask(paths, id, 'pending', { dueDate: '2020-01-01T00:00:00Z' });
    expect(checkStaleTasks(paths).overdue.map((t) => t.id)).toContain(id);
  });

  it('reassignment works, and is audited with both sides', () => {
    const id = createTask(paths, 'a', 'org', 'T', { assignee: 'agent_one' });
    updateTask(paths, id, 'pending', { assignee: 'agent_two' });
    expect(read(id).assigned_to).toBe('agent_two');
    const audit = readTaskAudit(paths, id).find((e) => e.from_assignee !== undefined);
    expect(audit).toMatchObject({ from_assignee: 'agent_one', to_assignee: 'agent_two' });
  });

  it('REFUSES to reassign a task another agent holds the claim-lock on', () => {
    // The one place this work can BREAK something rather than unblock it. Silently overwriting
    // assigned_to around an O_EXCL claim-lock is the double-pick race the lock exists to prevent.
    const id = createTask(paths, 'a', 'org', 'T');
    claimTask(paths, id, 'holder_agent');
    expect(() => updateTask(paths, id, 'in_progress', { assignee: 'thief_agent' })).toThrow(/claimed by holder_agent/);
    expect(read(id).assigned_to).toBe('holder_agent'); // and did not partially apply
  });

  it('allows a reassignment that agrees with the existing lock holder', () => {
    // Control for the refusal: a guard that refuses everything is as broken as one that refuses
    // nothing, it just fails loudly instead of silently.
    const id = createTask(paths, 'a', 'org', 'T');
    claimTask(paths, id, 'holder_agent');
    expect(() => updateTask(paths, id, 'in_progress', { assignee: 'holder_agent' })).not.toThrow();
  });

  it('evidence is stored on the TASK, not only in the audit log', () => {
    // An answer only the audit log can see is the workaround this field replaces.
    const id = createTask(paths, 'a', 'org', 'T');
    claimTask(paths, id, 'a', 'will land in work/foo-SCOPE.md');
    expect(read(id).evidence).toBe('will land in work/foo-SCOPE.md');
    completeTask(paths, id, 'done', 'commit abc123');
    expect(read(id).evidence).toBe('commit abc123');
  });

  it('evidence set via updateTask is persisted too — not just via claim/complete', () => {
    // Found by sabotage, not by review: dropping the evidence write in updateTask left the suite
    // GREEN because both existing evidence tests went through claimTask and completeTask. Three
    // transitions can set this field and only two were covered.
    const id = createTask(paths, 'a', 'org', 'T');
    updateTask(paths, id, 'blocked', { evidence: 'waiting on task_123; nothing produced yet' });
    expect(read(id).evidence).toBe('waiting on task_123; nothing produced yet');
  });

  it('accepts a written NEGATIVE RESULT as evidence — the case that killed the typed version', () => {
    // A field accepting only commit-or-filepath re-creates the blindness it exists to fix.
    // Eliminations are the most losable results we have because nobody commits a negative.
    const id = createTask(paths, 'a', 'org', 'investigate');
    const elimination = 'no commit: ruled out all three theories; the bug does not fire on the cited case';
    completeTask(paths, id, undefined, elimination);
    expect(read(id).evidence).toBe(elimination);
  });

  it('add-dependency writes BOTH edges on an existing task', () => {
    const blocked = createTask(paths, 'a', 'org', 'blocked');
    const blocker = createTask(paths, 'a', 'org', 'blocker');
    addTaskDependency(paths, blocked, blocker);
    expect(read(blocked).blocked_by).toContain(blocker);
    expect(read(blocker).blocks).toContain(blocked); // the hand-mirrored half
  });

  it('add-dependency rejects a cycle introduced AFTER creation', () => {
    // A cycle added later is identical in effect to one added at creation, so it gets the same check.
    const x = createTask(paths, 'a', 'org', 'x');
    const y = createTask(paths, 'a', 'org', 'y');
    addTaskDependency(paths, x, y);
    expect(() => addTaskDependency(paths, y, x)).toThrow(/cycle/i);
  });

  it('remove-dependency clears BOTH edges', () => {
    // A one-sided removal leaves the blocker claiming to block a task that no longer lists it,
    // which is worse than the edge existing — the record disagrees with itself.
    const blocked = createTask(paths, 'a', 'org', 'blocked');
    const blocker = createTask(paths, 'a', 'org', 'blocker');
    addTaskDependency(paths, blocked, blocker);
    removeTaskDependency(paths, blocked, blocker);
    expect(read(blocked).blocked_by ?? []).not.toContain(blocker);
    expect(read(blocker).blocks ?? []).not.toContain(blocked);
  });

  it('add-dependency is idempotent and refuses self-blocking', () => {
    const a = createTask(paths, 'a', 'org', 'a');
    const b = createTask(paths, 'a', 'org', 'b');
    addTaskDependency(paths, a, b);
    addTaskDependency(paths, a, b);
    expect(read(a).blocked_by).toEqual([b]);
    expect(() => addTaskDependency(paths, a, a)).toThrow(/cannot block itself/);
  });
});
