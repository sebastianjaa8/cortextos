/**
 * crons-schema.ts — Path constants and helpers for the external persistent cron system.
 *
 * Subtask 1.1 (schema design).  Intentionally thin: only constants and a path
 * joiner.  Read/write operations live in Subtask 1.2 (src/bus/crons.ts).
 *
 * Per-agent crons.json location:
 *   {CRONS_DIRECTORY}/{agentName}/{CRONS_FILENAME}
 *   => .cortextOS/state/agents/boris/crons.json
 */

import { join } from 'path';

/**
 * Root directory that holds per-agent state sub-directories.
 * Relative to CTX_ROOT; callers that need an absolute path should
 * prefix with the CTX_ROOT env var or the framework root from CtxEnv.
 *
 * @example ".cortextOS/state/agents"
 */
export const CRONS_DIRECTORY = '.cortextOS/state/agents';

/**
 * File name for the cron definitions list inside each agent state directory.
 *
 * @example "crons.json"
 */
export const CRONS_FILENAME = 'crons.json';

/**
 * Return the path to an agent's crons.json relative to CTX_ROOT.
 *
 * @param agentName - The agent's directory name (e.g. "boris", "paul").
 * @returns Relative path string: `.cortextOS/state/agents/{agentName}/crons.json`
 *
 * @example
 * cronsPathFor("boris")
 * // => ".cortextOS/state/agents/boris/crons.json"
 */
export function cronsPathFor(agentName: string): string {
  return join(CRONS_DIRECTORY, agentName, CRONS_FILENAME);
}

/**
 * File name for the per-agent cron execution log (JSONL format).
 *
 * @example "cron-execution.log"
 */
export const CRON_EXECUTION_LOG_FILENAME = 'cron-execution.log';

/**
 * Return the path to an agent's cron execution log relative to CTX_ROOT.
 *
 * The log is JSONL: one CronExecutionLogEntry JSON object per line.
 * It is append-only; rotation prunes to the last 1 000 lines.
 *
 * @param agentName - The agent's directory name (e.g. "boris", "paul").
 * @returns Relative path string:
 *   `.cortextOS/state/agents/{agentName}/cron-execution.log`
 *
 * @example
 * cronExecutionLogPathFor("boris")
 * // => ".cortextOS/state/agents/boris/cron-execution.log"
 */
export function cronExecutionLogPathFor(agentName: string): string {
  return join(CRONS_DIRECTORY, agentName, CRON_EXECUTION_LOG_FILENAME);
}

/**
 * File name for the per-agent cron DELIVERY log (JSONL format).
 *
 * SEPARATE FROM cron-execution.log ON PURPOSE (task_1786971045376, 2026-08-17). The execution log
 * records ENQUEUE success (`injectAgentQueued` returning ok / `fireWithRetry` completing) — it has
 * no path back to whether `AgentProcess.drainTick()` actually delivered the prompt into the PTY.
 * A new, additive-only file rather than a new status value on the existing one: cron-execution.log
 * already has several readers (cron-evidence-check-v2.sh, cron-effectiveness-audit.py, hold-verify.mjs)
 * that parse its current shape — changing that format risks all of them, where a new file risks none.
 * A reader that wants delivery confirmation cross-references cron name + fired_at across both files;
 * one that doesn't is unaffected.
 *
 * @example "cron-delivery.log"
 */
export const CRON_DELIVERY_LOG_FILENAME = 'cron-delivery.log';

/**
 * Return the path to an agent's cron delivery log relative to CTX_ROOT.
 *
 * JSONL, append-only, one CronDeliveryLogEntry per line — written ONLY on a confirmed successful
 * `drainTick()` delivery (see agent-process.ts). Absence of a delivery line for a `cron` that DOES
 * have a "fired" line in cron-execution.log (matched by cron name + nearest timestamp — the two
 * `ts`/`fired_at` values are close but not byte-identical, captured a few ms apart at two different
 * points) is the signal this file exists to make visible: enqueued but never actually reached the PTY.
 *
 * LIMIT, stated next to the claim per this file's own convention (adversarial review, Codex,
 * task_1786971045376): the writer (`appendDeliveryLog`) swallows its own I/O errors, same as
 * cron-execution.log's writer. A disk-full or permission failure on THIS file produces the exact
 * same absence as a genuine non-delivery — an unwritable delivery log cannot be told apart from a
 * dropped prompt by this file alone. Both writers share the design tradeoff (never crash the drain
 * loop over an observational log), so this is not a defect specific to this file, but the
 * inference "absent = never delivered" is not airtight and a reader relying on it should know that.
 *
 * @param agentName - The agent's directory name (e.g. "boris", "paul").
 * @returns Relative path string:
 *   `.cortextOS/state/agents/{agentName}/cron-delivery.log`
 *
 * @example
 * cronDeliveryLogPathFor("boris")
 * // => ".cortextOS/state/agents/boris/cron-delivery.log"
 */
export function cronDeliveryLogPathFor(agentName: string): string {
  return join(CRONS_DIRECTORY, agentName, CRON_DELIVERY_LOG_FILENAME);
}
