/**
 * cron-delivery-log.ts — Per-agent cron DELIVERY log writer (task_1786971045376, 2026-08-17).
 *
 * Appends one JSONL entry to `$CTX_ROOT/.cortextOS/state/agents/{agent}/cron-delivery.log`
 * on every CONFIRMED successful `AgentProcess.drainTick()` PTY delivery.
 *
 * WHY A SEPARATE FILE FROM cron-execution.log — see crons-schema.ts's cronDeliveryLogPathFor()
 * doc comment for the full reasoning. Short version: cron-execution.log records enqueue success,
 * not delivery; several existing tools already parse its current shape, so this adds a new file
 * rather than a new status value on the old one.
 *
 * Same crash-safety and rotation shape as cron-execution-log.ts, deliberately mirrored rather than
 * shared — two independent small writers are safer than a shared one two callers must agree on the
 * generic shape of, and appendExecutionLog's own doc says it "must never throw," which this matches.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  renameSync,
} from 'fs';
import { join, dirname } from 'path';
import { randomBytes } from 'crypto';
import type { CronDeliveryLogEntry } from '../types/index.js';
import { cronDeliveryLogPathFor } from '../bus/crons-schema.js';
import { resolveCtxRoot } from '../utils/env.js';

/** Maximum number of log entries to retain per agent after rotation. Matches cron-execution-log.ts. */
export const MAX_LOG_LINES = 1_000;

/** Size threshold (bytes) above which we attempt log rotation. Matches cron-execution-log.ts. */
export const ROTATION_SIZE_BYTES = 200 * 1_024;

/**
 * Root comes from resolveCtxRoot() (task_1790474717185 item 5 follow-up,
 * Codex REQUEST-CHANGES 2026-09-27): this file previously fell back to
 * process.cwd() independently of cron-execution-log.ts's own (now-fixed)
 * fallback, so a delivery log and an execution log for the same cron could
 * silently land under two different roots.
 */
function logFilePath(agentName: string): string {
  const ctxRoot = resolveCtxRoot();
  return join(ctxRoot, cronDeliveryLogPathFor(agentName));
}

function ensureLogDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

/** Prune the log file to at most MAX_LOG_LINES entries using an atomic rename. */
function rotateIfNeeded(filePath: string): void {
  try {
    const stat = statSync(filePath);
    if (stat.size <= ROTATION_SIZE_BYTES) {
      return;
    }

    const raw = readFileSync(filePath, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim().length > 0);

    if (lines.length <= MAX_LOG_LINES) {
      return;
    }

    const pruned = lines.slice(lines.length - MAX_LOG_LINES);
    const content = pruned.join('\n') + '\n';

    const tmpPath = join(dirname(filePath), `.tmp.${randomBytes(6).toString('hex')}`);
    try {
      writeFileSync(tmpPath, content, { encoding: 'utf-8', mode: 0o600 });
      renameSync(tmpPath, filePath);
    } catch (err) {
      try { require('fs').unlinkSync(tmpPath); } catch { /* ignore */ }
      throw err;
    }
  } catch {
    // Rotation errors must never crash the caller.
  }
}

/**
 * Append one JSONL entry to the agent's cron delivery log.
 *
 * Called from AgentProcess.drainTick() on confirmed successful PTY delivery ONLY — there is no
 * failure variant of this call (failure already has emitDroppedInjectEvent's bus event).
 * Must not throw — any I/O error is swallowed so it never disrupts the drain loop.
 *
 * Same silent-swallow gap as cron-execution-log.ts's appendExecutionLog(), same partial fix
 * (task_1790474717185 item 1, 2026-09-27): a write failure here used to be indistinguishable
 * from "delivery genuinely still pending" — Codex review flagged that the "absence means
 * pending or lost" diagnosis in the broader design doc is unsound while BOTH loggers can fail
 * silently. console.error does not make absence unambiguous on its own, but it stops this
 * specific write failure from vanishing with zero trace anywhere.
 */
export function appendDeliveryLog(
  agentName: string,
  entry: CronDeliveryLogEntry,
): void {
  try {
    const filePath = logFilePath(agentName);
    ensureLogDir(filePath);

    const line = JSON.stringify(entry) + '\n';
    appendFileSync(filePath, line, { encoding: 'utf-8' });

    rotateIfNeeded(filePath);
  } catch (err) {
    // Never crash the caller — delivery logging is observational only. But
    // never used to say why it failed, either.
    console.error(
      `[cron-delivery-log] failed to write entry for agent "${agentName}" ` +
      `(cron "${entry.cron}"): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** True if this agent has ever had a delivery logged. Not used by the writer itself; a convenience for readers/tests. */
export function hasDeliveryLog(agentName: string): boolean {
  return existsSync(logFilePath(agentName));
}
