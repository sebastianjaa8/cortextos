/**
 * Receipt discovery — did the RECEIVING side of a cron fire produce evidence it processed it?
 *
 * Receipts are DISCOVERED, not mandated, and that is the load-bearing design decision. A STEP-0
 * `create-task`, a log write, an `update-heartbeat` stamp and a `.cron-fire-receipts.jsonl` entry
 * are ONE predicate: an artifact only the receiving side can produce. Mandating one shape generates
 * boilerplate and misses evidence already on disk — todoist_keeper was told to build a receipts
 * file while already having full coverage on all three of their crons in a different shape. The
 * owning agent NAMES which artifact counts (see `ReceiptDeclaration`); this module tries the known
 * shapes in strength order and reports which one it relied on.
 *
 * SIGNAL HIERARCHY, and why the weakest one is last rather than absent:
 *
 *  1. Receiving-side artifact (receipts file, bus task, declared path). Proves the agent PROCESSED
 *     the fire. Preferred wherever one exists.
 *  2. `stdout.log` CRON FIRED banner. PTY echo only — proves the text ARRIVED at the terminal, not
 *     that anything acted on it. Weaker, and hostile to naive matching: PTY writes chunk and
 *     terminal redraw injects ANSI mid-string, so a raw `includes()` scores DELIVERED fires as
 *     dropped. Matcher below is chunk-tolerant and anchored, and its test asserts both directions.
 *  3. `cron-execution.log` is NOT in this list. It is a daemon-side ATTEMPT record: `duration_ms`
 *     of 0-1 is identical for a healthy fire and a dropped one, because the daemon only ever
 *     measures its own write. Used here ONLY to learn which timestamps to look for in stdout.log.
 *     Treating it as evidence of receipt would make this harness structurally blind to the exact
 *     failure class it exists to catch — every dropped injection would read as a healthy day.
 *
 * TWO STATE DIRECTORIES, verified rather than assumed. Receipts files live at
 * `{CTX_ROOT}/state/<agent>/` (`resolvePaths().stateDir`); crons.json, the migration marker and
 * cron-execution.log live at `{CTX_ROOT}/.cortextOS/state/agents/<agent>/` (`CRONS_DIRECTORY`).
 * Enumerating the wrong one produces a clean, confident, wrong report.
 */

import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from 'fs';
import { join } from 'path';
import { CRONS_DIRECTORY, CRON_EXECUTION_LOG_FILENAME } from '../bus/crons-schema.js';
import { localDateStamp, resolveCandidatePaths } from './expectations.js';
import type { ReceiptDeclaration } from './expectations.js';
import { listTasks } from '../bus/task.js';
import { resolvePaths } from '../utils/paths.js';

export const RECEIPTS_FILENAME = '.cron-fire-receipts.jsonl';

/** How the receipt was found, weakest-last. `NONE` and `NOT-CHECKED` are NOT the same answer. */
export type ReceiptKind =
  | 'receipts-file'
  | 'bus-task'
  | 'declared-path'
  | 'stdout-banner'
  /** All four shapes tried, nothing found. A finding. */
  | 'NONE'
  /** Nothing to look for — no receipt declared. A COVERAGE GAP, not a failure to assert. */
  | 'NOT-CHECKED';

export interface ReceiptResult {
  kind: ReceiptKind;
  /** What was relied on, so a report can be honest about the strength of its evidence. */
  evidence: string;
}

// ---------------------------------------------------------------------------
// stdout.log banner matcher. Ported from work/cron-injection-trace.mjs, whose self-test asserts
// both failure directions plus a sabotage case proving the naive matcher fails the split.
// ---------------------------------------------------------------------------

const ANCHOR = 'CRONFIRED';
/** Dense chars allowed between the banner and the timestamp before it stops counting as anchored. */
const ANCHOR_SLACK = 60;
// Built from a char code rather than written as an escape: a literal ESC byte in source makes git
// treat the file as binary and an editor round-trip can silently drop it. No backslashes here, so
// nothing can be eaten by a shell or a rewrite either.
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(
  ESC + '[[][0-9;?]*[ -/]*[@-~]|' + ESC + '[()][A-Za-z0-9]|' + ESC + '[=>]',
  'g',
);

/**
 * ANSI-stripped and whitespace-free, so a chunk boundary or a terminal redraw cannot separate
 * characters that were logically contiguous. Observed in the wild: a bare `CRON FIRED ` with its
 * timestamp split across a write.
 */
export function densify(s: string): string {
  // Keep only printable non-space ASCII (33-126). Strictly stronger than stripping whitespace and
  // C0 controls: it also removes anything a terminal can wedge between two logically adjacent
  // characters. Haystack and needle both pass through here, and ISO timestamps are pure ASCII, so
  // the anchored match is unaffected by the extra stripping.
  return s.replace(ANSI, '').replace(/[^!-~]/g, '');
}

/**
 * Text just after every banner, collected once. Scanning per-fire is O(fires x banners) over tens of
 * megabytes and does not finish at fleet scale.
 */
export function bannerRegions(dense: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const a = dense.indexOf(ANCHOR, from);
    if (a === -1) return out;
    const start = a + ANCHOR.length;
    out.push(dense.slice(start, start + ANCHOR_SLACK + 30));
    from = start;
  }
}

/**
 * Anchored match: the timestamp must sit inside a banner region.
 *
 * Without the anchor a bare `20:44:44` — which appears constantly in 40MB of agent output — matches
 * anywhere and undercounts drops. Both directions manufacture a finding, so both are constrained.
 */
export function bannerReached(dense: string, isoTs: string, regions?: string[]): string | null {
  const needle = densify(isoTs);
  for (const r of regions ?? bannerRegions(dense)) {
    if (r.startsWith(needle)) return 'anchored-exact';
    if (r.includes(needle)) return 'anchored-near';
  }
  return null;
}

/**
 * Tail of a log, bounded.
 *
 * stdout.log reaches 40MB+ on this fleet and a sweep touches every agent. One day's window never
 * needs the whole file, and reading it would make the daily check cost gigabytes of I/O.
 */
export function readTail(path: string, maxBytes: number): string {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return '';
  }
  const start = Math.max(0, size - maxBytes);
  const len = size - start;
  if (len <= 0) return '';
  const buf = Buffer.allocUnsafe(len);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, len, start);
  } finally {
    closeSync(fd);
  }
  // latin1 so no byte sequence can throw or be replaced; the matcher only cares about ASCII.
  return buf.toString('latin1');
}

const TAIL_BYTES = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Does a UTC record timestamp fall on `date` as seen in `timezone`?
 *
 * A string prefix compare was the first version of this and it was WRONG in the same way the chef
 * crons were: every record on disk is stamped in UTC, while `date` is a LOCAL calendar day. A fire
 * at `2026-07-30T02:30Z` is 22:30 on 2026-07-29 in New York, so prefix-matching attributes it to
 * the wrong day and reports a healthy fire as having no receipt. Every ISO timestamp needs
 * converting before it is compared to a local day, not slicing.
 */
function sameLocalDay(isoTs: string, date: string, timezone: string): boolean {
  const t = new Date(isoTs);
  if (isNaN(t.getTime())) return false;
  return localDateStamp(t, timezone) === date;
}

/** Fire timestamps the DAEMON claims it injected for this cron on that local day. */
function firedTimestamps(ctxRoot: string, agent: string, date: string, cron: string, timezone: string): string[] {
  const p = join(ctxRoot, CRONS_DIRECTORY, agent, CRON_EXECUTION_LOG_FILENAME);
  if (!existsSync(p)) return [];
  let text: string;
  try {
    text = readFileSync(p, 'utf-8');
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec: { ts?: string; cron?: string; status?: string };
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.status !== 'fired') continue;
    if (rec.cron !== cron) continue;
    if (typeof rec.ts !== 'string' || !sameLocalDay(rec.ts, date, timezone)) continue;
    out.push(rec.ts);
  }
  return out;
}

function receiptsFileHit(ctxRoot: string, agent: string, cron: string, date: string, timezone: string): string | null {
  const p = join(ctxRoot, 'state', agent, RECEIPTS_FILENAME);
  if (!existsSync(p)) return null;
  let text: string;
  try {
    text = readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec: { ts?: string; cron?: string; status?: string };
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.cron === cron && typeof rec.ts === 'string' && sameLocalDay(rec.ts, date, timezone)) {
      return `${RECEIPTS_FILENAME} entry ${rec.ts} status=${rec.status ?? 'unset'}`;
    }
  }
  return null;
}

/**
 * How long after a fire a STEP-0 task can still be that fire's receipt.
 *
 * A genuine STEP-0 `create-task` is the FIRST thing the injected prompt does, so it lands within
 * seconds. This bound exists because the first version of this function matched on cron name and
 * calendar day alone, and immediately produced the worst possible false positive on real data: the
 * REMEDIATION tasks filed while investigating two dropped fires ("daily-hygiene missed-fire
 * recovery", "midday-triage silent-miss catch-up") were created ~7h later, contained the cron name,
 * and were scored as receipts. The artifact proving the cron FAILED was read as proof it succeeded.
 *
 * That is the same shape as treating cron-execution.log as evidence of receipt — the harness
 * reproducing the bug it exists to detect — so the fix is a real comparison rather than a word
 * denylist: the task must sit beside an actual fire timestamp, close enough to have been caused by it.
 */
const STEP0_WINDOW_MS = 30 * 60_000;

/** Minimum a task must expose to be judged as a receipt. */
export interface ReceiptTask {
  id: string;
  title: string;
  created_at: string;
}

/**
 * Injectable, and not for neatness: `resolvePaths` derives the task directory from `homedir()`
 * rather than from CTX_ROOT, so a test cannot redirect it to a temp dir the way it can for crons and
 * receipts files. Without this seam the STEP-0 window below would be unreachable from a test, and an
 * untested bound is how the false positive it was written to fix got here in the first place.
 */
export type TaskSourceFn = (agent: string, org: string, instanceId: string) => ReceiptTask[];

export const busTaskSource: TaskSourceFn = (agent, org, instanceId) => {
  try {
    return listTasks(resolvePaths(agent, instanceId, org), { agent });
  } catch {
    return [];
  }
};

function busTaskHit(
  agent: string,
  cron: string,
  fires: string[],
  declared: ReceiptDeclaration | undefined,
  org: string | undefined,
  instanceId: string,
  taskSource: TaskSourceFn,
): string | null {
  if (!org) return null;
  // No fire that day means there is no fire for a task to be the receipt OF. A task alone proves
  // someone did the work, not that the injection arrived, and this function only answers the latter.
  if (fires.length === 0) return null;
  // A STEP-0 create-task only exists if the prompt reached the session AND was processed, which is
  // exactly the predicate — the task IS the receipt. Match on the declared fragment when given,
  // otherwise on the cron name.
  const needle = (declared?.task_title_contains ?? cron).toLowerCase();
  const fireTimes = fires.map((f) => new Date(f).getTime()).filter((n) => !isNaN(n));
  for (const t of taskSource(agent, org, instanceId)) {
    if (!t.title.toLowerCase().includes(needle)) continue;
    const created = new Date(t.created_at).getTime();
    if (isNaN(created)) continue;
    const fire = fireTimes.find((f) => created >= f && created - f <= STEP0_WINDOW_MS);
    if (fire === undefined) continue;
    return (
      `bus task ${t.id} "${t.title}" created ${t.created_at}, ` +
      `${Math.round((created - fire) / 1000)}s after the ${new Date(fire).toISOString()} fire`
    );
  }
  return null;
}

function declaredPathHit(
  declared: ReceiptDeclaration | undefined,
  now: Date,
  timezone: string,
  windowMs: number,
): string | null {
  if (!declared?.path) return null;
  for (const candidate of resolveCandidatePaths(declared.path, now, timezone, windowMs)) {
    try {
      const st = statSync(candidate);
      if (!st.isFile()) continue;
      if (now.getTime() - st.mtimeMs <= windowMs) {
        return `declared path ${candidate} written ${new Date(st.mtimeMs).toISOString()}`;
      }
    } catch {
      /* next candidate */
    }
  }
  return null;
}

function bannerHit(fires: string[], ctxRoot: string, agent: string): string | null {
  if (fires.length === 0) return null;
  const dense = densify(readTail(join(ctxRoot, 'logs', agent, 'stdout.log'), TAIL_BYTES));
  if (!dense) return null;
  const regions = bannerRegions(dense);
  for (const ts of fires) {
    const how = bannerReached(dense, ts, regions);
    if (how) return `stdout.log banner for ${ts} (${how}) — PTY arrival only, not processing`;
  }
  return null;
}

export interface FindReceiptOptions {
  agent: string;
  /** Cron whose fire we are looking for evidence of. */
  cron: string;
  /** Local date the fire was expected on, `YYYY-MM-DD`. */
  date: string;
  timezone: string;
  now: Date;
  /** Window for the declared-path shape, ms. Usually the expectation's `max_age`. */
  windowMs: number;
  declared?: ReceiptDeclaration;
  ctxRoot?: string;
  org?: string;
  instanceId?: string;
  /** Swapped in tests; see TaskSourceFn for why this seam is required rather than tidy. */
  taskSource?: TaskSourceFn;
}

/**
 * Try each shape in strength order and return the FIRST hit, plus which kind it was.
 *
 * Returning the kind is not decoration: a report that says "receipt found" without saying it was a
 * PTY banner overstates its evidence, and a banner proves arrival rather than processing.
 */
export function findReceipt(opts: FindReceiptOptions): ReceiptResult {
  const ctxRoot = opts.ctxRoot ?? process.env.CTX_ROOT;
  if (!ctxRoot) return { kind: 'NOT-CHECKED', evidence: 'CTX_ROOT unset' };

  const fromFile = receiptsFileHit(ctxRoot, opts.agent, opts.cron, opts.date, opts.timezone);
  if (fromFile) return { kind: 'receipts-file', evidence: fromFile };

  // Read once. Used to ANCHOR the task and banner shapes to a real fire, never as evidence itself.
  const fires = firedTimestamps(ctxRoot, opts.agent, opts.date, opts.cron, opts.timezone);

  const fromTask = busTaskHit(
    opts.agent,
    opts.cron,
    fires,
    opts.declared,
    opts.org,
    opts.instanceId ?? 'default',
    opts.taskSource ?? busTaskSource,
  );
  if (fromTask) return { kind: 'bus-task', evidence: fromTask };

  const fromPath = declaredPathHit(opts.declared, opts.now, opts.timezone, opts.windowMs);
  if (fromPath) return { kind: 'declared-path', evidence: fromPath };

  const fromBanner = bannerHit(fires, ctxRoot, opts.agent);
  if (fromBanner) return { kind: 'stdout-banner', evidence: fromBanner };

  return {
    kind: 'NONE',
    evidence:
      `no receipts-file entry, bus task, declared artifact or PTY banner for ` +
      `${opts.agent}/${opts.cron} on ${opts.date}`,
  };
}
