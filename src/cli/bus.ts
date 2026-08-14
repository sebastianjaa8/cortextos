import { createHash } from 'node:crypto';
import { Command } from 'commander';
import { spawnSync, execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { sendMessage, checkInbox, ackInbox } from '../bus/message.js';
import { validateAgentName, validateTaskId, validatePriority } from '../utils/validate.js';
import { createTask, updateTask, completeTask, claimTask, addTaskDependency, removeTaskDependency, readTaskAudit, checkTaskDependencies, compactTasks, listTasks, checkStaleTasks, archiveTasks, checkHumanTasks, findRecentDuplicate } from '../bus/task.js';
import { saveOutput } from '../bus/save-output.js';
import { logEvent } from '../bus/event.js';
import { updateHeartbeat, readAllHeartbeats } from '../bus/heartbeat.js';
import { selfRestart, hardRestart, autoCommit, checkGoalStaleness, postActivity } from '../bus/system.js';
import { createExperiment, runExperiment, evaluateExperiment, listExperiments, gatherContext, manageCycle, loadExperimentConfig } from '../bus/experiment.js';
import { browseCatalog, installCommunityItem, loadPiiNames, prepareSubmission, submitCommunityItem } from '../bus/catalog.js';
import { collectMetrics, parseUsageOutput, storeUsageData, checkUpstream, collectTelegramCommands, registerTelegramCommands } from '../bus/metrics.js';
import { createApproval, updateApproval } from '../bus/approval.js';
import { createReminder, listReminders, ackReminder, pruneReminders } from '../bus/reminders.js';
import { updateCronFire, parseDurationMs, readCronState } from '../bus/cron-state.js';
import { addCron, removeCron, readCrons, updateCron as updateCronDef, getCronByName, getExecutionLog } from '../bus/crons.js';
import { nextFireFromCron } from '../daemon/cron-scheduler.js';
import { queryKnowledgeBase, ingestKnowledgeBase, ensureKBDirs } from '../bus/knowledge-base.js';
import { checkUsageApi, refreshOAuthToken, rotateOAuth, loadAccounts, ALERT_5H, ALERT_7D } from '../bus/oauth.js';
import { listAgents } from '../bus/agents.js';
import { generateAgentKey, KEY_FILENAME } from '../bus/keys.js';
import { resolvePaths } from '../utils/paths.js';
import { resolveEnv, resolveTargetAgentDir } from '../utils/env.js';
import { stripBom } from '../utils/strip-bom.js';
import { IPCClient } from '../daemon/ipc-server.js';
import { TelegramAPI } from '../telegram/api.js';
import { logOutboundMessage, cacheLastSent } from '../telegram/logging.js';
import { createOutboundDeliveryId, recordOutboundDelivery, classifyOutboundError } from '../telegram/outbound-journal.js';
import type { Priority, Task, TaskStatus, EventCategory, EventSeverity, ApprovalCategory, ApprovalStatus, OrgContext, CronDefinition } from '../types/index.js';

/**
 * Check if the org requires deliverables and the task has none attached.
 * Returns an error message if the transition should be blocked, or null if allowed.
 */
function checkDeliverableRequirement(taskId: string, frameworkRoot: string, org: string, taskDir: string): string | null {
  // Reject a traversal task id before it builds the task-file path below — this
  // runs ahead of updateTask/completeTask, so it can't rely on findTaskFile's guard.
  validateTaskId(taskId);
  // Read org context to check require_deliverables setting
  const contextPath = join(frameworkRoot, 'orgs', org, 'context.json');
  if (!existsSync(contextPath)) return null;

  let ctx: OrgContext;
  try {
    ctx = JSON.parse(readFileSync(contextPath, 'utf-8'));
  } catch {
    return null; // cannot read config — allow the transition
  }

  if (!ctx.require_deliverables) return null;

  // Check if the task has outputs
  const taskFile = join(taskDir, `${taskId}.json`);
  if (!existsSync(taskFile)) return null;

  let task: Task;
  try {
    task = JSON.parse(readFileSync(taskFile, 'utf-8'));
  } catch {
    return null;
  }

  if (!task.outputs || task.outputs.length === 0) {
    return `Cannot submit task ${taskId}: require_deliverables is enabled but this task has no file deliverables attached. Use "cortextos bus save-output ${taskId} <file>" to attach a deliverable first.`;
  }

  return null;
}

export const busCommand = new Command('bus')
  .description('Bus commands for agent messaging, tasks, and events');

busCommand
  .command('send-message-file')
  .description('Same as send-message, but the body is READ FROM A FILE so it never crosses a shell')
  .argument('<to>', 'Target agent')
  .argument('<priority>', 'Message priority (urgent, high, normal, low)')
  .argument('<path>', 'File containing the message body (UTF-8)')
  .argument('[reply-to]', 'Reply to message ID (optional positional form)')
  .option('--reply-to <id>', 'Reply to message ID')
  .action((to: string, priority: string, bodyPath: string, replyToArg: string | undefined, opts: { replyTo?: string }) => {
    // WHY THIS EXISTS. `send-message` takes the body as a POSITIONAL ARGUMENT, so every message
    // crosses a shell and inherits its quoting rules. On 2026-07-30 that cost SEVEN failures across
    // two agents in one day: backslashes eaten inside heredocs, an apostrophe terminating a
    // single-quoted string, and backticks running as command substitution mid-message.
    //
    // Every one was in the SHELL LAYER, not in the message. The habit fix we adopted — write
    // harnesses to files instead of piping them through `node -e` — is right and does NOT cover
    // this path, because a bus message still has to become an argv entry somehow.
    //
    // Passing a PATH removes the body from argv entirely: an agent writes the file with a
    // non-shell tool and the shell only ever sees a filename with no metacharacters in it.
    //
    // Additive on purpose. `send-message` is unchanged and every existing caller keeps working —
    // reworking its positional signature while fifteen agents depend on it would trade a quoting
    // hazard for a compatibility one.
    const effectiveReplyTo = opts.replyTo ?? replyToArg;
    const validPriorities: Priority[] = ['urgent', 'high', 'normal', 'low'];
    if (!validPriorities.includes(priority as Priority)) {
      console.error(`Invalid priority '${priority}'. Must be one of: ${validPriorities.join(', ')}`);
      process.exit(1);
    }
    try {
      validateAgentName(to);
    } catch (err) {
      console.error(String(err));
      process.exit(1);
    }

    const { readFileSync: readBody, existsSync: bodyExists } = require('fs');
    if (!bodyExists(bodyPath)) {
      // Loud, and distinct from an empty body. A missing file silently sending an empty message is
      // the reassuring-direction failure for a tool whose whole purpose is not losing content.
      console.error(`Message body file not found: ${bodyPath}`);
      process.exit(1);
    }
    let text: string;
    try {
      text = readBody(bodyPath, 'utf-8');
    } catch (err) {
      console.error(`Could not read message body: ${String(err)}`);
      process.exit(1);
    }
    if (!text.trim()) {
      console.error(`Message body file is empty: ${bodyPath}`);
      process.exit(1);
    }

    const env = resolveEnv();

    // Reject an unknown recipient BEFORE any inbox write (task_1785720898226).
    // ensureDir()/atomicWriteSync() inside sendMessage() would otherwise create
    // inbox/<to> for whatever string it's handed — a typo's second attempt then
    // finds that directory already present and is indistinguishable from a
    // registered agent. Checking (and exiting) here, before sendMessage() runs,
    // keeps that directory from ever coming into existence for a bad recipient.
    if (!agentExistsInFramework(to, env.frameworkRoot)) {
      console.error(`Error: agent '${to}' not found in framework. Check orgs/*/agents/ directory. Message will NOT be sent.`);
      process.exit(1);
    }

    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const msgId = sendMessage(paths, env.agentName, to, priority as Priority, text, effectiveReplyTo);
    try {
      logEvent(paths, env.agentName, env.org, 'message', 'agent_message_sent', 'info', JSON.stringify({ to, priority, msg_id: msgId, reply_to: effectiveReplyTo ?? null, from_file: true }));
    } catch { /* non-fatal */ }
    console.log(msgId);
  });

busCommand
  .command('send-message')
  .argument('<to>', 'Target agent')
  .argument('<priority>', 'Message priority (urgent, high, normal, low)')
  .argument('<text>', 'Message text')
  .argument('[reply-to]', 'Reply to message ID (optional positional form)')
  .option('--reply-to <id>', 'Reply to message ID')
  .action((to: string, priority: string, text: string, replyToArg: string | undefined, opts: { replyTo?: string }) => {
    // Accept reply-to as either positional arg or --reply-to flag (P2 fix #9)
    const effectiveReplyTo = opts.replyTo ?? replyToArg;
    const validPriorities: Priority[] = ['urgent', 'high', 'normal', 'low'];
    if (!validPriorities.includes(priority as Priority)) {
      console.error(`Invalid priority '${priority}'. Must be one of: ${validPriorities.join(', ')}`);
      process.exit(1);
    }
    // Security (H9): Validate agent name before any filesystem access.
    try {
      validateAgentName(to);
    } catch (err) {
      console.error(String(err));
      process.exit(1);
    }

    const env = resolveEnv();

    // Reject an unknown recipient BEFORE any inbox write (task_1785720898226).
    // Previously this only warned and proceeded: success and failure were
    // byte-identical (exit 0, an id printed either way), and the warning went
    // to stderr where the fleet's conventional `2>&1 | tail -1` invocation
    // discards it. Worse, sendMessage()'s ensureDir() would create inbox/<to>
    // for whatever string it's handed, so a typo's SECOND attempt found that
    // directory already present and was indistinguishable from a real agent.
    // Reference: send-telegram already fails loudly (exit 1) on an unknown
    // chat id — this brings send-message in line with that house style
    // instead of being the one bus command where a bad recipient is silent.
    if (!agentExistsInFramework(to, env.frameworkRoot)) {
      console.error(`Error: agent '${to}' not found in framework. Check orgs/*/agents/ directory. Message will NOT be sent.`);
      process.exit(1);
    }

    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const msgId = sendMessage(paths, env.agentName, to, priority as Priority, text, effectiveReplyTo);
    try {
      logEvent(paths, env.agentName, env.org, 'message', 'agent_message_sent', 'info', JSON.stringify({ to, priority, msg_id: msgId, reply_to: effectiveReplyTo ?? null }));
    } catch { /* non-fatal */ }
    console.log(msgId);
  });

busCommand
  .command('check-inbox')
  .action(() => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const messages = checkInbox(paths);
    console.log(JSON.stringify(messages));
  });

busCommand
  .command('ack-inbox')
  .argument('<id>', 'Message ID to acknowledge')
  .action((id: string) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    ackInbox(paths, id);
    try {
      logEvent(paths, env.agentName, env.org, 'message', 'inbox_ack', 'info', JSON.stringify({ msg_id: id }));
    } catch { /* non-fatal */ }
    console.log(`ACK'd ${id}`);
  });

/**
 * WARN, DO NOT FAIL — and the hardening trigger is measured, not promised.
 *
 * Failing an empty --evidence today would make the policy real and get routed around under time
 * pressure, and a routed-around gate is worse than none because it still LOOKS enforced. Warning
 * makes it advisory, and an advisory that never hardens is the verified-once bucket: true when
 * written, decaying with nobody comparing.
 *
 * What makes warn-now safe is only the trigger, so the trigger is a number another agent is
 * already producing rather than an intention of ours. The condition is printed in the warning
 * itself so the person being warned can see what closes it — a hardening condition nobody can read
 * is the same as no condition.
 */
function warnMissingEvidence(transition: string): void {
  console.error(
    `NOTE: no --evidence given while ${transition}. Name where the result lives or will live: a ` +
      `commit, a path, a vault heading, or a WRITTEN NEGATIVE RESULT. Eliminations count and are ` +
      `the most losable results we have, because nobody commits a negative.
` +
      `  This is a warning today. --evidence becomes REQUIRED once pm_bot reports evidence-naming ` +
      `coverage at or above 90% for 3 consecutive daily syncs.`,
  );
}

busCommand
  .command('add-dependency')
  .description('Add a blocked_by edge to an EXISTING task, maintaining the symmetric reverse edge')
  .argument('<id>', 'Task that will be blocked')
  .argument('<blocker>', 'Task that must complete first')
  .action((id: string, blocker: string) => {
    // Exposes addSymmetricEdge, which was private and create-time-only. An agent needing an edge
    // after creation hand-mirrored it across three JSON files — correctly, with atomic writes and
    // a BOM check. A hand copy that mirrors internal logic correctly TODAY diverges silently the
    // first time that logic changes, with nothing comparing the copy to the original.
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    try {
      addTaskDependency(paths, id, blocker);
      console.log(`${id} now blocked_by ${blocker}`);
    } catch (err) {
      console.error(String(err instanceof Error ? err.message : err));
      process.exit(1);
    }
  });

busCommand
  .command('remove-dependency')
  .description('Remove a blocked_by edge from a task, clearing the reverse edge too')
  .argument('<id>', 'Task to unblock')
  .argument('<blocker>', 'Blocker to remove')
  .action((id: string, blocker: string) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    try {
      removeTaskDependency(paths, id, blocker);
      console.log(`${id} no longer blocked_by ${blocker}`);
    } catch (err) {
      console.error(String(err instanceof Error ? err.message : err));
      process.exit(1);
    }
  });

busCommand
  .command('create-task')
  .argument('<title>', 'Task title')
  .option('--desc <description>', 'Task description')
  // CANONICAL FLAG, matching the stored field name (task_1785781068786_36016190). `--assignee`
  // stays as a working alias below — it is in prompts, scripts and habits fleet-wide, and breaking
  // it converts a silent query bug into a loud dispatch bug. Merged explicitly in the action
  // handler rather than via a multi-flag Commander string, so the precedence rule (assignedTo wins
  // if somehow both are passed) is visible in one place instead of implied by parser behaviour.
  .option('--assigned-to <agent>', 'Assigned agent (matches the stored field name)')
  .option('--assignee <agent>', 'Alias for --assigned-to')
  .option('--priority <p>', 'Priority (urgent, high, normal, low)', 'normal')
  .option('--project <name>', 'Project name')
  .option('--needs-approval', 'Require human approval before execution')
  .option('--blocked-by <ids>', 'Comma-separated task IDs that must complete before this task can progress')
  .option('--blocks <ids>', 'Comma-separated task IDs that this new task will block (symmetric reverse edge)')
  .action((title: string, opts: { desc?: string; assignee?: string; assignedTo?: string; priority: string; project?: string; needsApproval?: boolean; blockedBy?: string; blocks?: string }) => {
    const assignee = opts.assignedTo ?? opts.assignee;
    // Validate at the CLI boundary, like update-task / log-event / send-message do.
    // Without this the throw from createTask()'s validatePriority escaped to the top
    // level and Node printed a raw stack trace. In a chain of create-task calls that
    // buried which item failed, so later items looked silently dropped (07-18 incident:
    // caused real duplicate-cleanup work). Reuses validatePriority rather than
    // hardcoding a 4th copy of the valid list, so the options can't drift.
    try {
      validatePriority(opts.priority);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const parseList = (raw?: string) => (raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : []);

    // Duplicate safety net: warn, never block. A retry in the dispatch path on
    // 2026-07-18 re-sent several create-task calls and the duplicate open tasks
    // cost real cleanup. Warning goes to stderr so stdout stays exactly the task
    // id — callers do `TASK_ID=$(cortextos bus create-task ...)`.
    const effectiveAssignee = assignee ?? env.agentName;
    const dup = findRecentDuplicate(paths, title, effectiveAssignee);
    if (dup) {
      const ageMin = Math.round((Date.now() - new Date(dup.created_at).getTime()) / 60000);
      console.error(
        `Warning: ${effectiveAssignee} already has an open task with this title from ${ageMin}m ago — ${dup.id} [${dup.status}] "${dup.title}"`
      );
      console.error(
        `Creating anyway. If this was a retry, cancel one: cortextos bus update-task ${dup.id} cancelled`
      );
    }

    const taskId = createTask(paths, env.agentName, env.org, title, {
      description: opts.desc,
      assignee,
      priority: opts.priority as Priority,
      project: opts.project,
      needsApproval: opts.needsApproval ?? false,
      blockedBy: parseList(opts.blockedBy),
      blocks: parseList(opts.blocks),
    });
    console.log(taskId);
    // Auto-notify assignee so the task is visible immediately (issue #78)
    if (assignee && assignee !== env.agentName) {
      const assigneePaths = resolvePaths(assignee, env.instanceId, env.org);
      const desc = opts.desc ? ` — ${opts.desc.slice(0, 120)}` : '';
      sendMessage(assigneePaths, env.agentName, assignee, 'normal',
        `Task assigned: [${opts.priority}] ${title}${desc} (id: ${taskId})`);
    }
  });

busCommand
  .command('update-task')
  .argument('<id>', 'Task ID')
  .argument('<status>', 'New status (pending, in_progress, completed, blocked, cancelled)')
  // Priority was CREATE-ONLY until 2026-07-30, so every re-prioritisation was narrative: an agent
  // could announce "moved off low" while the store kept `low` forever. Agents pick the highest
  // priority task, so a frozen field means they sort by what mattered when the task was FILED.
  .option('--priority <p>', 'Also change priority (urgent, high, normal, low) — audited')
  // Frozen-after-creation until 2026-07-30. Five agents routed around this in one day: notes went
  // into log-event meta, a constraint went into a chat message, dependency edges were hand-mirrored
  // across three JSON files, and the orchestrator could not reassign a task at all.
  .option('--title <text>', 'Correct the title — audited, and the superseded title is preserved into the description')
  .option('--desc <text>', 'Change the description')
  .option('--project <name>', 'Change the project')
  // CANONICAL FLAG, matching the stored field name (task_1785781068786_36016190) — same rename/
  // alias pattern as create-task, merged explicitly below rather than via a multi-flag Commander
  // string.
  .option('--assigned-to <agent>', 'Reassign — REFUSES if another agent holds the claim-lock')
  .option('--assignee <agent>', 'Alias for --assigned-to')
  .option('--due <iso>', 'Set the due date (ISO 8601) — until now unreachable from any CLI path')
  .option('--evidence <text>', 'Where the result lives: commit, path, vault heading, or a written negative result')
  .action((id: string, status: string, opts: { priority?: string; title?: string; desc?: string; project?: string; assignee?: string; assignedTo?: string; due?: string; evidence?: string }) => {
    const assignee = opts.assignedTo ?? opts.assignee;
    const validStatuses: TaskStatus[] = ['pending', 'in_progress', 'completed', 'blocked', 'cancelled'];
    if (!validStatuses.includes(status as TaskStatus)) {
      console.error(`Invalid status '${status}'. Must be one of: ${validStatuses.join(', ')}`);
      process.exit(1);
    }
    // Same valid set as create-task. Rejecting loudly rather than silently ignoring an unknown value:
    // a priority that looks applied and is not is the exact failure this option exists to remove.
    const validPriorities: Priority[] = ['urgent', 'high', 'normal', 'low'];
    if (opts.priority !== undefined && !validPriorities.includes(opts.priority as Priority)) {
      console.error(`Invalid priority '${opts.priority}'. Must be one of: ${validPriorities.join(', ')}`);
      process.exit(1);
    }
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);

    // Guard: block review/completion when deliverables are required but missing.
    // Checks both ready_for_review (approval workflow) and completed (vanilla upstream)
    // so the validator works regardless of which status set is installed.
    try {
      if ((status === 'ready_for_review' || status === 'completed') && env.org) {
        const err = checkDeliverableRequirement(id, env.frameworkRoot, env.org, paths.taskDir);
        if (err) {
          console.error(err);
          process.exit(1);
        }
      }
      const result = updateTask(paths, id, status as TaskStatus, {
        priority: opts.priority as Priority | undefined,
        title: opts.title,
        description: opts.desc,
        project: opts.project,
        assignee,
        dueDate: opts.due,
        evidence: opts.evidence,
      });
      console.log(`Updated ${id} -> ${status}`);
      if (status === 'in_progress' && opts.evidence === undefined) warnMissingEvidence('claiming');
      // Reassignment notify (task_1785781154932_38520243, found by analyst 2026-08-03): the
      // record could change owner and the new owner would never learn of it. Same guard as
      // create-task's auto-notify (issue #78) — never message yourself, and `result.reassigned`
      // is false both when --assigned-to/--assignee was never passed AND when it was passed but
      // matched the existing owner, so a no-op reassignment stays silent too.
      if (result.reassigned && result.assignee && result.assignee !== env.agentName) {
        const assigneePaths = resolvePaths(result.assignee, env.instanceId, env.org);
        sendMessage(assigneePaths, env.agentName, result.assignee, 'normal',
          `Task reassigned to you: ${id} (now ${status})`);
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

busCommand
  .command('compact-tasks')
  .description('Archive completed tasks older than N days into a per-month archive-YYYY-MM.jsonl and remove them from the active list — preserves audit logs, skips tasks still needed as blockers')
  .option('--older-than <days>', 'Cutoff in days (default: 30)', '30')
  .option('--dry-run', 'Report what would be compacted without modifying anything')
  .action((opts: { olderThan: string; dryRun?: boolean }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const olderThanDays = parseInt(opts.olderThan, 10);
    if (isNaN(olderThanDays) || olderThanDays < 0) {
      console.error('--older-than must be a non-negative integer');
      process.exit(1);
    }
    const report = compactTasks(paths, { olderThanDays, dryRun: opts.dryRun });
    const verb = report.dry_run ? 'would compact' : 'compacted';
    console.log(`${verb} ${report.archived.length} task${report.archived.length === 1 ? '' : 's'}, skipped ${report.skipped.length}`);
    for (const a of report.archived) console.log(`  ✓ ${a.id}  ->  ${a.archive_file}`);
    if (report.skipped.length > 0) {
      console.log(`\nSkipped (common reasons: within cutoff, still needed as blocker):`);
      for (const s of report.skipped) console.log(`  - ${s.id}  (${s.reason})`);
    }
  });

busCommand
  .command('check-deps')
  .description('Show open dependencies blocking a task — lists blocked_by entries that are not yet completed')
  .argument('<id>', 'Task ID')
  .action((id: string) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const open = checkTaskDependencies(paths, id);
    if (open.length === 0) {
      console.log(`${id}: no open dependencies — ready to work`);
      return;
    }
    console.log(`${id} blocked by ${open.length} dependency${open.length === 1 ? '' : 's'}:`);
    for (const d of open) console.log(`  ${d.id}  [${d.status}]`);
  });

busCommand
  .command('task-history')
  .description("Show a task's append-only audit log (every status change, claim, and completion)")
  .argument('<id>', 'Task ID')
  .option('--json', 'Emit raw JSONL instead of formatted text')
  .action((id: string, opts: { json?: boolean }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const entries = readTaskAudit(paths, id);
    if (entries.length === 0) {
      console.log(`No audit log for task ${id}`);
      return;
    }
    if (opts.json) {
      for (const e of entries) console.log(JSON.stringify(e));
      return;
    }
    console.log(`Audit log for ${id} (${entries.length} entries):`);
    for (const e of entries) {
      // Render the priority transition too. Without this the audit entry carries
      // from_priority/to_priority on disk while the tool people actually READ prints only
      // "pending -> pending" — recorded but invisible, which is the same defect as not recording it.
      // Caught 2026-07-30 immediately after adding the field: seb_boss's own attempted re-rank sits
      // in the log at 07:25:15Z as a no-op `pending -> pending`, because priority was create-only.
      const prio =
        e.from_priority !== undefined || e.to_priority !== undefined
          ? ` [priority ${e.from_priority ?? '?'} -> ${e.to_priority ?? '?'}]`
          : '';
      // Same reasoning as `prio` above, one field over, and it matters MORE here: the title is
      // the only field `list-tasks` shows, so a retitle that is recorded on disk but absent from
      // the tool people read reproduces exactly the defect --title exists to fix. Rendered in
      // full rather than truncated — a retitle is checked to see what CHANGED, and an ellipsis
      // hides the word that moved.
      const titleChange =
        e.from_title !== undefined || e.to_title !== undefined
          ? `
      [title] "${e.from_title ?? '?'}"
           -> "${e.to_title ?? '?'}"`
          : '';
      const transition = (e.from && e.to ? `${e.from} -> ${e.to}` : e.to || '') + prio;
      const note = e.note ? ` | ${e.note}` : '';
      console.log(`  ${e.ts}  ${e.event.padEnd(8)}  ${e.agent.padEnd(16)}  ${transition}${note}${titleChange}`);
    }
  });

busCommand
  .command('claim-task')
  .description('Atomically claim a pending task — marks in_progress + sets assignee in one shot, rejecting if another agent already owns it')
  .argument('<id>', 'Task ID')
  .option('--agent <name>', 'Agent claiming the task (defaults to CTX_AGENT_NAME)')
  .option('--evidence <text>', 'Intended first artifact — what this task will produce and where it will land')
  .action((id: string, opts: { agent?: string; evidence?: string }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const agent = opts.agent || env.agentName;
    if (!agent) {
      console.error('ERROR: --agent or CTX_AGENT_NAME required');
      process.exit(1);
    }
    try {
      const task = claimTask(paths, id, agent, opts.evidence);
      if (opts.evidence === undefined) warnMissingEvidence('claiming');
      console.log(`Claimed ${id} -> in_progress (assigned to ${agent})`);
      console.log(`  Title: ${task.title}`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

busCommand
  .command('complete-task')
  .argument('<id>', 'Task ID')
  .argument('[result]', 'Completion result (optional positional form)')
  .option('--result <text>', 'Completion result')
  .option('--evidence <text>', 'Where the result lives: commit, path, vault heading, or a written negative result')
  .action((id: string, resultArg: string | undefined, opts: { result?: string; evidence?: string }) => {
    // Accept result as either positional arg or --result flag (P1 fix #8)
    const effectiveResult = opts.result ?? resultArg;
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);

    try {
      // Guard: block completion when deliverables are required but missing
      if (env.org) {
        const err = checkDeliverableRequirement(id, env.frameworkRoot, env.org, paths.taskDir);
        if (err) {
          console.error(err);
          process.exit(1);
        }
      }
      completeTask(paths, id, effectiveResult, opts.evidence);
      if (opts.evidence === undefined) warnMissingEvidence('completing');
      console.log(`Completed ${id}`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

busCommand
  .command('save-output')
  .description('Copy a file into the per-task deliverables tree and link it to the task as a file output')
  .argument('<task-id>', 'Target task ID')
  .argument('<source>', 'Source file to save (absolute or relative to cwd)')
  .option('--label <label>', 'Human-readable label for the linked output (defaults to filename)')
  .option('--move', 'Delete the source file after a successful copy')
  .option('--no-link', 'Save file without linking to task.outputs[]')
  .action((taskId: string, source: string, opts: { label?: string; move?: boolean; link?: boolean }) => {
    const noLink = opts.link === false;
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    try {
      const result = saveOutput(paths, {
        taskId,
        sourcePath: source,
        label: opts.label,
        move: opts.move ?? false,
        noLink,
      });
      console.log(result.targetPath);
      if (result.linked) {
        console.log(`Linked to ${taskId} as [snapshot] ${opts.label ?? result.storedPath}`);
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

busCommand
  .command('list-tasks')
  .option('--agent <name>', 'Filter by agent')
  .option('--status <s>', 'Filter by status')
  .option('--format <fmt>', 'Output format: json or text', 'text')
  .option('--respect-deps', 'Sort DAG-aware: unblocked tasks first, blocked tasks last')
  .action((opts: { agent?: string; status?: string; format?: string; respectDeps?: boolean }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const tasks = listTasks(paths, {
      agent: opts.agent,
      status: opts.status as TaskStatus,
      respectDeps: opts.respectDeps ?? false,
    });

    if (opts.format === 'json') {
      console.log(JSON.stringify(tasks, null, 2));
      return;
    }

    // Text table format
    if (tasks.length === 0) {
      console.log('  No tasks found.');
      return;
    }

    const PRIORITY_ICON: Record<string, string> = { urgent: '🔴', high: '🟠', normal: '🔵', low: '⚪' };
    const STATUS_ICON: Record<string, string> = { pending: '○', in_progress: '●', blocked: '◑', completed: '✓', done: '✓', cancelled: '✗' };

    console.log(`\n  Tasks (${tasks.length})\n`);
    const header = '  Status  Pri  ID                        Assignee         Title';
    const separator = '  ' + '-'.repeat(header.length - 2);
    console.log(header);
    console.log(separator);

    for (const t of tasks) {
      const statusIcon = (STATUS_ICON[t.status] || '?').padEnd(8);
      const priIcon = (PRIORITY_ICON[t.priority] || '·').padEnd(5);
      const id = t.id.substring(0, 26).padEnd(26);
      const assignee = (t.assigned_to || '-').substring(0, 16).padEnd(17);
      const title = t.title.substring(0, 50);
      console.log(`  ${statusIcon}${priIcon}${id}${assignee}${title}`);
    }
    console.log('');
  });

busCommand
  .command('log-event')
  .argument('<category>', 'Event category')
  .argument('<event>', 'Event name')
  .argument('<severity>', 'Severity (info, warning, error, critical)')
  .option('--meta <json>', 'Metadata JSON string', '{}')
  .action((category: string, event: string, severity: string, opts: { meta: string }) => {
    const validCategories: EventCategory[] = ['action', 'error', 'metric', 'milestone', 'heartbeat', 'message', 'task', 'approval'];
    if (!validCategories.includes(category as EventCategory)) {
      console.error(`Invalid category '${category}'. Must be one of: ${validCategories.join(', ')}`);
      process.exit(1);
    }
    const validSeverities: EventSeverity[] = ['info', 'warning', 'error', 'critical'];
    if (!validSeverities.includes(severity as EventSeverity)) {
      console.error(`Invalid severity '${severity}'. Must be one of: ${validSeverities.join(', ')}`);
      process.exit(1);
    }
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    logEvent(paths, env.agentName, env.org, category as EventCategory, event, severity as EventSeverity, opts.meta);
    console.log(`Logged ${category}/${event} (${severity})`);
  });

busCommand
  .command('update-heartbeat')
  .argument('<status>', 'Heartbeat status message')
  .option('--task <task>', 'Current task description')
  .option('--timezone <tz>', 'Timezone for day/night mode detection')
  .option('--interval <i>', 'Loop interval from cron config')
  .action((status: string, opts: { task?: string; timezone?: string; interval?: string }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);

    // Read display name from IDENTITY.md so agents self-report their user-facing name
    let displayName: string | undefined;
    const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT || process.env.CTX_PROJECT_ROOT || '';
    if (frameworkRoot) {
      const identityPaths = [
        join(frameworkRoot, 'orgs', env.org, 'agents', env.agentName, 'IDENTITY.md'),
        join(frameworkRoot, 'agents', env.agentName, 'IDENTITY.md'),
      ];
      for (const idPath of identityPaths) {
        if (existsSync(idPath)) {
          try {
            const lines = readFileSync(idPath, 'utf-8').split('\n');
            // "## Name" section takes priority (user-configured display name)
            const nameIdx = lines.findIndex(l => l.trim() === '## Name');
            if (nameIdx >= 0) {
              for (let i = nameIdx + 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line || line.startsWith('<!--')) continue;
                if (line.startsWith('#')) break;
                displayName = line;
                break;
              }
            }
            // Fallback: first non-empty, non-comment top-level heading value
            if (!displayName) {
              const h1 = lines.find(l => l.startsWith('# ') && !l.startsWith('## '));
              if (h1) displayName = h1.replace(/^#\s+/, '').trim();
            }
          } catch {
            // Skip
          }
          break;
        }
      }
    }

    updateHeartbeat(paths, env.agentName, status, {
      org: env.org,
      timezone: opts.timezone,
      loopInterval: opts.interval,
      currentTask: opts.task,
      displayName,
    });
    // Auto-emit a heartbeat event so the activity feed surfaces any live agent
    // even if the agent itself forgets to call log-event. This makes the
    // dashboard "agents" list derive from heartbeats, not just explicit events.
    try {
      logEvent(paths, env.agentName, env.org, 'heartbeat', 'heartbeat', 'info', JSON.stringify({ status, task: opts.task ?? '' }));
    } catch {
      // Non-fatal: heartbeat write already succeeded
    }
    console.log(`Heartbeat updated: ${env.agentName}`);
  });

busCommand
  .command('read-all-heartbeats')
  .description('Read heartbeat files for all agents in the system')
  .option('--format <fmt>', 'Output format: json or text', 'text')
  .action((opts: { format?: string }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const heartbeats = readAllHeartbeats(paths);

    if (opts.format === 'json') {
      console.log(JSON.stringify(heartbeats, null, 2));
      return;
    }

    if (heartbeats.length === 0) {
      console.log('No agents found.');
      return;
    }

    for (const hb of heartbeats) {
      const stale = new Date(hb.last_heartbeat) < new Date(Date.now() - 2 * 60 * 60 * 1000);
      const staleFlag = stale ? ' [STALE]' : '';
      const label = hb.display_name ? `${hb.display_name} (${hb.agent})` : hb.agent;
      console.log(`${label} (${hb.org}) — ${hb.status}${staleFlag} — last seen ${hb.last_heartbeat}`);
      if (hb.current_task) console.log(`  task: ${hb.current_task}`);
    }
  });

busCommand
  .command('recall-facts')
  .description('Recall recent session facts extracted at compaction time (cross-session memory)')
  .option('--days <n>', 'How many days back to scan', '3')
  .option('--format <fmt>', 'Output format: text or json', 'text')
  .option('--agent <name>', 'Agent name (defaults to CTX_AGENT_NAME)')
  .action((opts: { days: string; format: string; agent?: string }) => {
    const env = resolveEnv();
    const agentName = opts.agent || env.agentName;
    const daysBack = Math.max(1, Math.min(30, parseInt(opts.days, 10) || 3));
    const factsDir = join(env.ctxRoot, 'state', agentName, 'memory', 'facts');

    const entries: Array<{ ts: string; session_id: string; summary: string; keywords: string[] }> = [];

    for (let d = 0; d < daysBack; d++) {
      const date = new Date(Date.now() - d * 24 * 60 * 60 * 1000);
      const dateStr = date.toISOString().slice(0, 10);
      const factsFile = join(factsDir, `${dateStr}.jsonl`);
      if (!existsSync(factsFile)) continue;
      try {
        const lines = readFileSync(factsFile, 'utf-8').split('\n').filter(l => l.trim());
        for (const line of lines) {
          try {
            entries.push(JSON.parse(line));
          } catch { /* skip corrupt lines */ }
        }
      } catch { /* skip unreadable files */ }
    }

    if (opts.format === 'json') {
      console.log(JSON.stringify(entries, null, 2));
      return;
    }

    if (entries.length === 0) {
      console.log('No session facts found. Facts are written automatically at context compaction.');
      return;
    }

    console.log(`\n  Session Memory — last ${daysBack} day(s) — ${entries.length} entries\n`);
    for (const e of entries.slice(-10)) { // Show last 10 entries
      const ts = e.ts.replace('T', ' ').replace('Z', ' UTC').slice(0, 19);
      console.log(`  [${ts}]`);
      // Print first 400 chars of summary
      const preview = e.summary.slice(0, 400).replace(/\n/g, ' ');
      console.log(`  ${preview}${e.summary.length > 400 ? '...' : ''}`);
      if (e.keywords && e.keywords.length > 0) {
        console.log(`  Keywords: ${e.keywords.slice(0, 8).join(', ')}`);
      }
      console.log();
    }
  });

busCommand
  .command('check-stale-tasks')
  .description('Find stale tasks (in_progress >2h, pending >24h, overdue)')
  .action(() => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const report = checkStaleTasks(paths);
    console.log(JSON.stringify(report));
  });

busCommand
  .command('archive-tasks')
  .description('Archive completed tasks older than 7 days')
  .option('--dry-run', 'Show what would be archived without modifying files')
  .action((opts: { dryRun?: boolean }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const report = archiveTasks(paths, opts.dryRun ?? false);
    console.log(JSON.stringify(report));
  });

busCommand
  .command('check-human-tasks')
  .description('Find stale human-assigned tasks (>24h)')
  .action(() => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const tasks = checkHumanTasks(paths);
    console.log(JSON.stringify(tasks));
  });

busCommand
  .command('self-restart')
  .description('Immediately restart this agent via daemon IPC (same as soft-restart but targets self)')
  .option('--reason <why>', 'Reason for restart')
  .action(async (opts: { reason?: string }) => {
    const { mkdirSync, writeFileSync } = require('fs');
    const { join } = require('path');
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const reason = opts.reason || 'self-restart requested';

    // Write .user-restart marker (same as soft-restart)
    const ctxRoot = require('path').join(require('os').homedir(), '.cortextos', env.instanceId);
    const stateDir = join(ctxRoot, 'state', env.agentName);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, '.user-restart'), reason);

    // Also write to restarts.log
    selfRestart(paths, env.agentName, reason);

    // Send IPC restart-agent signal for self — makes restart immediate
    const ipc = new IPCClient(env.instanceId);
    const daemonRunning = await ipc.isDaemonRunning();
    if (daemonRunning) {
      const resp = await ipc.send({ type: 'restart-agent', agent: env.agentName, source: 'cortextos bus self-restart' });
      if (resp.success) {
        console.log(`Restarting ${env.agentName} via daemon IPC`);
      } else {
        console.error(`Daemon restart failed: ${resp.error}`);
        process.exit(1);
      }
    } else {
      console.error('ERROR: Node daemon is not running. Start it with: cortextos start');
      process.exit(1);
    }
  });

busCommand
  .command('hard-restart')
  .description('Plan a hard restart (fresh session, no --continue)')
  .option('--reason <why>', 'Reason for restart')
  .option('--handoff-doc <path>', 'Path to handoff document to inject into next session boot prompt')
  .action(async (opts: { reason?: string; handoffDoc?: string }) => {
    const { writeFileSync: fsWrite, existsSync: fsExists, mkdirSync: fsMkdir } = require('fs');
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    hardRestart(paths, env.agentName, opts.reason);
    if (opts.handoffDoc && fsExists(opts.handoffDoc)) {
      fsMkdir(paths.stateDir, { recursive: true });
      fsWrite(join(paths.stateDir, '.handoff-doc-path'), opts.handoffDoc + '\n', 'utf-8');
    }
    // Send IPC restart-agent so the daemon terminates and restarts this session
    // immediately. Without this the session keeps running — .force-fresh is only
    // consumed on the NEXT restart, which never comes unless the daemon is notified.
    const ipc = new IPCClient(env.instanceId);
    const daemonRunning = await ipc.isDaemonRunning();
    if (daemonRunning) {
      const resp = await ipc.send({ type: 'restart-agent', agent: env.agentName, source: 'cortextos bus hard-restart' });
      if (resp.success) {
        console.log(`Hard restart triggered for ${env.agentName} — fresh session incoming`);
      } else {
        console.error(`Daemon restart failed: ${resp.error}`);
        process.exit(1);
      }
    } else {
      console.log('Hard restart planned (daemon not running — will take effect on next start)');
    }
  });

busCommand
  .command('auto-commit')
  .description('Stage safe files for commit (never pushes)')
  .option('--dry-run', 'Show what would be staged without modifying git')
  .action((opts: { dryRun?: boolean }) => {
    const env = resolveEnv();
    const projectDir = env.projectRoot || env.frameworkRoot || process.cwd();
    const report = autoCommit(projectDir, opts.dryRun ?? false);
    console.log(JSON.stringify(report));
  });

busCommand
  .command('check-goal-staleness')
  .description('Detect agents with stale GOALS.md')
  .option('--threshold <days>', 'Staleness threshold in days', '7')
  .action((opts: { threshold: string }) => {
    const env = resolveEnv();
    const projectRoot = env.projectRoot || env.frameworkRoot || process.cwd();
    const report = checkGoalStaleness(projectRoot, parseInt(opts.threshold, 10));
    console.log(JSON.stringify(report, null, 2));
  });

busCommand
  .command('post-activity')
  .description('Post a message to the org Telegram activity channel')
  .argument('<message>', 'Message to post')
  .action(async (message: string) => {
    const env = resolveEnv();
    const orgDir = env.agentDir ? env.agentDir.replace(/\/agents\/.*$/, '') : '';
    const success = await postActivity(orgDir, env.ctxRoot, env.org, message);
    if (success) {
      console.log('Activity posted');
    } else {
      console.error('Failed to post activity. Check that ACTIVITY_CHAT_ID is set in your org secrets.env or .env file.');
    }
  });

busCommand
  .command('create-experiment')
  .description('Create a new experiment proposal')
  .argument('<metric>', 'Metric to measure')
  .argument('<hypothesis>', 'Hypothesis to test')
  .option('--surface <path>', 'Surface file path')
  .option('--direction <dir>', 'Direction: higher or lower', 'higher')
  .option('--window <dur>', 'Measurement window', '24h')
  .action(async (metric: string, hypothesis: string, opts: { surface?: string; direction?: string; window?: string }) => {
    const env = resolveEnv();
    const agentDir = env.agentDir || process.cwd();
    const id = createExperiment(agentDir, env.agentName, metric, hypothesis, {
      surface: opts.surface,
      direction: opts.direction as 'higher' | 'lower',
      window: opts.window,
    });
    console.log(id);

    // If approval_required is configured, auto-create an approval
    const config = loadExperimentConfig(agentDir);
    if (config.approval_required) {
      const paths = resolvePaths(env.agentName, env.instanceId, env.org);
      const approvalId = await createApproval(
        paths,
        env.agentName,
        env.org,
        `Run experiment: ${metric} — ${hypothesis.slice(0, 80)}`,
        'other',
        `Experiment ID: ${id}\nMetric: ${metric}\nHypothesis: ${hypothesis}`,
        env.frameworkRoot,
        env.agentDir,
      );
      console.log(`approval_required: ${approvalId}`);
    }
  });

busCommand
  .command('run-experiment')
  .description('Start running a proposed experiment')
  .argument('<id>', 'Experiment ID')
  .argument('[description]', 'Description of changes')
  .action((id: string, description?: string) => {
    const env = resolveEnv();
    const agentDir = env.agentDir || process.cwd();
    const experiment = runExperiment(agentDir, id, description);
    console.log(JSON.stringify(experiment, null, 2));
  });

busCommand
  .command('evaluate-experiment')
  .description('Evaluate a running experiment with a measured value')
  .argument('<id>', 'Experiment ID')
  .argument('<value>', 'Measured value')
  .option('--score <n>', 'Score 1-10')
  .option('--justification <text>', 'Justification text')
  .action((id: string, value: string, opts: { score?: string; justification?: string }) => {
    const env = resolveEnv();
    const agentDir = env.agentDir || process.cwd();
    const experiment = evaluateExperiment(agentDir, id, parseFloat(value), {
      score: opts.score ? parseInt(opts.score, 10) : undefined,
      justification: opts.justification,
    });
    console.log(JSON.stringify(experiment, null, 2));
  });

busCommand
  .command('list-experiments')
  .description('List experiments with optional filters')
  .option('--agent <name>', 'Filter by agent')
  .option('--status <s>', 'Filter by status')
  .option('--metric <m>', 'Filter by metric')
  .option('--json', 'Output as JSON')
  .action((opts: { agent?: string; status?: string; metric?: string; json?: boolean }) => {
    const env = resolveEnv();
    const agentDir = opts.agent && env.frameworkRoot
      ? join(env.frameworkRoot, 'orgs', env.org, 'agents', opts.agent)
      : (env.agentDir || process.cwd());
    const experiments = listExperiments(agentDir, {
      agent: opts.agent,
      status: opts.status,
      metric: opts.metric,
    });
    console.log(JSON.stringify(experiments, null, 2));
  });

busCommand
  .command('gather-context')
  .description('Gather experiment context for an agent')
  .option('--agent <name>', 'Agent name')
  .option('--format <fmt>', 'Output format: json or markdown', 'json')
  .action((opts: { agent?: string; format?: string }) => {
    const env = resolveEnv();
    const agentName = opts.agent || env.agentName;
    const agentDir = opts.agent && env.frameworkRoot
      ? join(env.frameworkRoot, 'orgs', env.org, 'agents', opts.agent)
      : (env.agentDir || process.cwd());
    const context = gatherContext(agentDir, agentName, { format: opts.format as 'json' | 'markdown' });
    console.log(JSON.stringify(context, null, 2));
  });

busCommand
  .command('manage-cycle')
  .description('Manage experiment cycles')
  .argument('<action>', 'Action: create, modify, remove, list')
  .argument('<agent>', 'Agent name')
  .option('--metric <name>', 'Metric name')
  .option('--metric-type <type>', 'Metric type: quantitative or qualitative')
  .option('--surface <path>', 'Surface path (file to experiment on)')
  .option('--direction <dir>', 'Direction: higher or lower')
  .option('--window <dur>', 'Measurement window (how long before evaluating)')
  .option('--measurement <method>', 'How to measure the metric')
  .option('--loop-interval <dur>', 'Cron frequency for the experiment loop')
  .option('--enabled <bool>', 'Enable or pause the cycle (true/false)')
  .option('--cycle <name>', 'Cycle name')
  .action((action: string, agent: string, opts: { metric?: string; metricType?: string; surface?: string; direction?: string; window?: string; measurement?: string; loopInterval?: string; enabled?: string; cycle?: string }) => {
    const env = resolveEnv();
    // Cycles live in the TARGET agent's experiments/config.json — the file
    // the autoresearch skill reads in that agent's session. Writing to the
    // caller's dir instead silently created a second registry the target
    // never reads.
    let agentDir: string | null = null;
    try {
      agentDir = resolveTargetAgentDir(env, agent);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
    if (!agentDir && agent === env.agentName) {
      agentDir = env.agentDir || process.cwd();
    }
    if (!agentDir) {
      console.error(`Cannot resolve agent directory for '${agent}'. Cycles are stored in the target agent's experiments/config.json — check the agent name.`);
      process.exit(1);
    }
    if (opts.direction && opts.direction !== 'higher' && opts.direction !== 'lower') {
      console.error(`Invalid --direction '${opts.direction}'. Must be 'higher' or 'lower'`);
      process.exit(1);
    }
    if (opts.metricType && opts.metricType !== 'quantitative' && opts.metricType !== 'qualitative') {
      console.error(`Invalid --metric-type '${opts.metricType}'. Must be 'quantitative' or 'qualitative'`);
      process.exit(1);
    }
    const cycles = manageCycle(agentDir, action as 'create' | 'modify' | 'remove' | 'list', {
      agent,
      name: opts.cycle,
      metric: opts.metric,
      metric_type: opts.metricType as 'quantitative' | 'qualitative' | undefined,
      surface: opts.surface,
      direction: opts.direction as 'higher' | 'lower',
      window: opts.window,
      measurement: opts.measurement,
      loop_interval: opts.loopInterval,
      enabled: opts.enabled !== undefined ? opts.enabled === 'true' : undefined,
    });
    console.log(JSON.stringify(cycles, null, 2));
  });

busCommand
  .command('browse-catalog')
  .description('Browse community catalog for items')
  .option('--type <type>', 'Filter by type (skill, agent, org)')
  .option('--tag <tag>', 'Filter by tag')
  .option('--search <query>', 'Search by name or description')
  .action((opts: { type?: string; tag?: string; search?: string }) => {
    const env = resolveEnv();
    const frameworkRoot = env.frameworkRoot || env.projectRoot || process.cwd();
    const result = browseCatalog(frameworkRoot, env.ctxRoot, {
      type: opts.type,
      tag: opts.tag,
      search: opts.search,
    });
    console.log(JSON.stringify(result, null, 2));
  });

busCommand
  .command('install-community-item')
  .description('Install a community catalog item')
  .argument('<name>', 'Item name to install')
  .option('--dry-run', 'Show what would be installed without modifying files')
  .action((name: string, opts: { dryRun?: boolean }) => {
    const env = resolveEnv();
    const frameworkRoot = env.frameworkRoot || env.projectRoot || process.cwd();
    const result = installCommunityItem(frameworkRoot, env.ctxRoot, name, {
      dryRun: opts.dryRun,
      agentDir: env.agentDir,
    });
    console.log(JSON.stringify(result, null, 2));
  });

busCommand
  .command('prepare-submission')
  .description('Prepare a skill/agent/org for community submission with PII scanning')
  .argument('<type>', 'Item type (skill, agent, org)')
  .argument('<source-path>', 'Source directory path')
  .argument('<name>', 'Item name')
  .option('--dry-run', 'Scan without keeping staged files')
  .action((type: string, sourcePath: string, name: string, opts: { dryRun?: boolean }) => {
    const env = resolveEnv();
    const piiNames = loadPiiNames(env.ctxRoot);
    const result = prepareSubmission(env.ctxRoot, type, sourcePath, name, {
      dryRun: opts.dryRun,
      // The org name was declared by prepareSubmission and passed by NOBODY, so the company-name
      // leak check never ran on any real submission — only in tests, which is how a green suite
      // concealed it. It is available right here and always was.
      ...(env.org ? { orgContext: { name: env.org } } : {}),
      // Real names from Sebastian, read from LOCAL config that never enters this repo
      // (<ctxRoot>/config/pii-names.json). No hardcoded fallback: a name written here would ship to
      // the public community catalogue on the next submission, which is exactly what this scanner
      // exists to prevent. Absent config => user_name reports as skipped, by name.
      ...(piiNames.length ? { userNames: piiNames } : {}),
    });
    console.log(JSON.stringify(result, null, 2));
  });

busCommand
  .command('submit-community-item')
  .description('Submit a prepared item to the community catalog')
  .argument('<name>', 'Item name')
  .argument('<type>', 'Item type (skill, agent, org)')
  .argument('<description>', 'Item description')
  .option('--dry-run', 'Show what would be submitted')
  .option('--author <author>', 'Author name or handle for attribution')
  .option('--contribute', 'Create branch, push to origin, and open a PR against upstream')
  .action((name: string, type: string, description: string, opts: { dryRun?: boolean; author?: string; contribute?: boolean }) => {
    const env = resolveEnv();
    const frameworkRoot = env.frameworkRoot || env.projectRoot || process.cwd();
    const result = submitCommunityItem(frameworkRoot, env.ctxRoot, name, type, description, {
      dryRun: opts.dryRun,
      author: opts.author,
      contribute: opts.contribute,
    });
    console.log(JSON.stringify(result, null, 2));
  });

busCommand
  .command('collect-metrics')
  .description('Collect and aggregate system metrics across all agents')
  .action(() => {
    const env = resolveEnv();
    const report = collectMetrics(env.ctxRoot, env.org || undefined);
    console.log(JSON.stringify(report, null, 2));
  });

busCommand
  .command('scrape-usage')
  .description('Parse Claude Code /usage output and store usage data')
  .argument('<agent>', 'Agent name')
  .argument('<output>', 'Usage output text to parse')
  .action((agent: string, output: string) => {
    const env = resolveEnv();
    const data = parseUsageOutput(output, agent);
    storeUsageData(env.ctxRoot, data);
    console.log(JSON.stringify(data, null, 2));
  });

busCommand
  .command('check-upstream')
  .description('Check canonical repo for framework updates')
  .option('--apply', 'Merge upstream changes (requires user approval)')
  .action((opts: { apply?: boolean }) => {
    const env = resolveEnv();
    const frameworkRoot = env.frameworkRoot || env.projectRoot || process.cwd();
    const result = checkUpstream(frameworkRoot, { apply: opts.apply });
    console.log(JSON.stringify(result, null, 2));
  });

busCommand
  .command('register-telegram-commands')
  .description('Register skills as Telegram bot commands')
  .argument('<bot-token>', 'Telegram bot token')
  .argument('<scan-dirs...>', 'Directories to scan for skills')
  .action(async (botToken: string, scanDirs: string[]) => {
    const commands = collectTelegramCommands(scanDirs);
    const result = await registerTelegramCommands(botToken, commands);
    console.log(JSON.stringify(result, null, 2));
  });

busCommand
  .command('send-telegram')
  .description('Send a message to a Telegram chat')
  .argument('<chat-id>', 'Telegram chat ID')
  .argument('<message>', 'Message text (supports Telegram Markdown unless --plain-text is set)')
  .option('--image <path>', 'Send a photo with caption')
  .option('--file <path>', 'Send a document/file with caption (any file type)')
  .option('--plain-text', 'Skip Telegram Markdown parsing entirely. Use this when the message contains unescaped _, *, backtick, or [ that would otherwise trip the Markdown parser. Without this flag, sendMessage still retries once with parse_mode disabled on a parse-entity error — so it is purely an opt-in to save the retry roundtrip.', false)
  .action(async (chatId: string, message: string, opts: { image?: string; file?: string; plainText?: boolean }) => {
    // Codex agents emit literal '\n'/'\t' inside single-quoted bash where bash
    // does not expand escapes, so they arrive at argv as 2-char literals and
    // Telegram renders them as visible text. Normalize before send + log.
    message = message.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    // Resolve bot token: agent .env first, then process.env
    const env = resolveEnv();
    let botToken = '';

    // 1. Check agent .env (most specific)
    if (env.agentDir) {
      const { readFileSync, existsSync } = require('fs');
      const { join } = require('path');
      const agentEnv = join(env.agentDir, '.env');
      if (existsSync(agentEnv)) {
        // stripBom: a BOM'd .env with BOT_TOKEN on line 1 breaks /^KEY=/m (2026-05-16 class)
        const content = stripBom(readFileSync(agentEnv, 'utf-8'));
        const match = content.match(/^BOT_TOKEN=(.+)$/m);
        if (match && match[1].trim()) botToken = match[1].trim();
      }
    }

    // 2. Fall back to process env
    if (!botToken) {
      botToken = process.env.BOT_TOKEN || '';
    }

    if (!botToken) {
      console.error('Error: BOT_TOKEN not configured. Set it in your agent .env file or as an environment variable to enable Telegram.');
      process.exit(1);
    }

    const api = new TelegramAPI(botToken);
    // Journal every ATTEMPT, not just the ones that work. logOutboundMessage
    // below runs only after a successful await, so outbound-messages.jsonl has
    // always been a success-only log -- which reads as evidence of health while
    // hiding every failure. See src/telegram/outbound-journal.ts.
    const deliveryId = createOutboundDeliveryId();
    const journalEnv = resolveEnv();
    const kind: 'message' | 'photo' | 'document' = opts.image ? 'photo' : opts.file ? 'document' : 'message';
    const preview = message.length > 120 ? message.slice(0, 120) + '…' : message;
    const journal = (state: 'delivering' | 'accepted' | 'retryable' | 'dead-letter', extra: { message_id?: number; error?: string } = {}) => {
      if (journalEnv.agentName && journalEnv.ctxRoot) {
        recordOutboundDelivery(journalEnv.ctxRoot, journalEnv.agentName, {
          delivery_id: deliveryId,
          agent: journalEnv.agentName,
          chat_id: String(chatId),
          state,
          attempts: 1,
          kind,
          preview,
        bytes: message.length,
        source: 'cli:send-telegram',
          ...extra,
        });
      }
    };
    journal('delivering');
    try {
      let sentMessageId = 0;
      if (opts.image) {
        const result = await api.sendPhoto(chatId, opts.image, message);
        sentMessageId = result?.result?.message_id ?? 0;
      } else if (opts.file) {
        const result = await api.sendDocument(chatId, opts.file, message);
        sentMessageId = result?.result?.message_id ?? 0;
      } else {
        const result = await api.sendMessage(chatId, message, undefined, {
          parseMode: opts.plainText ? null : 'HTML',
        });
        sentMessageId = result?.result?.message_id ?? 0;
      }
      journal('accepted', { message_id: sentMessageId });

      // Log outbound and cache last-sent for context injection
      const env = resolveEnv();
      if (env.agentName && env.ctxRoot) {
        logOutboundMessage(env.ctxRoot, env.agentName, chatId, message, sentMessageId, {
          parseMode: opts.plainText ? 'none' : 'html',
        });
        cacheLastSent(env.ctxRoot, env.agentName, chatId, message);
        // Auto-emit activity event so dashboard sees every Telegram send,
        // even from agents that never call log-event directly.
        try {
          const paths = resolvePaths(env.agentName, env.instanceId, env.org);
          const preview = message.length > 120 ? message.slice(0, 120) + '…' : message;
          logEvent(paths, env.agentName, env.org, 'message', 'telegram_sent', 'info', JSON.stringify({ chat_id: chatId, message_id: sentMessageId, preview }));
        } catch { /* non-fatal */ }
      }

      // Surface Telegram's own message_id rather than a bare "sent", so the
      // caller can tell an accepted send from a merely-completed command.
      console.log(sentMessageId ? `Message sent (telegram message_id=${sentMessageId})` : 'Message sent (no message_id returned)');
    } catch (err: any) {
      const reason = err?.message || String(err);
      journal(classifyOutboundError(reason), { error: reason });
      console.error(`Failed to send: ${reason}`);
      process.exit(1);
    }
  });

busCommand
  .command('react-telegram')
  .description("Set the bot's reaction on a Telegram message (single emoji ack)")
  .argument('<chat-id>', 'Telegram chat ID')
  .argument('<message-id>', 'ID of the message to react to')
  .argument('[emoji]', 'Reaction emoji (default: 👍). Pass an empty string to clear.', '👍')
  .action(async (chatId: string, messageIdRaw: string, emoji: string) => {
    const messageId = Number(messageIdRaw);
    if (!Number.isFinite(messageId) || messageId <= 0) {
      console.error(`Invalid message-id '${messageIdRaw}'. Must be a positive integer.`);
      process.exit(1);
    }

    // Resolve bot token: agent .env first, then process.env (same flow as
    // send-telegram so the agent identity / personality of the reaction
    // matches the agent that owns the conversation).
    const env = resolveEnv();
    let botToken = '';
    if (env.agentDir) {
      const { readFileSync, existsSync } = require('fs');
      const { join } = require('path');
      const agentEnv = join(env.agentDir, '.env');
      if (existsSync(agentEnv)) {
        // stripBom: a BOM'd .env with BOT_TOKEN on line 1 breaks /^KEY=/m (2026-05-16 class)
        const content = stripBom(readFileSync(agentEnv, 'utf-8'));
        const match = content.match(/^BOT_TOKEN=(.+)$/m);
        if (match && match[1].trim()) botToken = match[1].trim();
      }
    }
    if (!botToken) botToken = process.env.BOT_TOKEN || '';
    if (!botToken) {
      console.error('Error: BOT_TOKEN not configured. Set it in your agent .env file or as an environment variable to enable Telegram.');
      process.exit(1);
    }

    const api = new TelegramAPI(botToken);
    try {
      // Empty string clears the reaction; otherwise send a single-emoji array.
      // Telegram limits bots to one reaction per message; we treat that as the
      // primitive here. Multi-emoji is a future feature if/when needed.
      const emojis = emoji === '' ? [] : [emoji];
      await api.setMessageReaction(chatId, messageId, emojis);
      console.log(emojis.length > 0 ? `Reacted ${emoji}` : 'Reaction cleared');
    } catch (err: any) {
      console.error(`Failed to react: ${err.message || err}`);
      process.exit(1);
    }
  });

busCommand
  .command('create-approval')
  .description('Request human approval for a high-stakes action')
  .argument('<title>', 'What you are requesting approval for')
  .argument('<category>', 'Category: external-comms, financial, deployment, data-deletion, other')
  .argument('[context]', 'Additional context')
  .action(async (title: string, category: string, context?: string) => {
    const validCategories: ApprovalCategory[] = ['external-comms', 'financial', 'deployment', 'data-deletion', 'other'];
    if (!validCategories.includes(category as ApprovalCategory)) {
      console.error(`Invalid category '${category}'. Must be one of: ${validCategories.join(', ')}`);
      process.exit(1);
    }
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    // await — createApproval fan-out posts to the activity channel, which
    // must complete before the CLI process exits or the post silently
    // never sends. env.frameworkRoot is passed so the activity-channel
    // orgDir resolves to where activity-channel.env actually lives (the
    // framework repo path, NOT the runtime state path — see
    // src/bus/approval.ts:postApprovalToActivityChannel for the history).
    const id = await createApproval(paths, env.agentName, env.org, title, category as ApprovalCategory, context || '', env.frameworkRoot, env.agentDir);
    console.log(id);
  });

busCommand
  .command('update-approval')
  .description('Resolve an approval request')
  .argument('<id>', 'Approval ID')
  .argument('<status>', 'Resolution: approved or denied')
  .argument('[note]', 'Resolution note')
  .action((id: string, status: string, note?: string) => {
    const validStatuses: ApprovalStatus[] = ['approved', 'rejected'];
    if (!validStatuses.includes(status as ApprovalStatus)) {
      console.error(`Invalid status '${status}'. Must be one of: approved, rejected`);
      process.exit(1);
    }
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    updateApproval(paths, id, status as ApprovalStatus, note);
    console.log(`Approval ${id} -> ${status}`);
  });

// ---------------------------------------------------------------------------
// Knowledge Base commands
// ---------------------------------------------------------------------------

busCommand
  .command('kb-query')
  .description('Query the knowledge base (RAG search)')
  .argument('<question>', 'Question or search query')
  .option('--org <org>', 'Organization name')
  .option('--agent <name>', 'Agent name (for private scope)')
  .option('--scope <s>', 'Scope: shared, private, or all', 'all')
  .option('--top-k <n>', 'Number of results', '5')
  .option('--threshold <f>', 'Minimum similarity score (0-1) — defaults to config.json\'s similarity_threshold when unset')
  .option('--json', 'Output raw JSON')
  .action((question: string, opts: { org?: string; agent?: string; scope?: string; topK?: string; threshold?: string; json?: boolean }) => {
    const env = resolveEnv();
    const org = opts.org || env.org;
    if (!org) {
      console.error('ERROR: --org or CTX_ORG required');
      process.exit(1);
    }

    const result = queryKnowledgeBase(
      resolvePaths(env.agentName, env.instanceId, org),
      question,
      {
        org,
        agent: opts.agent || env.agentName,
        scope: (opts.scope as 'shared' | 'private' | 'all') || 'all',
        topK: parseInt(opts.topK || '5', 10),
        threshold: opts.threshold !== undefined ? parseFloat(opts.threshold) : undefined,
        frameworkRoot: env.frameworkRoot || process.cwd(),
        instanceId: env.instanceId,
      },
    );

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.results.length === 0) {
      console.log(`No results found for: "${question}"`);
      return;
    }

    console.log(`\n  Knowledge Base Results (${result.results.length}/${result.total})\n`);
    for (let i = 0; i < result.results.length; i++) {
      const r = result.results[i];
      console.log(`  [${i + 1}] Score: ${r.score.toFixed(3)} | ${r.source_file}`);
      console.log(`      ${r.content.substring(0, 200).replace(/\n/g, ' ')}...`);
      console.log('');
    }
  });

busCommand
  .command('kb-ingest')
  .description('Ingest files or directories into the knowledge base')
  .argument('<paths...>', 'Files or directories to ingest')
  .option('--org <org>', 'Organization name')
  .option('--agent <name>', 'Agent name (for private scope)')
  .option('--scope <s>', 'Scope: shared or private', 'shared')
  .option('--force', 'Re-ingest even if already indexed')
  .action((paths: string[], opts: { org?: string; agent?: string; scope?: string; force?: boolean }) => {
    const env = resolveEnv();
    const org = opts.org || env.org;
    if (!org) {
      console.error('ERROR: --org or CTX_ORG required');
      process.exit(1);
    }

    ensureKBDirs(env.instanceId, env.frameworkRoot, org);

    ingestKnowledgeBase(paths, {
      org,
      agent: opts.agent || env.agentName,
      scope: (opts.scope as 'shared' | 'private') || 'shared',
      force: opts.force,
      frameworkRoot: env.frameworkRoot || process.cwd(),
      instanceId: env.instanceId,
    });
  });

busCommand
  .command('kb-collections')
  .description('List knowledge base collections and document counts')
  .option('--org <org>', 'Organization name')
  .action((opts: { org?: string }) => {
    const env = resolveEnv();
    const org = opts.org || env.org;
    if (!org) {
      console.error('ERROR: --org or CTX_ORG required');
      process.exit(1);
    }

    const { execFileSync } = require('child_process');
    const { existsSync, readFileSync } = require('fs');
    const { join: pjoin } = require('path');
    const { homedir: hdir } = require('os');

    const frameworkRoot = env.frameworkRoot || process.cwd();
    const instanceId = env.instanceId;
    const kbRoot = pjoin(hdir(), '.cortextos', instanceId, 'orgs', org, 'knowledge-base');
    const chromaDir = pjoin(kbRoot, 'chromadb');
    const isWin = process.platform === 'win32';
    const venvBin = isWin ? 'Scripts' : 'bin';
    const pythonExe = isWin ? 'python.exe' : 'python3';
    const pythonPath = pjoin(frameworkRoot, 'knowledge-base', 'venv', venvBin, pythonExe);
    const mmragPath = pjoin(frameworkRoot, 'knowledge-base', 'scripts', 'mmrag.py');

    // Load .env and secrets.env (same as bash `source`)
    const envFiles = [
      pjoin(frameworkRoot, '.env'),
      pjoin(frameworkRoot, 'orgs', org, 'secrets.env'),
    ];
    const extraVars: Record<string, string> = {};
    for (const ef of envFiles) {
      if (existsSync(ef)) {
        for (const line of readFileSync(ef, 'utf-8').split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const idx = trimmed.indexOf('=');
          if (idx > 0) {
            let val = trimmed.slice(idx + 1);
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
              val = val.slice(1, -1);
            }
            extraVars[trimmed.slice(0, idx)] = val;
          }
        }
      }
    }

    if (!existsSync(chromaDir)) {
      console.log('No collections found. Run kb-ingest first.');
      process.exit(0);
    }

    const envVars: Record<string, string | undefined> = {
      ...process.env,
      ...extraVars,
      CTX_ORG: org,
      CTX_INSTANCE_ID: instanceId,
      CTX_FRAMEWORK_ROOT: frameworkRoot,
      MMRAG_DIR: kbRoot,
      MMRAG_CHROMADB_DIR: chromaDir,
      MMRAG_CONFIG: pjoin(kbRoot, 'config.json'),
    };
    try {
      execFileSync(pythonPath, [mmragPath, 'collections'], {
        stdio: 'inherit',
        env: envVars,
      });
    } catch {
      // python printed error already
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// Hook subcommands — cross-platform replacements for hook-*.sh bash scripts
// These are invoked by Claude Code settings.json hooks on all platforms.
// ---------------------------------------------------------------------------

function runHook(hookName: string): void {
  const hookPath = join(__dirname, `hooks/${hookName}.js`);
  const result = spawnSync(process.execPath, [hookPath], { stdio: 'inherit' });
  process.exit(result.status ?? 0);
}

// ---------------------------------------------------------------------------
// Telegram utility commands — parity with bash edit-message / answer-callback
// ---------------------------------------------------------------------------

busCommand
  .command('edit-message')
  .description('Edit an existing Telegram message text and optionally update inline keyboard')
  .argument('<chat-id>', 'Telegram chat ID')
  .argument('<message-id>', 'Message ID to edit')
  .argument('<new-text>', 'Replacement text (Telegram Markdown)')
  .argument('[reply-markup]', 'Optional JSON inline keyboard markup (pass "null" to clear)')
  .action(async (chatId: string, messageId: string, newText: string, replyMarkup?: string) => {
    const env = resolveEnv();
    let botToken = '';
    if (env.agentDir) {
      const { readFileSync, existsSync } = require('fs');
      const agentEnv = require('path').join(env.agentDir, '.env');
      if (existsSync(agentEnv)) {
        const match = stripBom(readFileSync(agentEnv, 'utf-8')).match(/^BOT_TOKEN=(.+)$/m);
        if (match?.[1]?.trim()) botToken = match[1].trim();
      }
    }
    if (!botToken) botToken = process.env.BOT_TOKEN || '';
    if (!botToken) {
      console.error('Error: BOT_TOKEN not configured. Set it in your agent .env file or as an environment variable to enable Telegram.');
      process.exit(1);
    }

    const api = new TelegramAPI(botToken);
    let markup: object | undefined;
    if (replyMarkup && replyMarkup !== 'null') {
      try { markup = JSON.parse(replyMarkup); } catch { console.error('Invalid reply-markup JSON'); process.exit(1); }
    } else {
      markup = { inline_keyboard: [] }; // clear keyboard
    }

    try {
      await api.editMessageText(parseInt(chatId, 10), parseInt(messageId, 10), newText, markup);
      console.log('Message edited');
    } catch (err: any) {
      console.error(`Failed to edit message: ${err.message || err}`);
      process.exit(1);
    }
  });

busCommand
  .command('answer-callback')
  .description('Answer a Telegram callback query to dismiss button loading state')
  .argument('<callback-query-id>', 'Callback query ID from Telegram update')
  .argument('[toast-text]', 'Optional toast notification text', 'Got it')
  .action(async (callbackQueryId: string, toastText: string) => {
    const env = resolveEnv();
    let botToken = '';
    if (env.agentDir) {
      const { readFileSync, existsSync } = require('fs');
      const agentEnv = require('path').join(env.agentDir, '.env');
      if (existsSync(agentEnv)) {
        const match = stripBom(readFileSync(agentEnv, 'utf-8')).match(/^BOT_TOKEN=(.+)$/m);
        if (match?.[1]?.trim()) botToken = match[1].trim();
      }
    }
    if (!botToken) botToken = process.env.BOT_TOKEN || '';
    if (!botToken) {
      console.error('Error: BOT_TOKEN not configured. Set it in your agent .env file or as an environment variable to enable Telegram.');
      process.exit(1);
    }

    const api = new TelegramAPI(botToken);
    try {
      await api.answerCallbackQuery(callbackQueryId, toastText);
      console.log('Callback answered');
    } catch (err: any) {
      console.error(`Failed to answer callback: ${err.message || err}`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// Agent discovery and skill discovery
// ---------------------------------------------------------------------------

busCommand
  .command('list-agents')
  .description('Discover all agents in the system with their status and roles')
  .option('--org <org>', 'Filter by organization')
  .option('--status <filter>', 'Filter by status: running|all', 'all')
  .option('--format <fmt>', 'Output format: json|text', 'json')
  .action(async (opts: { org?: string; status?: string; format?: string }) => {
    const { existsSync, readdirSync, readFileSync } = require('fs');
    const { join } = require('path');
    const env = resolveEnv();
    const ctxRoot = require('path').join(require('os').homedir(), '.cortextos', env.instanceId);
    const frameworkRoot = env.frameworkRoot || process.cwd();

    // Collect agents from enabled-agents.json + filesystem scan
    const enabledFile = join(ctxRoot, 'config', 'enabled-agents.json');
    const agentMap: Record<string, { org: string; enabled: boolean }> = {};

    if (existsSync(enabledFile)) {
      try {
        const data = JSON.parse(readFileSync(enabledFile, 'utf-8'));
        for (const [name, cfg] of Object.entries(data as Record<string, any>)) {
          agentMap[name] = { org: cfg.org ?? '', enabled: cfg.enabled !== false };
        }
      } catch { /* skip corrupt */ }
    }

    // Also scan org agent directories
    const orgsDir = join(frameworkRoot, 'orgs');
    if (existsSync(orgsDir)) {
      for (const org of readdirSync(orgsDir)) {
        const agentsDir = join(orgsDir, org, 'agents');
        if (!existsSync(agentsDir)) continue;
        for (const name of readdirSync(agentsDir)) {
          if (!agentMap[name]) agentMap[name] = { org, enabled: true };
        }
      }
    }

    // Determine running agents via IPC daemon.
    const runningAgents = new Set<string>();
    const ipc = new IPCClient(env.instanceId);
    try {
      const resp = await ipc.send({ type: 'status', source: 'cortextos bus' });
      if (resp.success && Array.isArray(resp.data)) {
        for (const a of resp.data as Array<{ name: string; status: string }>) {
          if (a.status === 'running') runningAgents.add(a.name);
        }
      }
    } catch {
      // Daemon not running — no running agent data available
    }

    const results = [];
    for (const [name, info] of Object.entries(agentMap)) {
      if (opts.org && info.org !== opts.org) continue;

      const running = runningAgents.has(name);
      if (opts.status === 'running' && !running) continue;

      // Read role from IDENTITY.md
      let role = '';
      const agentDir = info.org
        ? join(frameworkRoot, 'orgs', info.org, 'agents', name)
        : join(frameworkRoot, 'agents', name);
      const identityFile = join(agentDir, 'IDENTITY.md');
      if (existsSync(identityFile)) {
        const content = readFileSync(identityFile, 'utf-8');
        const m = content.match(/^## Role\s*\n(.+)/m);
        if (m) role = m[1].trim();
      }

      // Read heartbeat
      const hbFile = join(ctxRoot, 'state', name, 'heartbeat.json');
      let lastHeartbeat = '', currentTask = '', mode = '';
      if (existsSync(hbFile)) {
        try {
          const hb = JSON.parse(readFileSync(hbFile, 'utf-8'));
          lastHeartbeat = hb.last_heartbeat ?? '';
          currentTask = hb.current_task ?? '';
          mode = hb.mode ?? '';
        } catch { /* skip */ }
      }

      results.push({ name, org: info.org, role, enabled: info.enabled, running, last_heartbeat: lastHeartbeat, current_task: currentTask, mode });
    }

    if (opts.format === 'text') {
      console.log(`Agents in system:\n`);
      for (const a of results) {
        const status = a.running ? 'RUNNING' : 'stopped';
        console.log(`  ${a.name} (${a.org || 'root'}) [${status}]`);
        if (a.role) console.log(`    Role: ${a.role}`);
        if (a.current_task) console.log(`    Working on: ${a.current_task}`);
        console.log('');
      }
      console.log(`Total: ${results.length} agents`);
    } else {
      console.log(JSON.stringify(results, null, 2));
    }
  });

busCommand
  .command('list-skills')
  .description('Discover available skills for the current agent')
  .option('--format <fmt>', 'Output format: json|text', 'json')
  .action((opts: { format?: string }) => {
    const { existsSync, readdirSync, readFileSync } = require('fs');
    const { join } = require('path');
    const env = resolveEnv();
    const frameworkRoot = env.frameworkRoot || process.cwd();
    const agentDir = env.agentDir || process.cwd();

    // Read template from config.json
    let template = '';
    const configFile = join(agentDir, 'config.json');
    if (existsSync(configFile)) {
      try { template = JSON.parse(readFileSync(configFile, 'utf-8')).template ?? ''; } catch { /* skip */ }
    }

    // Parse YAML frontmatter from SKILL.md
    function parseSkillFrontmatter(filePath: string): { name: string; description: string } | null {
      try {
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        let inFrontmatter = false;
        let name = '', description = '';
        for (const line of lines) {
          if (line.trim() === '---') {
            if (inFrontmatter) break;
            inFrontmatter = true;
            continue;
          }
          if (!inFrontmatter) continue;
          const nm = line.match(/^name:\s*['"]?(.+?)['"]?\s*$/);
          if (nm) name = nm[1];
          const dm = line.match(/^description:\s*['"]?(.+?)['"]?\s*$/);
          if (dm) description = dm[1];
        }
        return name ? { name, description } : null;
      } catch { return null; }
    }

    type SkillInfo = { name: string; description: string; path: string; source: string };

    // Scan a skills directory, returns map of name -> skill info
    function scanSkillsDir(dir: string, source: string): Map<string, SkillInfo> {
      const map = new Map<string, SkillInfo>();
      if (!existsSync(dir)) return map;
      for (const entry of readdirSync(dir)) {
        const skillFile = join(dir, entry, 'SKILL.md');
        if (!existsSync(skillFile)) continue;
        const parsed = parseSkillFrontmatter(skillFile);
        if (parsed) map.set(parsed.name, { ...parsed, path: skillFile, source });
      }
      return map;
    }

    // Merge in priority order: framework < template < agent (agent wins)
    const merged = new Map<string, SkillInfo>();
    for (const [k, v] of scanSkillsDir(join(frameworkRoot, '.claude', 'skills'), 'framework')) merged.set(k, v);
    if (template) {
      for (const [k, v] of scanSkillsDir(join(frameworkRoot, 'templates', template, '.claude', 'skills'), `template:${template}`)) merged.set(k, v);
    }
    for (const [k, v] of scanSkillsDir(join(agentDir, '.claude', 'skills'), 'agent')) merged.set(k, v);

    const skills = Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));

    if (opts.format === 'text') {
      console.log(`Available skills for ${env.agentName}:\n`);
      for (const s of skills) {
        console.log(`  ${s.name} (${s.source})`);
        if (s.description) console.log(`    ${s.description}`);
        console.log('');
      }
      console.log(`Total: ${skills.length} skills`);
    } else {
      console.log(JSON.stringify(skills, null, 2));
    }
  });

// ---------------------------------------------------------------------------
// Agent coordination: notify-agent, soft-restart, send-mobile-reply
// ---------------------------------------------------------------------------

busCommand
  .command('notify-agent')
  .description('Send urgent signal to another agent for immediate delivery via fast-checker')
  .argument('<agent>', 'Target agent name')
  .argument('<message>', 'Urgent message text')
  .action((targetAgent: string, message: string) => {
    const { mkdirSync, writeFileSync } = require('fs');
    const { join } = require('path');
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const ctxRoot = require('path').join(require('os').homedir(), '.cortextos', env.instanceId);

    // Write urgent signal file that fast-checker checks on every poll
    const signalDir = join(ctxRoot, 'state', targetAgent);
    mkdirSync(signalDir, { recursive: true });
    const signal = {
      from: env.agentName,
      message,
      timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };
    writeFileSync(join(signalDir, '.urgent-signal'), JSON.stringify(signal));

    // Also send via normal message bus for persistence
    try {
      sendMessage(paths, env.agentName, targetAgent, 'urgent', message);
    } catch { /* signal already written */ }

    console.log(`Signal sent to ${targetAgent}`);
  });

busCommand
  .command('soft-restart')
  .description('Gracefully restart another agent by writing the restart marker then sending /exit')
  .argument('<agent>', 'Target agent name to restart')
  .argument('[reason]', 'Reason for restart', 'user request via soft-restart')
  .action(async (targetAgent: string, reason: string) => {
    const { mkdirSync, writeFileSync } = require('fs');
    const { join } = require('path');
    const env = resolveEnv();
    const ctxRoot = require('path').join(require('os').homedir(), '.cortextos', env.instanceId);

    // Step 1: Write .user-restart marker BEFORE triggering exit
    const stateDir = join(ctxRoot, 'state', targetAgent);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, '.user-restart'), reason);
    console.log(`Wrote .user-restart marker for ${targetAgent}: ${reason}`);

    // Step 2: Send restart via IPC daemon (cross-platform — named pipe on Windows, socket on Unix).
    const ipc = new IPCClient(env.instanceId);
    const daemonRunning = await ipc.isDaemonRunning();

    if (daemonRunning) {
      const resp = await ipc.send({ type: 'restart-agent', agent: targetAgent, source: 'cortextos bus soft-restart' });
      if (resp.success) {
        console.log(`Restarted ${targetAgent} via daemon IPC`);
      } else {
        console.error(`Daemon restart failed: ${resp.error}`);
        process.exit(1);
      }
    } else {
      console.error('ERROR: Node daemon is not running. Start it with: cortextos start');
      process.exit(1);
    }
  });

busCommand
  .command('soft-restart-all')
  .description('Soft-restart all enabled agents in the org with optional stagger delay')
  .option('--stagger <seconds>', 'Seconds between each agent restart', '5')
  .option('--reason <why>', 'Reason for restart', 'soft-restart-all requested')
  .action(async (opts: { stagger: string; reason: string }) => {
    const { mkdirSync, writeFileSync, readFileSync, existsSync } = require('fs');
    const { join } = require('path');
    const env = resolveEnv();
    const ctxRoot = require('path').join(require('os').homedir(), '.cortextos', env.instanceId);
    const staggerMs = parseInt(opts.stagger, 10) * 1000;

    // Read enabled agents from config
    const enabledFile = join(ctxRoot, 'config', 'enabled-agents.json');
    if (!existsSync(enabledFile)) {
      console.error('ERROR: enabled-agents.json not found at', enabledFile);
      process.exit(1);
    }
    const enabledAgents: Record<string, { enabled: boolean; org?: string }> =
      JSON.parse(readFileSync(enabledFile, 'utf-8'));

    // Filter to enabled agents in this org (if org set)
    const targets = Object.entries(enabledAgents)
      .filter(([, cfg]) => cfg.enabled !== false)
      .filter(([, cfg]) => !env.org || !cfg.org || cfg.org === env.org)
      .map(([name]) => name);

    if (targets.length === 0) {
      console.log('No enabled agents found for org:', env.org || '(all)');
      process.exit(0);
    }

    const ipc = new IPCClient(env.instanceId);
    const daemonRunning = await ipc.isDaemonRunning();
    if (!daemonRunning) {
      console.error('ERROR: Node daemon is not running. Start it with: cortextos start');
      process.exit(1);
    }

    console.log(`Restarting ${targets.length} agent(s) with ${opts.stagger}s stagger: ${targets.join(', ')}`);

    for (let i = 0; i < targets.length; i++) {
      const agent = targets[i];
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, staggerMs));
      }
      // Write .user-restart marker
      const stateDir = join(ctxRoot, 'state', agent);
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, '.user-restart'), opts.reason);

      // Send IPC restart signal
      const resp = await ipc.send({ type: 'restart-agent', agent, source: 'cortextos bus soft-restart-all' });
      if (resp.success) {
        console.log(`[${i + 1}/${targets.length}] Restarted ${agent}`);
      } else {
        console.error(`[${i + 1}/${targets.length}] Failed to restart ${agent}: ${resp.error}`);
      }
    }

    console.log('soft-restart-all complete.');
  });

busCommand
  .command('send-mobile-reply')
  .description('Reply to a mobile app user message and ACK the inbox message')
  .argument('<agent>', 'Agent name sending the reply')
  .argument('<reply>', 'Reply text')
  .argument('[msg-id]', 'Inbox message ID to ACK')
  .action((agent: string, reply: string, msgId?: string) => {
    // Same literal '\n'/'\t' normalize as send-telegram (codex agent fix).
    reply = reply.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    const { mkdirSync, appendFileSync } = require('fs');
    const { join } = require('path');
    const env = resolveEnv();
    const ctxRoot = require('path').join(require('os').homedir(), '.cortextos', env.instanceId);

    // Write to outbound-messages.jsonl so iOS app chat history picks it up
    const logDir = join(ctxRoot, 'logs', agent);
    mkdirSync(logDir, { recursive: true });
    const entry = JSON.stringify({
      timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      agent,
      text: reply,
      message_id: `mobile-reply-${Date.now()}`,
      type: 'text',
    });
    appendFileSync(join(logDir, 'outbound-messages.jsonl'), entry + '\n');

    // ACK the original inbox message
    if (msgId) {
      const paths = resolvePaths(agent, env.instanceId, env.org);
      try { ackInbox(paths, msgId); } catch { /* best effort */ }
    }

    console.log('Replied to mobile user');
  });

// ---------------------------------------------------------------------------
// list-approvals — was missing from CLI, only available via dashboard
// ---------------------------------------------------------------------------

busCommand
  .command('list-approvals')
  .description('List pending approval requests')
  .option('--format <fmt>', 'Output format: json|text', 'json')
  .option('--all-orgs', 'Scan all orgs under CTX_ROOT (matches dashboard view)', false)
  .action((opts: { format?: string; allOrgs?: boolean }) => {
    const { listPendingApprovals } = require('../bus/approval.js');
    const { readdirSync, existsSync } = require('fs');
    const { join, homedir: _homedir } = require('path');
    const { homedir } = require('os');
    const env = resolveEnv();

    let approvals: unknown[] = [];

    if (opts.allOrgs) {
      // Scan every org directory under CTX_ROOT — mirrors dashboard syncAll() behaviour
      const ctxRoot = join(homedir(), '.cortextos', env.instanceId);
      const orgsDir = join(ctxRoot, 'orgs');
      const orgs: string[] = existsSync(orgsDir)
        ? readdirSync(orgsDir, { withFileTypes: true })
            .filter((d: { isDirectory(): boolean }) => d.isDirectory())
            .map((d: { name: string }) => d.name)
        : [];
      for (const org of orgs) {
        const orgPaths = resolvePaths(env.agentName, env.instanceId, org);
        approvals = approvals.concat(listPendingApprovals(orgPaths));
      }
    } else {
      const paths = resolvePaths(env.agentName, env.instanceId, env.org);
      approvals = listPendingApprovals(paths);
    }

    if (opts.format === 'text') {
      if (approvals.length === 0) { console.log('No pending approvals'); return; }
      for (const a of approvals as Array<{ id: string; title: string; category: string; requesting_agent: string; created_at: string; description?: string; org?: string }>) {
        console.log(`[${a.id}] ${a.title}`);
        console.log(`  Category: ${a.category} | Agent: ${a.requesting_agent} | Org: ${a.org ?? env.org} | Created: ${a.created_at}`);
        if (a.description) console.log(`  Context: ${a.description}`);
        console.log('');
      }
      console.log(`Total: ${approvals.length} pending`);
    } else {
      console.log(JSON.stringify(approvals, null, 2));
    }
  });

// ---------------------------------------------------------------------------
// Reminder commands — persistent cron state that survives hard-restarts (#69)
// ---------------------------------------------------------------------------

busCommand
  .command('create-reminder')
  .argument('<fire-at>', 'When to fire, ISO 8601 UTC (e.g. 2026-04-05T08:00:00Z)')
  .argument('<prompt>', 'Text to inject into boot prompt when overdue')
  .description('Create a persistent reminder that survives hard-restarts')
  .action((fireAt: string, prompt: string) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const reminder = createReminder(paths, fireAt, prompt);
    console.log(reminder.id);
  });

busCommand
  .command('list-reminders')
  .option('--all', 'Include acked reminders', false)
  .option('--format <fmt>', 'Output format: json or text', 'text')
  .description('List pending (or all) reminders')
  .action((opts: { all?: boolean; format?: string }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const reminders = listReminders(paths, { all: opts.all });

    if (opts.format === 'json') {
      console.log(JSON.stringify(reminders, null, 2));
      return;
    }

    if (reminders.length === 0) {
      console.log('No pending reminders');
      return;
    }

    const now = Date.now();
    for (const r of reminders) {
      const overdue = Date.parse(r.fire_at) <= now;
      const overdueTag = overdue ? ' [OVERDUE]' : '';
      console.log(`[${r.id}]${overdueTag}`);
      console.log(`  fire_at: ${r.fire_at}  status: ${r.status}`);
      console.log(`  prompt:  ${r.prompt}`);
      console.log('');
    }
  });

busCommand
  .command('ack-reminder')
  .argument('<id>', 'Reminder ID to acknowledge')
  .description('Mark a reminder as handled')
  .action((id: string) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    ackReminder(paths, id);
    console.log(`ACK'd reminder ${id}`);
  });

busCommand
  .command('prune-reminders')
  .option('--days <n>', 'Retain acked reminders for N days', '7')
  .description('Delete acked reminders older than N days')
  .action((opts: { days?: string }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const pruned = pruneReminders(paths, parseInt(opts.days ?? '7', 10));
    console.log(`Pruned ${pruned} acked reminder(s)`);
  });

busCommand
  .command('update-cron-fire')
  .argument('<cron-name>', 'Name of the cron as defined in config.json')
  .option('--interval <interval>', 'Expected interval, e.g. "6h", "24h", "30m"')
  .description('Record that a named cron just fired (enables daemon gap detection for dead zones)')
  .action((cronName: string, opts: { interval?: string }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    updateCronFire(paths.stateDir, cronName, opts.interval);
    console.log(`Recorded fire for cron "${cronName}"`);
  });

// ---------------------------------------------------------------------------
// External Persistent Cron Management (Subtask 1.4)
// ---------------------------------------------------------------------------

/**
 * Validate a schedule string — either an interval shorthand ("6h", "30m") or
 * a 5-field cron expression ("0 8 * * *").  Returns the normalised schedule
 * string, or throws an Error with a human-readable message on failure.
 */
function validateSchedule(raw: string): string {
  const trimmed = raw.trim();
  // Detect format by counting whitespace-separated tokens
  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 1) {
    // Interval shorthand: must match parseDurationMs
    if (isNaN(parseDurationMs(trimmed))) {
      throw new Error(
        `Invalid interval '${trimmed}'. Expected formats: "6h", "30m", "1d", "2w".`
      );
    }
    return trimmed;
  }
  if (tokens.length === 5) {
    // 5-field cron expression: validate by computing a next fire time
    const probe = nextFireFromCron(trimmed, Date.now());
    if (isNaN(probe)) {
      throw new Error(
        `Invalid cron expression '${trimmed}'. Expected 5-field cron ("0 8 * * *", "*/30 * * * *", etc.).`
      );
    }
    return trimmed;
  }
  throw new Error(
    `Invalid schedule '${trimmed}'. Use an interval ("6h") or a 5-field cron expression ("0 8 * * *").`
  );
}

/**
 * Check whether an agent exists in the current framework root.
 * Returns false if the framework root is unknown (graceful degradation).
 */
function agentExistsInFramework(agentName: string, frameworkRoot: string): boolean {
  if (!frameworkRoot) return true; // can't check — allow
  const { existsSync: fsExists, readdirSync: fsReaddir } = require('fs');
  const { join: pjoin } = require('path');
  const orgsDir = pjoin(frameworkRoot, 'orgs');
  if (!fsExists(orgsDir)) return true; // no orgs dir — allow
  try {
    for (const org of fsReaddir(orgsDir)) {
      if (fsExists(pjoin(orgsDir, org, 'agents', agentName))) return true;
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * Format an ISO timestamp for display (shortens to "YYYY-MM-DD HH:mm UTC").
 */
function fmtTs(iso: string | undefined): string {
  if (!iso) return '-';
  return iso.replace('T', ' ').slice(0, 16) + ' UTC';
}

/**
 * Send a reload-crons IPC signal to the daemon (non-blocking, best-effort).
 * Silently swallows errors — the daemon will pick up changes on its next tick.
 */
async function signalCronReload(agentName: string, instanceId: string): Promise<void> {
  try {
    const ipc = new IPCClient(instanceId);
    await ipc.send({ type: 'reload-crons', agent: agentName, source: 'cortextos bus cron-cmd' });
  } catch { /* non-fatal — scheduler picks up file change on next 30s tick */ }
}

busCommand
  .command('add-cron')
  .description('Add a new persistent cron for an agent')
  .argument('<agent>', 'Agent name')
  .argument('<name>', 'Cron name (unique per agent, slug format recommended)')
  .argument('<interval>', 'Schedule: interval ("6h", "30m", "1d") or 5-field cron expr ("0 8 * * *")')
  .argument('<prompt...>', 'Prompt text injected when the cron fires (all remaining words joined)')
  .option('--desc <description>', 'Human-readable description (optional)')
  .action(async (agent: string, name: string, interval: string, promptWords: string[], opts: { desc?: string }) => {
    // Validate agent name format
    try { validateAgentName(agent); } catch (err) { console.error(String(err)); process.exit(1); }

    const env = resolveEnv();

    // Validate agent exists in framework
    if (!agentExistsInFramework(agent, env.frameworkRoot)) {
      console.error(`Error: agent '${agent}' not found in framework. Check orgs/*/agents/ directory.`);
      process.exit(1);
    }

    // Validate schedule
    let schedule: string;
    try { schedule = validateSchedule(interval); } catch (err) { console.error(String(err)); process.exit(1); }

    const prompt = promptWords.join(' ');
    const cron: CronDefinition = {
      name,
      prompt,
      schedule,
      enabled: true,
      created_at: new Date().toISOString(),
      ...(opts.desc ? { description: opts.desc } : {}),
    };

    try {
      addCron(agent, cron);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    await signalCronReload(agent, env.instanceId);
    console.log(`Added cron '${name}' for ${agent}`);
  });

busCommand
  .command('remove-cron')
  .description('Remove a persistent cron from an agent')
  .argument('<agent>', 'Agent name')
  .argument('<name>', 'Cron name to remove')
  .action(async (agent: string, name: string) => {
    try { validateAgentName(agent); } catch (err) { console.error(String(err)); process.exit(1); }

    const removed = removeCron(agent, name);
    if (!removed) {
      console.error(`Error: cron '${name}' not found for agent '${agent}'.`);
      process.exit(1);
    }

    const env = resolveEnv();
    await signalCronReload(agent, env.instanceId);
    console.log(`Removed cron '${name}' from ${agent}`);
  });

busCommand
  .command('list-crons')
  .description('List all persistent crons configured for an agent')
  .argument('<agent>', 'Agent name')
  .option('--json', 'Emit raw JSON instead of a formatted table')
  .action((agent: string, opts: { json?: boolean }) => {
    try { validateAgentName(agent); } catch (err) { console.error(String(err)); process.exit(1); }

    const crons = readCrons(agent);

    // BUG 1 fix: merge cron-state.json's `last_fire` records into the displayed
    // last-fire timestamp. The daemon writes fire timestamps to two surfaces:
    //   - crons.json `last_fired_at` (via cron-scheduler.updateCron)
    //   - cron-state.json `last_fire` (via bus update-cron-fire from agent skills)
    // For a single source of truth in the CLI, take the most recent of the two.
    const env = resolveEnv();
    const paths = resolvePaths(agent, env.instanceId, env.org);
    const stateRecords = readCronState(paths.stateDir).crons;
    const fireByName = new Map<string, string>();
    for (const rec of stateRecords) fireByName.set(rec.name, rec.last_fire);

    const mostRecent = (a?: string, b?: string): string | undefined => {
      if (!a) return b;
      if (!b) return a;
      return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
    };

    if (opts.json) {
      const enriched = crons.map(c => ({
        ...c,
        last_fired_at: mostRecent(c.last_fired_at, fireByName.get(c.name)),
      }));
      console.log(JSON.stringify(enriched, null, 2));
      return;
    }

    if (crons.length === 0) {
      console.log(`No crons configured for ${agent}`);
      return;
    }

    // Compute next_fire_at for each cron so the table is informative
    const now = Date.now();
    const rows = crons.map(c => {
      const lastFire = mostRecent(c.last_fired_at, fireByName.get(c.name));
      let nextFire = '-';
      const dms = parseDurationMs(c.schedule);
      if (!isNaN(dms)) {
        const refMs = lastFire ? new Date(lastFire).getTime() : now;
        nextFire = fmtTs(new Date(refMs + dms).toISOString());
      } else {
        const nf = nextFireFromCron(c.schedule, now);
        if (!isNaN(nf)) nextFire = fmtTs(new Date(nf).toISOString());
      }
      const promptPreview = c.prompt.length > 60 ? c.prompt.slice(0, 57) + '...' : c.prompt;
      return {
        name: c.name,
        schedule: c.schedule,
        enabled: c.enabled ? 'yes' : 'no',
        last_fire: fmtTs(lastFire),
        next_fire: nextFire,
        prompt: promptPreview,
      };
    });

    // Column widths
    const nameW = Math.max(4, ...rows.map(r => r.name.length));
    const schedW = Math.max(8, ...rows.map(r => r.schedule.length));
    const enW = 7;
    const lastW = 18;
    const nextW = 18;

    const pad = (s: string, w: number) => s.padEnd(w);
    const sep = '-'.repeat(nameW + schedW + enW + lastW + nextW + 63 + 5);

    console.log(`\nCrons for ${agent} (${rows.length})\n`);
    console.log(`  ${pad('Name', nameW)}  ${pad('Schedule', schedW)}  ${pad('Enabled', enW)}  ${pad('Last Fire', lastW)}  ${pad('Next Fire', nextW)}  Prompt`);
    console.log(`  ${sep}`);
    for (const r of rows) {
      console.log(`  ${pad(r.name, nameW)}  ${pad(r.schedule, schedW)}  ${pad(r.enabled, enW)}  ${pad(r.last_fire, lastW)}  ${pad(r.next_fire, nextW)}  ${r.prompt}`);
    }
    console.log('');
  });

busCommand
  .command('update-cron')
  .description('Update fields of an existing persistent cron')
  .argument('<agent>', 'Agent name')
  .argument('<name>', 'Cron name to update')
  .option('--interval <i>', 'New schedule (interval or cron expression)')
  .option('--cron-expr <e>', 'Alias for --interval (5-field cron expression)')
  .option('--prompt <p>', 'New prompt text')
  .option('--enabled <bool>', 'Enable (true) or disable (false) the cron')
  .option('--desc <d>', 'New description')
  .action(async (agent: string, name: string, opts: { interval?: string; cronExpr?: string; prompt?: string; enabled?: string; desc?: string }) => {
    try { validateAgentName(agent); } catch (err) { console.error(String(err)); process.exit(1); }

    const rawSchedule = opts.interval ?? opts.cronExpr;
    if (!rawSchedule && opts.prompt === undefined && opts.enabled === undefined && opts.desc === undefined) {
      console.error('Error: at least one of --interval, --cron-expr, --prompt, --enabled, or --desc is required.');
      process.exit(1);
    }

    const patch: Partial<CronDefinition> = {};

    if (rawSchedule !== undefined) {
      try { patch.schedule = validateSchedule(rawSchedule); } catch (err) { console.error(String(err)); process.exit(1); }
    }
    if (opts.prompt !== undefined) {
      patch.prompt = opts.prompt;
    }
    if (opts.enabled !== undefined) {
      if (opts.enabled !== 'true' && opts.enabled !== 'false') {
        console.error(`Error: --enabled must be 'true' or 'false', got '${opts.enabled}'.`);
        process.exit(1);
      }
      patch.enabled = opts.enabled === 'true';
    }
    if (opts.desc !== undefined) {
      patch.description = opts.desc;
    }

    const ok = updateCronDef(agent, name, patch);
    if (!ok) {
      console.error(`Error: cron '${name}' not found for agent '${agent}'.`);
      process.exit(1);
    }

    const env = resolveEnv();
    await signalCronReload(agent, env.instanceId);
    console.log(`Updated cron '${name}' for ${agent}`);
  });

busCommand
  .command('test-cron-fire')
  .description('Fire a cron immediately for testing (injects prompt into agent PTY via daemon IPC)')
  .argument('<agent>', 'Agent name')
  .argument('<name>', 'Cron name to fire')
  .action(async (agent: string, name: string) => {
    try { validateAgentName(agent); } catch (err) { console.error(String(err)); process.exit(1); }

    const cron = getCronByName(agent, name);
    if (!cron) {
      console.error(`Error: cron '${name}' not found for agent '${agent}'.`);
      process.exit(1);
    }

    const env = resolveEnv();
    const ipc = new IPCClient(env.instanceId);

    const daemonRunning = await ipc.isDaemonRunning();
    if (!daemonRunning) {
      console.error('Error: daemon is not running. Start it with: cortextos start');
      process.exit(1);
    }

    const resp = await ipc.send({
      type: 'fire-cron',
      agent,
      data: { name: cron.name, prompt: cron.prompt },
      source: 'cortextos bus test-cron-fire',
    });

    if (!resp.success) {
      console.error(`Error: ${resp.error}`);
      process.exit(1);
    }

    console.log(`Fired cron '${name}' for ${agent}`);
  });

busCommand
  .command('get-cron-log')
  .description('Display cron execution log entries for an agent')
  .argument('<agent>', 'Agent name')
  .argument('[name]', 'Cron name to filter by (optional — omit to show all crons)')
  .option('--limit <n>', 'Maximum number of entries to show (default: 50)', '50')
  .option('--json', 'Emit raw JSON array instead of a formatted table')
  .action((agent: string, name: string | undefined, opts: { limit?: string; json?: boolean }) => {
    try { validateAgentName(agent); } catch (err) { console.error(String(err)); process.exit(1); }

    const limit = parseInt(opts.limit ?? '50', 10);
    if (isNaN(limit) || limit < 0) {
      console.error(`Error: --limit must be a non-negative integer, got '${opts.limit}'.`);
      process.exit(1);
    }

    const entries = getExecutionLog(agent, name, limit);

    if (opts.json) {
      console.log(JSON.stringify(entries, null, 2));
      return;
    }

    if (entries.length === 0) {
      if (name !== undefined) {
        console.log(`No log entries for cron '${name}' on ${agent}`);
      } else {
        console.log(`No log entries for ${agent}`);
      }
      return;
    }

    // Human-readable table: ts | cron | status | attempt | duration | error
    const pad = (s: string, w: number) => s.padEnd(w);
    const header = `  ${pad('Timestamp', 20)}  ${pad('Cron', 22)}  ${pad('Status', 7)}  ${pad('Att', 3)}  ${pad('ms', 7)}  Error`;
    const sep = '-'.repeat(header.length);

    console.log(`\nExecution log for ${agent}${name ? ` / ${name}` : ''} (${entries.length} entries)\n`);
    console.log(header);
    console.log(`  ${sep}`);

    for (const e of entries) {
      const ts = e.ts.replace('T', ' ').slice(0, 19) + 'Z';
      const status = e.status;
      const att = String(e.attempt);
      const ms = String(e.duration_ms);
      const error = e.error ?? '';
      const cronPad = pad(e.cron.length > 22 ? e.cron.slice(0, 19) + '...' : e.cron, 22);
      console.log(
        `  ${pad(ts, 20)}  ${cronPad}  ${pad(status, 7)}  ${pad(att, 3)}  ${pad(ms, 7)}  ${error}`
      );
    }
    console.log('');
  });

// ---------------------------------------------------------------------------
// migrate-crons — Subtask 2.2: Manual one-shot migration command
// ---------------------------------------------------------------------------

busCommand
  .command('migrate-crons')
  .description('Migrate crons from config.json to crons.json for one or all agents')
  .argument('[agent]', 'Agent name to migrate (omit to migrate all enabled agents)')
  .option('--force', 'Re-run migration even if the marker file already exists')
  .action(async (agentArg: string | undefined, opts: { force?: boolean }) => {
    const { migrateCronsForAgent: migrateSingle, migrateAllAgents: migrateAll } = await import('../daemon/cron-migration.js');
    const env = resolveEnv();
    const ctxRoot = env.ctxRoot;
    const frameworkRoot = env.frameworkRoot || process.cwd();

    const log = (msg: string) => console.log(msg);
    const migOpts = { force: opts.force ?? false, log };

    if (agentArg) {
      // Single-agent migration
      try { validateAgentName(agentArg); } catch (err) { console.error(String(err)); process.exit(1); }

      // Resolve config.json path via filesystem scan
      const { existsSync: fsExists, readdirSync: fsReaddir } = require('fs') as typeof import('fs');
      const orgsDir = join(frameworkRoot, 'orgs');
      let configPath: string | undefined;
      if (fsExists(orgsDir)) {
        try {
          for (const org of fsReaddir(orgsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)) {
            const candidate = join(orgsDir, org, 'agents', agentArg, 'config.json');
            if (fsExists(candidate)) { configPath = candidate; break; }
          }
        } catch { /* ignore scan errors */ }
      }

      if (!configPath) {
        console.error(`Error: agent '${agentArg}' not found in framework. Check orgs/*/agents/ directory.`);
        process.exit(1);
      }

      const result = migrateSingle(agentArg, configPath, ctxRoot, migOpts);

      switch (result.status) {
        case 'skipped-already-migrated':
          console.log(`Skipped ${agentArg}: already migrated (use --force to re-run)`);
          break;
        case 'no-config':
          console.log(`Skipped ${agentArg}: no config.json found`);
          break;
        case 'no-crons':
          console.log(`Skipped ${agentArg}: config.json has no crons — empty crons.json written`);
          break;
        case 'migrated':
          console.log(
            `Migrated ${agentArg}: ${result.cronsMigrated} cron(s) migrated` +
            (result.cronsSkipped?.length ? `, ${result.cronsSkipped.length} skipped (${result.cronsSkipped.join(', ')})` : '')
          );
          break;
      }
    } else {
      // All-agents migration
      const summary = migrateAll(frameworkRoot, ctxRoot, migOpts);

      const migrated = summary.results.filter(r => r.status === 'migrated').length;
      const skippedAlready = summary.results.filter(r => r.status === 'skipped-already-migrated').length;
      const noConfig = summary.results.filter(r => r.status === 'no-config').length;
      const noCrons = summary.results.filter(r => r.status === 'no-crons').length;

      console.log(`\nMigration summary:`);
      console.log(`  Agents processed    : ${summary.processed}`);
      console.log(`  Agents migrated     : ${migrated} (${summary.totalCronsMigrated} crons)`);
      console.log(`  Already migrated    : ${skippedAlready}`);
      console.log(`  No config.json      : ${noConfig}`);
      console.log(`  No crons in config  : ${noCrons}`);
    }
  });

// ---------------------------------------------------------------------------
// upgrade-cron-teaching — Subtask 2.4: scan agent workspace for stale
// CronCreate / /loop / config.json cron-registration teaching that predates
// the external-persistent-crons migration.  Scan-only by default; --apply
// performs only the safe literal substitutions known not to depend on
// surrounding context.
// ---------------------------------------------------------------------------

busCommand
  .command('upgrade-cron-teaching')
  .description('Scan agent workspace files for stale CronCreate/loop/config.json cron teaching')
  .argument('[agent]', 'Agent name to scan (omit to scan all agents under orgs/)')
  .option('--apply', 'Perform safe literal substitutions in place (does not rewrite CronCreate references)')
  .option('--json', 'Emit JSON instead of human-readable text')
  .action(async (
    agentArg: string | undefined,
    opts: { apply?: boolean; json?: boolean },
  ) => {
    const { scanAgentDir, groupMatchesByFile } =
      await import('../utils/cron-teaching-scanner.js');
    const env = resolveEnv();
    const frameworkRoot = env.frameworkRoot || process.cwd();

    const { existsSync: fsExists, readdirSync: fsReaddir } =
      require('fs') as typeof import('fs');

    // Resolve agent name to its absolute workspace dir (orgs/*/agents/AGENT).
    function resolveAgentDir(agent: string): string | undefined {
      const orgsDir = join(frameworkRoot, 'orgs');
      if (!fsExists(orgsDir)) return undefined;
      try {
        for (const entry of fsReaddir(orgsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const candidate = join(orgsDir, entry.name, 'agents', agent);
          if (fsExists(candidate)) return candidate;
        }
      } catch {
        // ignore scan errors
      }
      return undefined;
    }

    // List every agent dir under orgs/ORG/agents/.
    function listAllAgents(): { agent: string; dir: string }[] {
      const orgsDir = join(frameworkRoot, 'orgs');
      const out: { agent: string; dir: string }[] = [];
      if (!fsExists(orgsDir)) return out;
      try {
        for (const orgEntry of fsReaddir(orgsDir, { withFileTypes: true })) {
          if (!orgEntry.isDirectory()) continue;
          const agentsRoot = join(orgsDir, orgEntry.name, 'agents');
          if (!fsExists(agentsRoot)) continue;
          for (const a of fsReaddir(agentsRoot, { withFileTypes: true })) {
            if (a.isDirectory() && !a.name.startsWith('.')) {
              out.push({ agent: a.name, dir: join(agentsRoot, a.name) });
            }
          }
        }
      } catch {
        // ignore scan errors
      }
      return out;
    }

    type Report = {
      agent: string;
      result: ReturnType<typeof scanAgentDir>;
    };

    const reports: Report[] = [];
    if (agentArg) {
      try { validateAgentName(agentArg); } catch (err) { console.error(String(err)); process.exit(1); }
      const dir = resolveAgentDir(agentArg);
      if (!dir) {
        console.error(`Error: agent '${agentArg}' not found under ${join(frameworkRoot, 'orgs')}/*/agents/`);
        process.exit(1);
      }
      reports.push({ agent: agentArg, result: scanAgentDir(dir, { apply: opts.apply }) });
    } else {
      for (const { agent, dir } of listAllAgents()) {
        reports.push({ agent, result: scanAgentDir(dir, { apply: opts.apply }) });
      }
    }

    if (opts.json) {
      console.log(JSON.stringify(
        reports.map((r) => ({
          agent: r.agent,
          agentDir: r.result.agentDir,
          scannedFiles: r.result.scannedFiles,
          skippedSentinelFiles: r.result.skippedSentinelFiles,
          appliedSubstitutions: r.result.appliedSubstitutions,
          matches: r.result.matches,
        })),
        null,
        2,
      ));
      const totalMatches = reports.reduce((sum, r) => sum + r.result.matches.length, 0);
      process.exit(totalMatches === 0 ? 0 : 1);
    }

    let totalMatches = 0;
    let totalApplied = 0;
    for (const { agent, result } of reports) {
      totalMatches += result.matches.length;
      totalApplied += result.appliedSubstitutions;

      if (result.matches.length === 0 && result.appliedSubstitutions === 0) {
        console.log(`✓ ${agent}: no stale cron-teaching references (${result.scannedFiles.length} files scanned)`);
        continue;
      }

      console.log(`\n${agent}: ${result.matches.length} stale reference(s) in ${result.scannedFiles.length} files`);
      if (result.skippedSentinelFiles.length > 0) {
        console.log(`  (skipped ${result.skippedSentinelFiles.length} sentinel-marked file(s): ${result.skippedSentinelFiles.map((f) => f.replace(result.agentDir + '/', '')).join(', ')})`);
      }
      const grouped = groupMatchesByFile(result.matches);
      for (const [file, matches] of grouped) {
        const rel = file.replace(result.agentDir + '/', '');
        console.log(`\n  ${rel}`);
        for (const m of matches) {
          console.log(`    L${m.line} [${m.pattern}]: ${m.excerpt}`);
          console.log(`      → ${m.suggestion}`);
        }
      }
      if (result.appliedSubstitutions > 0) {
        console.log(`\n  Applied ${result.appliedSubstitutions} safe substitution(s) in place.`);
      }
    }

    console.log(`\nSummary: ${totalMatches} stale reference(s) across ${reports.length} agent(s)` +
      (opts.apply ? `, ${totalApplied} substitution(s) applied.` : '.'));
    if (totalMatches > 0 && !opts.apply) {
      console.log(`Run with --apply to substitute the safe-rewritable patterns. CronCreate / /loop references must be updated manually.`);
    }
    process.exit(totalMatches === 0 ? 0 : 1);
  });

busCommand
  .command('hook-context-status')
  .description('StatusLine hook: writes context window % to state/context_status.json')
  .action(() => runHook('hook-context-status'));

busCommand
  .command('hook-ask-telegram')
  .description('PreToolUse hook: forward AskUserQuestion to Telegram (cross-platform)')
  .action(() => runHook('hook-ask-telegram'));

busCommand
  .command('hook-permission-telegram')
  .description('PermissionRequest hook: send approve/deny request to Telegram (cross-platform)')
  .action(() => runHook('hook-permission-telegram'));

busCommand
  .command('hook-planmode-telegram')
  .description('ExitPlanMode hook: send plan for review to Telegram (cross-platform)')
  .action(() => runHook('hook-planmode-telegram'));

busCommand
  .command('hook-compact-telegram')
  .description('PreCompact hook: notify user via Telegram when context compaction starts (#18)')
  .action(() => runHook('hook-compact-telegram'));

busCommand
  .command('hook-idle-flag')
  .description('Stop hook: writes last_idle.flag timestamp so fast-checker knows agent finished its turn')
  .action(() => runHook('hook-idle-flag'));

busCommand
  .command('hook-loop-detector')
  .description('PreToolUse hook: detects and blocks repeated tool loops (same-args repetition + ping-pong alternation)')
  .action(() => runHook('hook-loop-detector'));

// --- OAuth token rotation commands ---

busCommand
  .command('check-usage-api')
  .description('Fetch Claude OAuth utilization from Anthropic usage API (3-min TTL cache)')
  .option('--account <name>', 'Check specific account (default: active account)')
  .option('--force', 'Bypass cache and fetch fresh data')
  .option('--json', 'Output as JSON')
  .action(async (opts: { account?: string; force?: boolean; json?: boolean }) => {
    const env = resolveEnv();
    try {
      const result = await checkUsageApi(env.ctxRoot, { force: opts.force, account: opts.account });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const cached = result.cached ? ' (cached)' : '';
        const warn5h = result.five_hour_utilization >= ALERT_5H ? ' ⚠️' : '';
        const warn7d = result.seven_day_utilization >= ALERT_7D ? ' ⚠️' : '';
        console.log(`Account: ${result.account}${cached}`);
        console.log(`5h utilization:  ${pct(result.five_hour_utilization)}${warn5h}`);
        console.log(`7d utilization:  ${pct(result.seven_day_utilization)}${warn7d}`);
        console.log(`Fetched at: ${result.fetched_at}`);
      }
    } catch (err) {
      console.error(`Error: ${err}`);
      process.exit(1);
    }
  });

busCommand
  .command('refresh-oauth-token')
  .description('Refresh OAuth token for an account using its refresh_token (one-time use — writes atomically)')
  .option('--account <name>', 'Account to refresh (default: active account)')
  .action(async (opts: { account?: string }) => {
    const env = resolveEnv();
    try {
      const result = await refreshOAuthToken(env.ctxRoot, opts.account);
      const expiresIn = Math.round((result.expires_at - Date.now()) / 1000 / 60);
      console.log(`Refreshed account: ${result.account}`);
      console.log(`New token expires in: ${expiresIn} minutes`);
    } catch (err) {
      console.error(`Error: ${err}`);
      process.exit(1);
    }
  });

busCommand
  .command('rotate-oauth')
  .description('Rotate to the next OAuth account if utilization thresholds are met')
  .option('--force', 'Force rotation regardless of utilization')
  .option('--agent <name>', 'Only update this agent\'s .env (default: all agents in org)')
  .option('--reason <text>', 'Reason for rotation (logged)')
  .option('--json', 'Output as JSON')
  .action(async (opts: { force?: boolean; agent?: string; reason?: string; json?: boolean }) => {
    const env = resolveEnv();
    if (!env.frameworkRoot) {
      console.error('CTX_FRAMEWORK_ROOT is required for rotate-oauth');
      process.exit(1);
    }
    try {
      const result = await rotateOAuth(env.ctxRoot, env.frameworkRoot, env.org, {
        force: opts.force,
        agent: opts.agent,
        reason: opts.reason,
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (result.rotated) {
        console.log(`Rotated: ${result.from} → ${result.to}`);
        console.log(`Reason: ${result.reason}`);
      } else {
        console.log(`No rotation needed: ${result.reason}`);
      }
    } catch (err) {
      console.error(`Error: ${err}`);
      process.exit(1);
    }
  });

busCommand
  .command('provision-keys')
  .description('Provision per-agent bus signing keys for all registered agents (idempotent — existing keys are never rotated)')
  .action(() => {
    const env = resolveEnv();
    if (!env.frameworkRoot) {
      console.error('CTX_FRAMEWORK_ROOT is required for provision-keys');
      process.exit(1);
    }
    let created = 0;
    let skipped = 0;
    for (const agent of listAgents(env.ctxRoot)) {
      const agentDir = join(env.frameworkRoot, 'orgs', agent.org, 'agents', agent.name);
      // Stale enabled-agents.json entries (no dir on disk) and pseudo-agents
      // like 'dashboard' have no agent directory — never provision those.
      if (!agent.org || !existsSync(agentDir)) {
        console.log(`skipped ${agent.name} (no agent directory)`);
        continue;
      }
      const existed = existsSync(join(agentDir, KEY_FILENAME));
      generateAgentKey(agentDir);
      if (existed) {
        skipped++;
        console.log(`skipped ${agent.name} (key exists)`);
      } else {
        created++;
        console.log(`created ${agent.name}`);
      }
    }
    console.log(`Done: ${created} created, ${skipped} already provisioned`);
  });

busCommand
  .command('list-oauth-accounts')
  .description('List all OAuth accounts and their utilization')
  .action((opts: Record<string, unknown>) => {
    const env = resolveEnv();
    const store = loadAccounts(env.ctxRoot);
    if (!store) {
      console.log('No accounts.json found at state/oauth/accounts.json');
      return;
    }
    for (const [name, acct] of Object.entries(store.accounts)) {
      const active = name === store.active ? ' (active)' : '';
      const expiry = new Date(acct.expires_at).toISOString();
      const warn5h = acct.five_hour_utilization >= ALERT_5H ? ' ⚠️' : '';
      const warn7d = acct.seven_day_utilization >= ALERT_7D ? ' ⚠️' : '';
      console.log(`${name}${active}`);
      console.log(`  5h: ${pct(acct.five_hour_utilization)}${warn5h}  7d: ${pct(acct.seven_day_utilization)}${warn7d}  expires: ${expiry}`);
    }
  });

busCommand
  .command('tui-stream')
  .description('Stream Claude Code TUI tool activity to the event log and optionally Telegram')
  .option('--session <name>', 'tmux session name (defaults to CTX_AGENT_NAME)')
  .option('--interval <ms>', 'Poll interval in milliseconds', '2000')
  .option('--telegram', 'Forward high-signal events to Telegram chat', false)
  .option('--dry-run', 'Print events to stdout instead of logging', false)
  .action(async (opts: { session?: string; interval: string; telegram: boolean; dryRun: boolean }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const sessionName = opts.session || env.agentName;
    const pollMs = Math.max(500, parseInt(opts.interval, 10) || 2000);

    // High-signal patterns: tool calls that indicate real work
    const HIGH_SIGNAL = [
      /^[├│└].*Tool:\s*(Bash|Edit|Write|Read|Glob|Grep|WebFetch|WebSearch|Agent)/i,
      /^[├│└].*Running bash command/i,
      /^[├│└].*Editing file/i,
      /^[├│└].*Writing file/i,
      /^[├│└].*Reading file/i,
      /error|Error|ERROR/,
      /✓.*completed|✗.*failed/i,
      /Permission (request|denied|approved)/i,
    ];

    const TOOL_LINE = /^[├│└▶◆●]|^(Tool|Bash|Edit|Write|Read|Glob|Grep|Agent):/i;

    let prevOutput = '';
    let telegramApi: any = null;
    let chatId: string | undefined;

    // Set up Telegram if requested
    if (opts.telegram) {
      const { TelegramAPI } = await import('../telegram/api.js');
      const agentDir = process.env.CTX_AGENT_DIR || process.cwd();
      const envPath = join(agentDir, '.env');
      if (existsSync(envPath)) {
        const envContent = stripBom(readFileSync(envPath, 'utf-8'));
        const botTokenMatch = envContent.match(/^BOT_TOKEN=(.+)$/m);
        const chatIdMatch = envContent.match(/^CHAT_ID=(.+)$/m);
        if (botTokenMatch && chatIdMatch) {
          telegramApi = new TelegramAPI(botTokenMatch[1].trim());
          chatId = chatIdMatch[1].trim();
        }
      }
    }

    const logLine = (msg: string) => {
      if (opts.dryRun) {
        console.log(msg);
      }
    };

    let lastTelegramSent = 0;
    const TELEGRAM_COOLDOWN_MS = 10000; // max 1 Telegram message per 10s

    logLine(`[tui-stream] Watching tmux session: ${sessionName} (poll: ${pollMs}ms)`);

    // Poll loop
    while (true) {
      try {
        // Capture current tmux pane content
        let currentOutput = '';
        try {
          const result = execFileSync('tmux', ['capture-pane', '-t', sessionName, '-p'], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
          });
          currentOutput = result;
        } catch {
          // Session not found or tmux not available — wait and retry
          await sleepMs(pollMs * 5);
          continue;
        }

        // Diff: find new lines appended since last poll
        const prevLines = prevOutput.split('\n');
        const currLines = currentOutput.split('\n');
        const newLines = currLines.length > prevLines.length
          ? currLines.slice(prevLines.length - 1)
          : currLines.filter(l => !prevOutput.includes(l));

        prevOutput = currentOutput;

        if (newLines.length === 0) {
          await sleepMs(pollMs);
          continue;
        }

        // Filter to tool-call lines only
        const toolLines = newLines.filter(l => {
          const t = l.trim();
          return t.length > 0 && (TOOL_LINE.test(t) || t.startsWith('●') || t.startsWith('◆'));
        });

        for (const line of toolLines) {
          const trimmed = line.trim().slice(0, 200);
          const isHighSignal = HIGH_SIGNAL.some(re => re.test(trimmed));

          // Log to event bus
          if (!opts.dryRun) {
            try {
              logEvent(paths, env.agentName, env.org, 'agent_activity' as any, 'tool_call', 'info', {
                line: trimmed,
                session: sessionName,
                high_signal: isHighSignal,
              });
            } catch { /* Never fail the stream */ }
          } else {
            logLine(`[event] ${trimmed}`);
          }

          // Forward high-signal events to Telegram (rate-limited)
          if (isHighSignal && opts.telegram && telegramApi && chatId) {
            const now = Date.now();
            if (now - lastTelegramSent >= TELEGRAM_COOLDOWN_MS) {
              lastTelegramSent = now;
              try {
                await telegramApi.sendMessage(chatId, `[${env.agentName}] ${trimmed}`);
              } catch { /* Never fail the stream */ }
            }
          }
        }
      } catch {
        // Continue on any error
      }

      await sleepMs(pollMs);
    }
  });

// --- fix-agent-settings ---

busCommand
  .command('fix-agent-settings')
  .description('Patch all agent settings.json files: add missing allowlist tools and statusLine hook')
  .option('--dry-run', 'Show what would be changed without writing')
  .action((opts: { dryRun?: boolean }) => {
    const { existsSync: fsExists, readdirSync: fsReaddir, readFileSync: fsRead, writeFileSync: fsWrite } = require('fs');
    const env = resolveEnv();
    const frameworkRoot = env.frameworkRoot || process.cwd();
    const orgsDir = join(frameworkRoot, 'orgs');

    const REQUIRED_ALLOW = [
      'Bash', 'Read', 'Edit', 'Write',
      'Glob', 'Grep',
      'WebFetch', 'WebSearch',
      'ToolSearch', 'CronCreate', 'CronList', 'CronDelete',
      'Skill', 'Agent',
    ];
    const STATUS_LINE = {
      type: 'command',
      command: 'cortextos bus hook-context-status',
      refreshInterval: 5,
      timeout: 2,
    };

    if (!fsExists(orgsDir)) {
      console.error('orgs/ directory not found at', orgsDir);
      process.exit(1);
    }

    let patched = 0;
    let skipped = 0;

    for (const org of fsReaddir(orgsDir)) {
      const agentsDir = join(orgsDir, org, 'agents');
      if (!fsExists(agentsDir)) continue;
      for (const agent of fsReaddir(agentsDir)) {
        const settingsPath = join(agentsDir, agent, '.claude', 'settings.json');
        if (!fsExists(settingsPath)) continue;

        let settings: any;
        try { settings = JSON.parse(fsRead(settingsPath, 'utf-8')); }
        catch { console.warn(`  SKIP ${agent}: could not parse settings.json`); skipped++; continue; }

        const changes: string[] = [];

        // Check allow list
        const current: string[] = settings?.permissions?.allow ?? [];
        const missing = REQUIRED_ALLOW.filter(t => !current.includes(t));
        if (missing.length > 0) changes.push(`allow: +[${missing.join(', ')}]`);

        // Check statusLine
        if (!settings.statusLine) changes.push('statusLine: add hook-context-status');

        if (changes.length === 0) {
          console.log(`  OK   ${agent}: already up to date`);
          skipped++;
          continue;
        }

        if (opts.dryRun) {
          console.log(`  DRY  ${agent}: would apply [${changes.join('; ')}]`);
          patched++;
        } else {
          settings.permissions = settings.permissions ?? {};
          settings.permissions.allow = [...current, ...missing];
          settings.statusLine = STATUS_LINE;
          fsWrite(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
          console.log(`  FIX  ${agent}: applied [${changes.join('; ')}]`);
          patched++;
        }
      }
    }

    const verb = opts.dryRun ? 'Would patch' : 'Patched';
    console.log(`\n${verb} ${patched} agent(s). ${skipped} already up to date or skipped.`);
    if (!opts.dryRun && patched > 0) {
      console.log('\nRestart affected agents to apply the new settings:');
      console.log('  cortextos restart <agent-name>');
    }
  });

busCommand
  .command('check-cron-drift')
  .description('Report config.json cron edits that are NOT in effect (fleet-wide)')
  .option('--json', 'Emit raw JSON instead of the formatted report')
  .option('--notify', 'Send ONE consolidated message to the org orchestrator when drift is found')
  .action(async (opts: { json?: boolean; notify?: boolean }) => {
    const { sweepConfigCronDrift, formatDriftFindings, countActionableFindings, countLatentMarkerAbsent, statedTimeCoverage, listExcludedRetiredAgents, liveCronComparisonCoverage } = await import('../daemon/cron-drift.js');
    const env = resolveEnv();
    const projectRoot = env.projectRoot || env.frameworkRoot || process.cwd();

    const findings = sweepConfigCronDrift(projectRoot);
    const { writeRunReceipt } = await import('../daemon/cron-receipts.js');

    // Agents with no marker AND no crons.json are harmless today but prove the marker-absent
    // state occurs here naturally — one runtime add-cron on any of them assembles the full wipe
    // condition by accident. Counted, not listed as findings: two permanent top-of-report entries
    // is how a real finding gets trained out of existence.
    const latent = countLatentMarkerAbsent();
    // Coverage, not just findings. A prompt tidied into a pointer removes the check subject and
    // shrinks the denominator silently, which reads exactly like a clean report.
    const coverage = statedTimeCoverage();
    // A live cron with no config.json counterpart cannot generate a finding of any kind — the
    // comparison itself only sees a fraction of the fleet unless this is stated (task_1785672685330_40401679).
    const liveCoverage = liveCronComparisonCoverage(projectRoot);
    // missing-live is the class most likely to read as "0 because nothing is wrong" when it is
    // actually "0 because the branch was never exercised" — always print it, not just when nonzero.
    const missingLiveCount = findings.filter((f) => f.kind === 'missing-live').length;
    // Stated because an unstated scope narrowing is indistinguishable from a clean bill of health,
    // and because re-enabling one of these silently returns it to scope — a disabled agent holding
    // crons.json with no marker is a wipe condition that arms on re-enable.
    const retired = listExcludedRetiredAgents();

    if (opts.json) {
      console.log(JSON.stringify({ findings, missing_live_count: missingLiveCount, latent_marker_absent: latent, stated_time_coverage: coverage, live_cron_comparison_coverage: liveCoverage, excluded_retired: retired }, null, 2));
    } else {
      console.log(
        `Compared ${liveCoverage.compared} of ${liveCoverage.totalLive} live cron(s) against ` +
          `config.json; ${liveCoverage.uncomparable.length} have no config counterpart and are ` +
          `NOT COMPARABLE BY THIS TOOL (config.json is dead text post-migration, so this is not a ` +
          `defect in those crons). missing-live: ${missingLiveCount} (0 unless config.json names a ` +
          `cron with no live counterpart — a real class, distinct from the ` +
          `${liveCoverage.uncomparable.length} above, which are the opposite direction).\n`,
      );
      console.log(formatDriftFindings(findings));
      console.log(
        `
Stated-time coverage: ${coverage.stating} of ${coverage.timeAnchored} time-anchored ` +
          `cron(s) state their intended local time and are therefore checkable. A DROP in that ` +
          `first number between runs is itself a finding — a prompt tidied into a doc pointer ` +
          `removes the only evidence that can catch a wrong schedule.` +
          `
  ${coverage.disclaimed} time token(s) disclaimed by a negation (e.g. "not 8am ET") and correctly ` +
          `not counted as claims. This guards the OTHER direction: the extractor is shared by the ` +
          `finding path and by the number above, so an over-matching extractor would RAISE coverage ` +
          `and read as improving health. A RISE here is the tell.` +
          `
  ${coverage.threshold} time token(s) read as a THRESHOLD, not a claim — a time introduced by a ` +
          `comparison ("older than 6pm ET", "before the 7am ET brief", "received after 6:30am ET") ` +
          `is what the cron reasons ABOUT, and it may fire at any hour to evaluate it. Counted ` +
          `separately from disclaimed so neither guard's false positives can hide inside the ` +
          `other's expected number. A RISE here is the tell, same as above.` +
          `
  ${coverage.utcOnlyExcluded.length} cron(s) OUT OF SCOPE — their only time signal is a stated ` +
          `UTC time, which is already unambiguous and needs no local-time verification. Excluded ` +
          `from the denominator rather than counted as uncovered, and named here rather than ` +
          `silently narrowed: ${coverage.utcOnlyExcluded.map((c) => `${c.agent}/${c.cron}`).join(', ') || '(none)'}` +
          `
  Membership for stating/disclaimed/threshold is in --json (stated_time_coverage.statingCrons etc) ` +
          `— a count alone cannot be audited without it.`,
      );
      if (latent.length > 0) {
        console.log(
          `
Also ${latent.length} agent(s) with no .crons-migrated marker and no live crons ` +
            `(harmless now, one add-cron away from the wipe condition): ${latent.join(', ')}`,
        );
      }
      if (retired.length > 0) {
        console.log(
          `
Out of scope: ${retired.length} disabled agent(s) — ${retired.join(', ')}. They do not boot, so ` +
            `nothing they declare can fire and none of the comparisons above have a consequence for ` +
            `them. RE-ENABLING ONE RETURNS IT TO SCOPE SILENTLY, so if any of them holds crons.json ` +
            `with no .crons-migrated marker, that wipe condition arms the moment it is switched on.`,
        );
      }
    }

    // Unconditional run receipt, written BEFORE the early return on a clean run.
    //
    // This detector previously produced NOTHING on a clean run — no event, no message, no file — so
    // "ran, found nothing" was byte-identical to "never fired", and it could not be watched by
    // anything. seb_boss guessed this exact path when adding an expectation for it and flagged that
    // he had invented it rather than deleting the check. He guessed right about the convention; the
    // file just did not exist yet. It does now.
    try {
      const ctxRoot = process.env.CTX_ROOT;
      if (ctxRoot) {
        // Fingerprint the finding SET, not just its size. The cron prompt says "if the report is
        // unchanged since the last run, say so in one line rather than re-listing" — and a count
        // alone cannot establish that: 34 findings then and 34 now is equally consistent with one
        // finding resolved and a different one appearing. An equal total masking changed membership
        // is the same shape as every other sum that stood in for the thing we cared about.
        const fingerprint = createHash('sha256')
          .update(
            [...findings]
              .map((f) => `${f.agent}/${f.cron}/${f.kind}`)
              .sort()
              .join('\n'),
          )
          .digest('hex')
          .slice(0, 16);
        writeRunReceipt(ctxRoot, env.agentName, 'cron-drift-receipt.jsonl', {
          cron: 'cron-drift-daily',
          findings: findings.length,
          // Compare THIS between runs to claim "unchanged". Identical fingerprint = identical set.
          findings_fingerprint: fingerprint,
          latent_marker_absent: latent.length,
          stated_time_stating: coverage.stating,
          stated_time_anchored: coverage.timeAnchored,
          stated_time_utc_excluded: coverage.utcOnlyExcluded.length,
          live_compared: liveCoverage.compared,
          live_total: liveCoverage.totalLive,
          missing_live_count: missingLiveCount,
        });
      }
    } catch { /* a receipt that cannot be written must not suppress the report */ }

    if (findings.length === 0) return;

    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    try {
      logEvent(paths, env.agentName, env.org, 'action', 'cron_config_drift_detected', 'warning', {
        finding_count: findings.length,
        agents: [...new Set(findings.map((f) => f.agent))],
        kinds: findings.reduce<Record<string, number>>((acc, f) => {
          acc[f.kind] = (acc[f.kind] ?? 0) + 1;
          return acc;
        }, {}),
      });
    } catch { /* non-fatal */ }

    // ONE message for the whole fleet, never one per agent. Fourteen separate notifications
    // for a fleet-wide condition is how a real finding gets filtered out as noise.
    if (!opts.notify) return;
    try {
      // HEADLINE COUNTS ACTIONABLE ONLY (seb_boss, 2026-08-04) — prompt-differs is the norm, not an
      // event (see countActionableFindings), and a headline that fires the same alarm on a clean run
      // and a real one trains the reader to stop reading it. Silent when there is nothing actionable,
      // even if prompt-differs findings exist — that class already has a weekly liveness line elsewhere
      // in this cron's own prompt; this message is for things that need a human today.
      const actionable = countActionableFindings(findings);
      if (actionable === 0) return;
      const promptDiffersCount = findings.length - actionable;
      const contextPath = join(projectRoot, 'orgs', env.org, 'context.json');
      if (!existsSync(contextPath)) return;
      const ctx = JSON.parse(readFileSync(contextPath, 'utf-8'));
      if (!ctx.orchestrator || ctx.orchestrator === env.agentName) return;
      sendMessage(
        paths,
        env.agentName,
        ctx.orchestrator,
        'normal',
        `config.json cron drift: ${actionable} actionable finding(s)` +
          (promptDiffersCount > 0 ? ` (+${promptDiffersCount} prompt-differs, the norm)` : '') +
          `.\n\n${formatDriftFindings(findings)}`,
      );
    } catch { /* the event above already carries the finding */ }
  });

busCommand
  .command('check-expectations')
  .description('Evaluate every agent expectations.json manifest (fleet-wide, cross-agent)')
  .option('--json', 'Emit raw JSON instead of the formatted report')
  .option('--notify', 'Send ONE consolidated message to the org orchestrator when a check fails')
  .action(async (opts: { json?: boolean; notify?: boolean }) => {
    const { sweepExpectations, formatSweep, writeCheckerReceipt } = await import('../daemon/freshness.js');
    const env = resolveEnv();
    const projectRoot = env.projectRoot || env.frameworkRoot || process.cwd();

    const result = sweepExpectations(projectRoot);

    // Written on EVERY run, pass or fail. It is the artifact that lets a different agent notice
    // this checker going mute — the failure mode that made a second detector the wrong answer.
    let receiptPath: string | null = null;
    try {
      const ctxRoot = process.env.CTX_ROOT;
      if (ctxRoot) receiptPath = writeCheckerReceipt(ctxRoot, env.agentName, result);
    } catch { /* a receipt that cannot be written must not suppress the report */ }

    if (opts.json) {
      console.log(JSON.stringify({ ...result, receipt_path: receiptPath }, null, 2));
    } else {
      console.log(formatSweep(result));
      if (receiptPath) console.log(`\nRun receipt appended: ${receiptPath}`);
    }

    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    if (result.findings.length === 0) return;

    try {
      logEvent(paths, env.agentName, env.org, 'action', 'expectation_check_failed', 'warning', {
        finding_count: result.findings.length,
        agents: [...new Set(result.findings.map((f) => f.agent))],
        kinds: result.findings.reduce<Record<string, number>>((acc, f) => {
          acc[f.kind] = (acc[f.kind] ?? 0) + 1;
          return acc;
        }, {}),
        evaluable: result.coverage.evaluable,
        declared: result.coverage.declared,
      });
    } catch { /* non-fatal */ }

    // ONE message for the whole fleet, never one per agent — same rule as check-cron-drift.
    if (!opts.notify) return;
    try {
      const contextPath = join(projectRoot, 'orgs', env.org, 'context.json');
      if (!existsSync(contextPath)) return;
      const ctx = JSON.parse(readFileSync(contextPath, 'utf-8'));
      if (!ctx.orchestrator || ctx.orchestrator === env.agentName) return;
      sendMessage(
        paths,
        env.agentName,
        ctx.orchestrator,
        'normal',
        `Expectation check: ${result.findings.length} failure(s).\n\n${formatSweep(result)}`,
      );
    } catch { /* the event above already carries the finding */ }
  });

function sleepMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}
