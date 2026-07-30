/**
 * Detect config.json cron edits that silently did nothing.
 *
 * The daemon reads ONLY crons.json (src/daemon/cron-scheduler.ts -> readCronsWithStatus).
 * config.json crons are read in exactly one place — cron-migration.ts — and that read is
 * gated on the `.crons-migrated` marker. Once an agent is migrated, every subsequent edit
 * to `config.json.crons` is dead text: it parses, it looks applied, and nothing schedules it.
 *
 * That cost eight weeks of invisible breakage across this fleet (2026-07-30 audit): a
 * heartbeat running a role prompt three weeks stale, an RAM-telemetry cron that never fired
 * once, and an atlas freshness check with zero fires in its whole log.
 *
 * What this module deliberately does NOT report, because both were verified false positives
 * before the detector existed:
 *
 *  1. LIVE-ONLY crons — present in crons.json, absent from config.json. These are the normal
 *     result of `bus add-cron` at runtime and are the MAJORITY (≈75 of 109 mismatches on the
 *     fleet at the time of writing). Warning on them buries the real findings.
 *  2. Cron-EXPRESSION schedules. Migration normalises local time to UTC, so every single
 *     expression pair on this fleet differed by exactly the timezone offset (+4h, ET→UTC) and
 *     was correct. Comparing them would have cried wolf on 15 correct entries on day one.
 *     Handled structurally rather than by special-casing timezones: schedules are only
 *     compared when BOTH sides parse as a duration (parseDurationMs returns NaN for a cron
 *     expression), so expressions are never compared at all.
 *
 * A detector that fires on 90 correct entries gets ignored by week two, which puts us back
 * where we started with extra steps.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { readCrons } from '../bus/crons.js';
import { CRONS_DIRECTORY } from '../bus/crons-schema.js';
import { parseDurationMs } from '../bus/cron-state.js';
import type { CronDefinition, CronEntry } from '../types/index.js';

export type CronDriftKind =
  /**
   * The `.crons-migrated` marker is absent while crons.json holds live crons — the assembled
   * trigger for the boot-time overwrite that wipes every runtime-added cron. Agent-level, not
   * per-cron. This exists because the real guard lives in the daemon, which holds its own
   * bundle: the guard is inert until the next daemon restart, and this check covers exactly
   * that window from the CLI, which is live on build.
   */
  | 'marker-missing'
  /**
   * The prompt states an intended wall-clock local time and the live schedule fires at a
   * different one. This exists because a uniform offset cannot tell a correct timezone
   * normalisation apart from a DOUBLE conversion of a value that was already UTC — and the
   * arithmetic fallback has a fixed point exactly where the bug lives (a +4h double conversion
   * of 12:00 UTC lands the local hour back on the config literal 12). Only a human-written
   * "8:30am ET" in the prompt breaks that tie. Found 2026-07-30: two chef crons had been firing
   * four hours late since the 06-03 migration, with their own prompts stating the correct time.
   *
   * WHY CARE IS NOT A MITIGATION FOR THIS CLASS. One of the five findings read
   * `Friday 12pm ET (16:00 UTC)` in its prompt while its schedule said hour 20. The CORRECT UTC
   * value was sitting two characters from the wrong one, and its author did not see it — because
   * nothing forces the comparison. So this is not an argument that people should read more
   * carefully; it is evidence that reading more carefully would not have worked. An automated
   * comparison is the only thing that catches a contradiction a human eye slides past.
   *
   * It is also not a historical cleanup. Three of the five were authored at RUNTIME, one of them
   * minutes before this check first ran — a local hour typed into a UTC field is a mistake the
   * fleet is still actively making.
   */
  | 'schedule-contradicts-prompt'
  /** config.json names a cron that has no counterpart in crons.json — it will never fire. */
  | 'missing-live'
  /** Both sides use an interval (not a cron expression) and they disagree. */
  | 'interval-mismatch'
  /** Names match but the prompt text differs — the agent is running stale instructions. */
  | 'prompt-differs';

export interface CronDriftFinding {
  agent: string;
  cron: string;
  kind: CronDriftKind;
  /** What config.json says (the value someone edited expecting it to take effect). */
  configValue: string;
  /** What crons.json says, i.e. what actually runs. `(absent)` for missing-live. */
  liveValue: string;
}

/**
 * Mirror of convertEntry()'s skip rules in cron-migration.ts.
 *
 * Migration deliberately declines to convert one-shot (`type: "once"`) entries and any entry
 * missing a schedule or a prompt. Those absences are intended behaviour, not drift, so
 * reporting them would be noise about a documented non-feature. Zero such entries exist on
 * this fleet today; this exists so that stays true if one appears.
 */
function isUnmigratable(entry: CronEntry): boolean {
  const type = entry.type ?? 'recurring';
  if (type === 'once') return true;
  const schedule = entry.cron ?? entry.interval;
  if (!schedule) return true;
  if (type !== 'disabled' && !entry.prompt) return true;
  return false;
}

/** Schedule precedence, matching convertEntry(): a cron expression wins over an interval. */
function configSchedule(entry: CronEntry): string | undefined {
  return entry.cron ?? entry.interval;
}

function readConfigCrons(configJsonPath: string): CronEntry[] {
  if (!existsSync(configJsonPath)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configJsonPath, 'utf-8'));
  } catch {
    // An unparseable config.json is a different problem with its own loud path in migration.
    return [];
  }
  if (raw === null || typeof raw !== 'object') return [];
  const crons = (raw as { crons?: unknown }).crons;
  return Array.isArray(crons) ? (crons as CronEntry[]) : [];
}

/**
 * Compare one agent's config.json crons against the crons.json the daemon actually reads.
 *
 * Reads crons.json via `readCrons`, which resolves CTX_ROOT from the environment — the same
 * path resolution the scheduler uses, so this cannot disagree with the daemon about where
 * the live file is. (Two code paths computing that path independently is how the wrong path
 * ended up in every doc in the first place.)
 */
export function detectConfigCronDrift(
  agentName: string,
  configJsonPath: string,
  liveCronsOverride?: CronDefinition[],
): CronDriftFinding[] {
  const configCrons = readConfigCrons(configJsonPath);
  if (configCrons.length === 0) return [];

  const live = liveCronsOverride ?? readCrons(agentName);
  const liveByName = new Map(live.map((c) => [c.name, c]));
  const findings: CronDriftFinding[] = [];

  for (const entry of configCrons) {
    if (!entry || typeof entry.name !== 'string') continue;
    if (isUnmigratable(entry)) continue;

    const cfgSchedule = configSchedule(entry) ?? '';
    const liveCron = liveByName.get(entry.name);

    if (!liveCron) {
      findings.push({
        agent: agentName,
        cron: entry.name,
        kind: 'missing-live',
        configValue: cfgSchedule,
        liveValue: '(absent)',
      });
      continue;
    }

    // Only compare durations. parseDurationMs returns NaN for a cron expression, which is
    // what keeps timezone-normalised expressions out of the results entirely.
    const cfgMs = parseDurationMs(cfgSchedule);
    const liveMs = parseDurationMs(liveCron.schedule);
    if (!isNaN(cfgMs) && !isNaN(liveMs) && cfgMs !== liveMs) {
      findings.push({
        agent: agentName,
        cron: entry.name,
        kind: 'interval-mismatch',
        configValue: cfgSchedule,
        liveValue: liveCron.schedule,
      });
    }

    const cfgPrompt = (entry.prompt ?? '').trim();
    const livePrompt = (liveCron.prompt ?? '').trim();
    if (cfgPrompt && cfgPrompt !== livePrompt) {
      findings.push({
        agent: agentName,
        cron: entry.name,
        kind: 'prompt-differs',
        configValue: `${cfgPrompt.length} chars`,
        liveValue: `${livePrompt.length} chars`,
      });
    }
  }

  return findings;
}

/**
 * Run the drift check for every agent found on disk.
 *
 * Fleet-wide or nothing: one agent's config.json cleaned while thirteen stay stale is worse
 * than uniformly dead, because it makes the file look trustworthy in one place.
 */
export function sweepConfigCronDrift(frameworkRoot: string): CronDriftFinding[] {
  const findings: CronDriftFinding[] = [];
  const orgsBase = join(frameworkRoot, 'orgs');
  if (!existsSync(orgsBase)) return findings;

  for (const org of readdirSync(orgsBase, { withFileTypes: true })) {
    if (!org.isDirectory()) continue;
    const agentsBase = join(orgsBase, org.name, 'agents');
    if (!existsSync(agentsBase)) continue;

    for (const agent of readdirSync(agentsBase, { withFileTypes: true })) {
      if (!agent.isDirectory()) continue;
      const configPath = join(agentsBase, agent.name, 'config.json');
      if (!existsSync(configPath)) continue;
      try {
        findings.push(...detectConfigCronDrift(agent.name, configPath));
      } catch {
        // One unreadable agent must not abort the sweep — a partial fleet report is still
        // worth having, and a thrown sweep reports nothing at all.
      }
    }
  }

  // Marker findings are swept from the STATE dir, not from orgs/. The two enumerations are
  // NOT the same set: this fleet has two agents (scratch/test) that exist only under
  // {CTX_ROOT}/.cortextOS/state/agents and have no orgs/ directory at all. Sweeping orgs/
  // for a marker that lives in the state dir would have reported "no marker problems
  // fleet-wide" while being structurally unable to see the only two agents missing one.
  for (const agentName of listStateAgents()) {
    try {
      findings.push(...detectMissingMigrationMarker(agentName));
      findings.push(...detectScheduleContradictsPrompt(agentName));
    } catch { /* one agent must not abort the sweep */ }
  }

  return findings;
}


/**
 * A time token is DISCLAIMED when a negator governs it in the same clause: "not 8am ET",
 * "fires 7am ET rather than 9am ET", "never 5am ET". The window is deliberately short and
 * stops at any sentence terminator, so a `not` in a previous sentence cannot reach forward
 * and silently delete a real claim — which would shrink the denominator invisibly, the exact
 * failure `statedTimeCoverage` exists to make visible.
 */
const DISCLAIMED_BY =
  /\b(?:not|never|rather than|instead of|no longer|isn't|is not|wasn't|won't)\b[^.!?\n]*$/i;

/**
 * Times a prompt states about itself, e.g. "Sunday 8:30am ET", "fires at 7am ET".
 * Only local-timezone claims are matched; a prompt saying "09:00 UTC" is already unambiguous.
 *
 * NEGATION IS EXCLUDED, and the reason generalises past this function. A matcher over prose
 * fires on prose ABOUT the thing as readily as on the thing, so the better an author documents
 * WHY a value is right, the likelier they are to trip the check that it is wrong. chef's
 * sunday-grocery prompt records "12pm ET Sunday — confirmed deliberate ..., not 8am": the
 * correct claim and its rejected alternative, one clause apart. Third instance of this shape on
 * 2026-07-30 (two hold-verify matchers fired on text documenting a convention and a decision).
 *
 * MEASURED BOUNDARY, because the motivating instance does NOT actually trip this. chef's
 * negated "8am" carries no timezone suffix, so the pattern above never sees it — live extraction
 * on that prompt yields exactly ["12pm ET"], verified against the real crons.json. Adding two
 * characters ("not 8am ET") makes it fire. So this guard is LATENT HARDENING: 0 of 94
 * time-anchored fleet crons are affected today. It is worth having anyway precisely because the
 * trigger is good documentation, which is the thing we keep asking agents for.
 *
 * The alternative fix considered and REJECTED — "treat the FIRST stated time as the claim" —
 * handles chef's ordering and fails on the equally natural "not 8am ET, but 12pm ET". A negator
 * lookback is order-independent, so it subsumes the positional rule rather than complementing it.
 */
function statedLocalHours(prompt: string): Array<{ hour: number; raw: string }> {
  const out: Array<{ hour: number; raw: string }> = [];
  const re = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b[^.\n]{0,20}?\b(ET|EST|EDT|local)\b/gi;
  for (const m of prompt.matchAll(re)) {
    let h = parseInt(m[1], 10);
    if (h < 1 || h > 12) continue;
    if (DISCLAIMED_BY.test(prompt.slice(Math.max(0, m.index - 40), m.index))) continue;
    if (/pm/i.test(m[3]) && h !== 12) h += 12;
    if (/am/i.test(m[3]) && h === 12) h = 0;
    out.push({ hour: h, raw: m[0].trim() });
  }
  return out;
}

/** Current UTC-to-local offset in whole hours for the agent timezone (DST-aware). */
function localOffsetHours(timeZone: string): number {
  const now = new Date();
  const local = new Date(now.toLocaleString('en-US', { timeZone }));
  const utc = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
  return Math.round((local.getTime() - utc.getTime()) / 3_600_000);
}

/**
 * Flag any live cron whose prompt states an intended local wall-clock hour that the schedule
 * does not fire at. Silent when the prompt states no time — an absent claim is not a
 * contradiction, and inventing an expectation is how a detector starts crying wolf.
 */
export function detectScheduleContradictsPrompt(
  agentName: string,
  liveCronsOverride?: CronDefinition[],
  timeZoneOverride?: string,
): CronDriftFinding[] {
  const tz = timeZoneOverride ?? process.env.CTX_TIMEZONE ?? 'America/New_York';
  let offset: number;
  try {
    offset = localOffsetHours(tz);
  } catch {
    return [];
  }

  const live = liveCronsOverride ?? readCrons(agentName);
  const findings: CronDriftFinding[] = [];

  for (const cron of live) {
    const parts = cron.schedule.trim().split(/\s+/);
    if (parts.length !== 5) continue; // interval crons have no wall-clock time to contradict
    const stated = statedLocalHours(cron.prompt ?? '');
    if (stated.length === 0) continue;

    const localHours = parts[1]
      .split(',')
      .map((h) => parseInt(h, 10))
      .filter((h) => !isNaN(h))
      .map((h) => ((h + offset) % 24 + 24) % 24);
    if (localHours.length === 0) continue;
    if (stated.some((s) => localHours.includes(s.hour))) continue;

    findings.push({
      agent: agentName,
      cron: cron.name,
      kind: 'schedule-contradicts-prompt',
      configValue: `prompt says ${stated.map((s) => s.raw).join('; ')}`,
      liveValue: `fires ${cron.schedule} = ${localHours.join(',')}:00 ${tz}`,
    });
  }

  return findings;
}

/** Agents that have a state directory, which is where the marker and crons.json actually live. */
function listStateAgents(): string[] {
  const ctxRoot = process.env.CTX_ROOT;
  if (!ctxRoot) return [];
  const base = join(ctxRoot, CRONS_DIRECTORY);
  if (!existsSync(base)) return [];
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * Flag an agent whose `.crons-migrated` marker is gone while crons.json still holds crons.
 *
 * BOTH conditions are required, and reporting only the assembled pair is deliberate. A missing
 * marker on an agent with no crons.json is harmless — migration would write from config.json,
 * which is what it is for. Two such agents exist on this fleet right now (scratch/test agents),
 * and reporting them would put two permanent entries at the top of a daily report, which is how
 * a real finding gets trained out of existence. They are surfaced as a count in the footer
 * instead, because the latent state is worth knowing: it proves marker-absence occurs here
 * naturally rather than needing an exotic trigger, so one runtime `add-cron` on either of them
 * assembles the full condition by accident.
 */
export function detectMissingMigrationMarker(agentName: string): CronDriftFinding[] {
  const ctxRoot = process.env.CTX_ROOT;
  if (!ctxRoot) return [];
  const agentStateDir = join(ctxRoot, CRONS_DIRECTORY, agentName);
  if (existsSync(join(agentStateDir, '.crons-migrated'))) return [];

  const live = readCrons(agentName);
  if (live.length === 0) return [];

  return [
    {
      agent: agentName,
      cron: '(agent-level)',
      kind: 'marker-missing',
      configValue: 'marker absent',
      liveValue: `${live.length} live cron(s) would be overwritten: ${live.map((c) => c.name).join(', ')}`,
    },
  ];
}

/** Agents in the marker-absent-but-harmless state: worth counting, not worth listing daily. */
export function countLatentMarkerAbsent(): string[] {
  const ctxRoot = process.env.CTX_ROOT;
  if (!ctxRoot) return [];
  const latent: string[] = [];
  for (const agentName of listStateAgents()) {
    if (existsSync(join(ctxRoot, CRONS_DIRECTORY, agentName, '.crons-migrated'))) continue;
    try {
      if (readCrons(agentName).length === 0) latent.push(agentName);
    } catch { /* skip */ }
  }
  return latent;
}

/**
 * Severity order, most actionable first.
 *
 * `missing-live` means a cron never fires at all — that is an outage. `interval-mismatch` means
 * it fires at the wrong rate. `prompt-differs` is real but usually the mildest, and on the live
 * fleet it is also the most numerous (18 of 30 at time of writing, several differing by under
 * ten characters). Unsorted, the loudest category is the least urgent one, and the crons that
 * never fire scroll off the top.
 */
const KIND_ORDER: Record<CronDriftKind, number> = {
  'marker-missing': 0,
  'schedule-contradicts-prompt': 1,
  'missing-live': 2,
  'interval-mismatch': 3,
  'prompt-differs': 4,
};


/**
 * Coverage for the stated-time check, reported explicitly and for a reason.
 *
 * The check has a silent-degradation mode: an agent tidying its prompt — replacing a hardcoded
 * "8am ET" with a pointer to a doc — removes the check SUBJECT, and coverage drops with no error.
 * A shrinking denominator looks identical to a clean bill of health. This nearly happened within
 * an hour of the check being commissioned: chef replaced the very stated time that had exposed the
 * bug this check exists to catch.
 *
 * So "0 findings" is not an honest report. "10 of 14 time-anchored crons state a time, 10 match"
 * is. A DROP in `stating` between runs is itself a finding.
 */
export function statedTimeCoverage(): { timeAnchored: number; stating: number; agents: string[] } {
  let timeAnchored = 0;
  let stating = 0;
  const agents: string[] = [];
  for (const agentName of listStateAgents()) {
    try {
      for (const cron of readCrons(agentName)) {
        if (cron.schedule.trim().split(/\s+/).length !== 5) continue;
        timeAnchored++;
        if (statedLocalHours(cron.prompt ?? '').length > 0) {
          stating++;
          if (!agents.includes(agentName)) agents.push(agentName);
        }
      }
    } catch { /* skip */ }
  }
  return { timeAnchored, stating, agents };
}

/** One-line-per-finding summary, used by the CLI and by the consolidated bus message. */
export function formatDriftFindings(findings: CronDriftFinding[]): string {
  if (findings.length === 0) return 'No config.json cron drift found.';

  const sorted = [...findings].sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.agent.localeCompare(b.agent),
  );
  const counts = sorted.reduce<Record<string, number>>((acc, f) => {
    acc[f.kind] = (acc[f.kind] ?? 0) + 1;
    return acc;
  }, {});

  const lines = sorted.map(
    (f) => `  ${f.agent}/${f.cron}  ${f.kind}: config=${f.configValue} live=${f.liveValue}`,
  );
  return [
    `${findings.length} config.json cron edit(s) that are NOT in effect ` +
      `(${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ')}):`,
    ...lines,
    '',
    'marker-missing is the assembled trigger for a full crons.json wipe on next boot — fix first.',
    'schedule-contradicts-prompt: the prompt states a time the cron does not fire at (double conversion).',
    'config.json crons are dead text after the .crons-migrated marker is written.',
    'missing-live means that cron never fires at all.',
    'Fix with: cortextos bus update-cron <agent> <cron> --interval <i> --prompt "<p>"',
  ].join('\n');
}
