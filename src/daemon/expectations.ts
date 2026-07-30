/**
 * Per-agent expectation manifests — `orgs/<org>/agents/<agent>/expectations.json`.
 *
 * The premise of the whole harness: an agent cannot be the independent verifier of its own
 * artifacts. On 2026-07-29 vault_keeper's `check-context-save.sh` — which had known the exact
 * thresholds since Jun 22 — said nothing about a missing transcript, because the cron carrying it
 * was recorded `fired` in cron-execution.log and never reached the PTY. The detector was MUTE, not
 * late, and nothing notices when a detector does not run. A second detector inherits that property;
 * the only escape is that the checker and the checked fail independently.
 *
 * So the owning agent DECLARES what its surface should produce, and a cron on a different agent
 * evaluates the declaration. This module is the read side of that contract and is read-only to
 * every path that consumes it: manifests are authored by owners, never by the checker.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseDurationMs } from '../bus/cron-state.js';

export const EXPECTATIONS_FILENAME = 'expectations.json';

/** Fields every expectation carries, including the two the READER fills in. */
interface ExpectationCommon {
  id: string;
  /** Set by `readExpectations`, not by the manifest — findings must be self-describing. */
  agent: string;
  /**
   * Agent timezone, from the agent's own config.json. Set by the reader.
   *
   * Load-bearing: a `{YYYY-MM-DD}` artifact rolls over at LOCAL midnight, so resolving the stamp
   * in UTC flags a perfectly healthy artifact as missing for the 4-5 hours after local midnight on
   * this fleet. Same class of bug as the double conversion that had two chef crons firing four
   * hours late since June.
   */
  timezone: string;
  /**
   * Set when the author DECLARED an expectation without confirming the artifact exists yet.
   *
   * Exists because a wrong guess outperformed a careful question. seb_boss added an expectation
   * against a `cron-drift-receipt.jsonl` path he invented, left it failing rather than deleting it,
   * and that failure exposed a real bug — check-cron-drift emitted nothing on a clean run, so "ran,
   * fleet clean" was byte-identical on disk to "never fired". Asking first would have got the
   * truthful answer "there is no receipt", the expectation would have been removed, and the silent
   * detector would still be silent. So: declare it anyway and let it fail loudly.
   *
   * The flag is what keeps that habit from destroying the report. A speculative MISSING is a
   * possible NAMING error; a confirmed MISSING is a possible OUTAGE. Ranked and rendered together
   * they are indistinguishable, and eleven agents adopting the habit would bury every real finding
   * under invented paths — the identical cry-wolf failure the cron-drift exclusions exist to prevent.
   * Marked, they cost nothing and stay loud.
   *
   * A speculative expectation that PASSES has served its purpose and should lose the flag; the
   * report says so rather than leaving it marked provisional forever.
   */
  speculative?: boolean;
  /**
   * `YYYY-MM-DD` the speculative flag was added. Optional, and its ABSENCE is reported.
   *
   * Closes the asymmetry in the flag as first shipped: a passing speculative expectation was told to
   * promote itself, but a FAILING one had no shelf life at all. One failing for thirty days rendered
   * identically to one declared five minutes ago, so an unconfirmable guess became permanent failing
   * furniture — the provisional-marker-nobody-removes problem, reappearing on the branch I had not
   * covered. A guess is cheap because it is TEMPORARY; without a date nothing makes it temporary.
   */
  speculative_since?: string;
}

/**
 * Names the artifact that proves the RECEIVING side processed a fire.
 *
 * Deliberately a declaration and not a mandate. A STEP-0 `create-task`, a log write, an
 * `update-heartbeat` stamp and a `.cron-fire-receipts.jsonl` entry are ONE predicate: an artifact
 * only the receiving side can produce. Mandating one shape generates boilerplate and misses the
 * evidence already on disk — todoist_keeper already had full coverage on all three of their crons
 * in a shape nobody had asked them about. So the owner names which artifact counts for their cron
 * and the harness DISCOVERS it; see `findReceipt`.
 */
export interface ReceiptDeclaration {
  /** Cron whose fire this receipt evidences. */
  cron: string;
  /** Optional explicit artifact path (supports `{YYYY-MM-DD}`), tried after the receipts file. */
  path?: string;
  /** Optional bus-task title fragment, when the receipt is a STEP-0 task. */
  task_title_contains?: string;
}

export interface ArtifactFreshExpectation extends ExpectationCommon {
  type: 'artifact-fresh';
  /** Supports `{YYYY-MM-DD}`, substituted in `timezone` at evaluation time. No other templating. */
  path: string;
  /** Interval string (`26h`), parsed by the shared `parseDurationMs`. Cadence plus slack. */
  max_age: string;
  /** Floor below which a present artifact is THIN rather than FRESH. */
  min_bytes?: number;
  /** Non-blank, non-h1 lines. Mirrors vault_keeper's check-context-save.sh exactly. */
  min_body_lines?: number;
  receipt?: ReceiptDeclaration;
}

export interface PromptMatchesDocExpectation extends ExpectationCommon {
  type: 'prompt-matches-doc';
  cron: string;
  /** Doc that should be the single source of the policy text (reported, not diffed). */
  doc: string;
  /** Terms that must live ONLY in the doc. Presence in the live prompt is the primary gate. */
  inline_forbidden: string[];
  /**
   * Length above which forbidden terms read as PENDING-CONVERSION rather than DRIFT.
   *
   * Omitted means "this cron is already converted", so any forbidden term is DRIFT. That is the
   * loud direction on purpose: an author opts INTO the quiet state by declaring the threshold,
   * rather than getting it by forgetting a field.
   */
  max_prompt_chars?: number;
}

export type Expectation = ArtifactFreshExpectation | PromptMatchesDocExpectation;

/** A manifest entry that could not be used, kept so the coverage denominator stays honest. */
export interface ExpectationRejection {
  agent: string;
  id: string;
  reason: string;
}

export interface ReadExpectationsResult {
  expectations: Expectation[];
  rejected: ExpectationRejection[];
}

function readAgentTimezone(agentDir: string): string {
  try {
    const raw = JSON.parse(readFileSync(join(agentDir, 'config.json'), 'utf-8')) as {
      timezone?: unknown;
    };
    if (typeof raw.timezone === 'string' && raw.timezone.trim()) return raw.timezone.trim();
  } catch {
    /* fall through to the fleet default */
  }
  return process.env.CTX_TIMEZONE || 'America/New_York';
}

function validate(
  raw: Record<string, unknown>,
  agent: string,
  timezone: string,
): { ok: true; exp: Expectation } | { ok: false; reason: string } {
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!id) return { ok: false, reason: 'missing id' };

  if (raw.type === 'artifact-fresh') {
    if (typeof raw.path !== 'string' || !raw.path) return { ok: false, reason: 'missing path' };
    if (typeof raw.max_age !== 'string' || isNaN(parseDurationMs(raw.max_age))) {
      return { ok: false, reason: `max_age is not an interval: ${String(raw.max_age)}` };
    }
    const receipt =
      raw.receipt && typeof raw.receipt === 'object'
        ? (raw.receipt as ReceiptDeclaration)
        : undefined;
    if (receipt && typeof receipt.cron !== 'string') {
      return { ok: false, reason: 'receipt declared without a cron name' };
    }
    return {
      ok: true,
      exp: {
        id,
        agent,
        timezone,
        speculative: raw.speculative === true,
        speculative_since:
          typeof raw.speculative_since === 'string' ? raw.speculative_since : undefined,
        type: 'artifact-fresh',
        path: raw.path,
        max_age: raw.max_age,
        min_bytes: typeof raw.min_bytes === 'number' ? raw.min_bytes : undefined,
        min_body_lines: typeof raw.min_body_lines === 'number' ? raw.min_body_lines : undefined,
        receipt,
      },
    };
  }

  if (raw.type === 'prompt-matches-doc') {
    if (typeof raw.cron !== 'string' || !raw.cron) return { ok: false, reason: 'missing cron' };
    const forbidden = Array.isArray(raw.inline_forbidden)
      ? raw.inline_forbidden.filter((t): t is string => typeof t === 'string' && t.length > 0)
      : [];
    // An empty forbidden list can never fail, so it would sit in the numerator reporting CLEAN
    // forever — a check that cannot fail inflates coverage while measuring nothing.
    if (forbidden.length === 0) return { ok: false, reason: 'inline_forbidden is empty' };
    return {
      ok: true,
      exp: {
        id,
        agent,
        timezone,
        speculative: raw.speculative === true,
        speculative_since:
          typeof raw.speculative_since === 'string' ? raw.speculative_since : undefined,
        type: 'prompt-matches-doc',
        cron: raw.cron,
        doc: typeof raw.doc === 'string' ? raw.doc : '(unspecified)',
        inline_forbidden: forbidden,
        max_prompt_chars:
          typeof raw.max_prompt_chars === 'number' ? raw.max_prompt_chars : undefined,
      },
    };
  }

  return { ok: false, reason: `unknown type: ${String(raw.type)}` };
}

/**
 * Read one agent's manifest. Never throws.
 *
 * A missing manifest yields nothing, which is the normal state for an agent that has not opted in.
 * An unparseable one also yields nothing rather than aborting: this runs inside a fleet sweep, and
 * one malformed file must not take the other twelve agents' findings down with it.
 */
export function readExpectations(agentName: string, agentDir: string): ReadExpectationsResult {
  const manifestPath = join(agentDir, EXPECTATIONS_FILENAME);
  if (!existsSync(manifestPath)) return { expectations: [], rejected: [] };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    return {
      expectations: [],
      rejected: [{ agent: agentName, id: '(whole manifest)', reason: `unparseable: ${String(err)}` }],
    };
  }
  if (raw === null || typeof raw !== 'object') {
    return {
      expectations: [],
      rejected: [{ agent: agentName, id: '(whole manifest)', reason: 'not an object' }],
    };
  }
  const list = (raw as { expectations?: unknown }).expectations;
  if (!Array.isArray(list)) {
    return {
      expectations: [],
      rejected: [{ agent: agentName, id: '(whole manifest)', reason: 'no expectations array' }],
    };
  }

  const timezone = readAgentTimezone(agentDir);
  const expectations: Expectation[] = [];
  const rejected: ExpectationRejection[] = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') {
      rejected.push({ agent: agentName, id: '(anonymous)', reason: 'not an object' });
      continue;
    }
    const res = validate(entry as Record<string, unknown>, agentName, timezone);
    if (res.ok) expectations.push(res.exp);
    else
      rejected.push({
        agent: agentName,
        id: typeof (entry as { id?: unknown }).id === 'string'
          ? (entry as { id: string }).id
          : '(anonymous)',
        reason: res.reason,
      });
  }
  return { expectations, rejected };
}

/**
 * `YYYY-MM-DD` for an instant as seen in `timeZone`.
 *
 * Uses `formatToParts` rather than a locale that happens to emit ISO order, and deliberately not
 * `toISOString().slice(0,10)` — that is UTC and silently wrong for the hours either side of local
 * midnight, which is precisely the window a daily-artifact check runs in.
 */
export function localDateStamp(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Every path the template can legally resolve to inside the freshness window, newest local day
 * first.
 *
 * A dated artifact is not missing at 00:05 local just because today's file does not exist yet —
 * yesterday's is still inside a 26h budget. Checking only today's stamp would emit a MISSING every
 * night for the first hours of every day, which is how a real finding gets trained out of
 * existence. Undated templates return exactly one path, so nothing changes for them.
 */
export function resolveCandidatePaths(template: string, now: Date, timeZone: string, maxAgeMs: number): string[] {
  if (!template.includes('{YYYY-MM-DD}')) return [template];
  const seen = new Set<string>();
  const out: string[] = [];
  // One extra day past the window: a file written near the window edge still has a legal stamp.
  const days = Math.floor(maxAgeMs / 86_400_000) + 2;
  for (let d = 0; d < days; d++) {
    const stamp = localDateStamp(new Date(now.getTime() - d * 86_400_000), timeZone);
    if (seen.has(stamp)) continue;
    seen.add(stamp);
    out.push(template.replace(/\{YYYY-MM-DD\}/g, stamp));
  }
  return out;
}
