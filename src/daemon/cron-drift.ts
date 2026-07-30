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
import { listAgents } from '../bus/agents.js';
import { CRONS_DIRECTORY } from '../bus/crons-schema.js';
import { parseDurationMs } from '../bus/cron-state.js';
import type { CronDefinition, CronEntry } from '../types/index.js';

/**
 * Agents that are disabled in the roster, and therefore out of scope.
 *
 * A disabled agent does not boot, so its crons never fire, its migration never runs, and every
 * comparison this module makes has no consequence for it. If a retired agent is genuinely out of
 * scope then its findings were never findings — and a known-permanent row in a list people are
 * actively working from teaches them the list has residents.
 *
 * DETERMINABLE SIGNAL, NOT A HARDCODED NAME, so this fixes every future retirement rather than the
 * one line that prompted it (builder_2, retired 2026-07-07).
 *
 * EXTRACTED, NOT WRITTEN. `listAgents` already computes enabled state from
 * `config/enabled-agents.json` with the explicit-entry-wins precedence and the BUG-028 fix. A
 * second implementation here would be a copy that agrees today and diverges the first time that
 * precedence changes, with nothing comparing them.
 */
function disabledAgents(): Set<string> {
  const ctxRoot = process.env.CTX_ROOT;
  if (!ctxRoot) return new Set();
  try {
    return new Set(listAgents(ctxRoot).filter((a) => !a.enabled).map((a) => a.name));
  } catch {
    // Fail OPEN: an unreadable roster must not silently empty the report. Reporting a retired
    // agent's line is noise; suppressing a live agent's is a missed finding, and those costs are
    // not symmetric.
    return new Set();
  }
}

/**
 * The excluded set, surfaced so the exclusion is visible rather than silent.
 *
 * Scope narrowing is indistinguishable from a clean bill of health when it is not stated — the
 * same failure as a shrinking stated-time denominator. It also matters that re-enabling an agent
 * silently returns it to scope: a disabled agent holding crons.json with no `.crons-migrated`
 * marker is a wipe condition that ARMS on re-enable, and nothing would announce that.
 */
export function listExcludedRetiredAgents(): string[] {
  return [...disabledAgents()].sort();
}

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
  const retired = disabledAgents();
  const orgsBase = join(frameworkRoot, 'orgs');
  if (!existsSync(orgsBase)) return findings;

  for (const org of readdirSync(orgsBase, { withFileTypes: true })) {
    if (!org.isDirectory()) continue;
    const agentsBase = join(orgsBase, org.name, 'agents');
    if (!existsSync(agentsBase)) continue;

    for (const agent of readdirSync(agentsBase, { withFileTypes: true })) {
      if (!agent.isDirectory()) continue;
      if (retired.has(agent.name)) continue;
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
    if (retired.has(agentName)) continue;
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
function extractLocalHours(prompt: string): {
  stated: Array<{ hour: number; raw: string }>;
  disclaimed: number;
} {
  const stated: Array<{ hour: number; raw: string }> = [];
  let disclaimed = 0;
  const re = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b[^.\n]{0,20}?\b(ET|EST|EDT|local)\b/gi;
  for (const m of prompt.matchAll(re)) {
    let h = parseInt(m[1], 10);
    if (h < 1 || h > 12) continue;
    if (DISCLAIMED_BY.test(prompt.slice(Math.max(0, m.index - 40), m.index))) {
      disclaimed++;
      continue;
    }
    if (/pm/i.test(m[3]) && h !== 12) h += 12;
    if (/am/i.test(m[3]) && h === 12) h = 0;
    stated.push({ hour: h, raw: m[0].trim() });
  }
  return { stated, disclaimed };
}

function statedLocalHours(prompt: string): Array<{ hour: number; raw: string }> {
  return extractLocalHours(prompt).stated;
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
/**
 * Is the crons.json-wipe condition ASSEMBLED for this agent right now?
 *
 * Marker absent AND crons.json non-empty means the next boot silently overwrites every
 * runtime-added cron from config.json. Returns the cron names that would be lost, or null.
 *
 * TAKES ctxRoot EXPLICITLY so the CLI can call it. `readCrons` resolves CTX_ROOT from the
 * environment, which is set for agent sessions but not for a human running `cortextos start` in a
 * terminal — and the human at the enable prompt is precisely the caller this needs to reach.
 *
 * The crons read here is deliberately SHALLOW (does the file hold at least one cron), because the
 * question is existence, not validity. A corrupt crons.json is a different problem with its own
 * loud path in `readCronsWithStatus`, and treating it as "no crons" here would wrongly report the
 * condition as unarmed.
 */
export function wipeConditionArmed(agentName: string, ctxRoot: string): string[] | null {
  const agentStateDir = join(ctxRoot, CRONS_DIRECTORY, agentName);
  if (existsSync(join(agentStateDir, '.crons-migrated'))) return null;

  const cronsPath = join(agentStateDir, 'crons.json');
  if (!existsSync(cronsPath)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(cronsPath, 'utf-8'));
    const list = Array.isArray(raw) ? raw : (raw as { crons?: unknown })?.crons;
    if (!Array.isArray(list) || list.length === 0) return null;
    return list.map((c) => (c as { name?: string })?.name ?? '(unnamed)');
  } catch {
    // Unparseable but PRESENT. Migration would still overwrite it, so this is armed, not absent.
    return ['(crons.json present but unparseable)'];
  }
}

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
 *
 * `disclaimed` GUARDS THE OTHER DIRECTION, and it exists because this metric had a blind spot
 * pointed at good news. `statedLocalHours` is the shared subject-extractor for BOTH the finding
 * path and this coverage number, so a defect in it moves both:
 *
 *   - extractor UNDER-matches -> `stating` falls -> visible, which is what this function is for.
 *   - extractor OVER-matches  -> `stating` RISES -> reads as more crons documenting themselves,
 *     i.e. as improving health.
 *
 * The negation defect fixed on 2026-07-30 sat in the second direction: had it been active it would
 * have inflated this very number. A metric that only guards one direction is not half a guard, it
 * is a guard plus a blind spot aimed at the reassuring outcome. Counting disclaimed tokens makes an
 * over-matching extractor surface as a rising `disclaimed` rather than as a healthier `stating`.
 */
export function statedTimeCoverage(): {
  timeAnchored: number;
  stating: number;
  disclaimed: number;
  agents: string[];
} {
  let timeAnchored = 0;
  let stating = 0;
  let disclaimed = 0;
  const agents: string[] = [];
  for (const agentName of listStateAgents()) {
    try {
      for (const cron of readCrons(agentName)) {
        if (cron.schedule.trim().split(/\s+/).length !== 5) continue;
        timeAnchored++;
        const { stated, disclaimed: d } = extractLocalHours(cron.prompt ?? '');
        disclaimed += d;
        if (stated.length > 0) {
          stating++;
          if (!agents.includes(agentName)) agents.push(agentName);
        }
      }
    } catch { /* skip */ }
  }
  return { timeAnchored, stating, disclaimed, agents };
}

/**
 * Kinds where BOTH sides of the comparison are authoritative — the live scheduler against itself,
 * or against the prompt it actually injects. These are events: something is wrong right now.
 */
const LIVE_VS_LIVE: ReadonlySet<CronDriftKind> = new Set<CronDriftKind>([
  'marker-missing',
  'schedule-contradicts-prompt',
]);

/**
 * Explainer text, printed ONLY when its kind has findings.
 *
 * Previously every explainer printed on every run. On a clean fleet that put the two lines naming
 * the dangerous classes at the bottom of 33 non-actions, every 6 hours — so when one of them
 * finally fires it arrives looking exactly like the noise the reader has been skimming past for
 * weeks. An explainer that prints at zero findings trains the reader to skip the line where the
 * real finding will appear.
 */
const KIND_EXPLAINER: Record<CronDriftKind, string> = {
  'marker-missing':
    'marker-missing is the assembled trigger for a full crons.json wipe on next boot — fix first.',
  'schedule-contradicts-prompt':
    'schedule-contradicts-prompt: the prompt states a time the cron does not fire at (double conversion).',
  // Deliberately does NOT say "so it never fires", which contradicts the block header and is only
  // half true. The two readings have opposite meanings and only the owner can tell them apart —
  // which is precisely why this is reported rather than auto-resolved or suppressed.
  'missing-live':
    'missing-live: config.json names a cron with no live counterpart. EITHER it was deliberately ' +
    'superseded and the entry is stale (delete it from config.json), OR someone added it to ' +
    'config.json expecting it to fire and it never did (re-add with `bus add-cron`). Owner decides.',
  'interval-mismatch':
    'interval-mismatch: config.json and the live scheduler disagree on the rate. The live value ' +
    'wins. Correct config.json, or change the live one with `bus update-cron`.',
  'prompt-differs':
    'prompt-differs: the live prompt was improved while config.json stayed frozen. Usually correct.',
};

/**
 * One-line-per-finding summary, used by the CLI and by the consolidated bus message.
 *
 * SPLIT BY WHETHER THE COMPARISON HAS A LIVE SOURCE OF TRUTH ON BOTH SIDES, because that split is
 * the detector's premise rather than a presentation choice. `config.json` stopped being read by
 * anything on 2026-06-03, when the `.crons-migrated` marker was written. After that, config-vs-live
 * divergence is the DEFAULT STATE and convergence is the anomaly — so those kinds describe a
 * CONDITION, while the live-vs-live kinds describe an EVENT.
 *
 * Measured on the live fleet 2026-07-30T14:26Z: 33 config-vs-live findings, 0 live-vs-live. Every
 * real finding this detector has ever produced (chef's two double-converted schedules, three
 * runtime authoring errors, the wipe trigger) came from the kinds that were silent that day.
 * Reporting a condition every six hours in the same block as an event is how the event gets
 * trained out of existence.
 */
export function formatDriftFindings(findings: CronDriftFinding[]): string {
  if (findings.length === 0) {
    return 'config.json and the live scheduler agree everywhere they can be compared.';
  }

  const sorted = [...findings].sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.agent.localeCompare(b.agent),
  );
  const line = (f: CronDriftFinding) =>
    `  ${f.agent}/${f.cron}  ${f.kind}: config=${f.configValue} live=${f.liveValue}`;

  const liveVsLive = sorted.filter((f) => LIVE_VS_LIVE.has(f.kind));
  // prompt-differs is demoted to a count: 21 of 33 on the day this was written, structurally the
  // expected state, and the mildest kind. The COUNT is kept rather than the kind dropped — a sudden
  // jump means someone is bulk-editing config.json expecting it to take effect, which is the
  // original eight-week failure. `--json` still emits every finding for anyone doing the cleanup.
  const configVsLive = sorted.filter((f) => !LIVE_VS_LIVE.has(f.kind) && f.kind !== 'prompt-differs');
  const promptDiffers = sorted.filter((f) => f.kind === 'prompt-differs');

  const out: string[] = [];
  const kindsShown = new Set<CronDriftKind>();

  if (liveVsLive.length > 0) {
    out.push(`${liveVsLive.length} LIVE finding(s) — both sides authoritative, act on these:`);
    for (const f of liveVsLive) {
      out.push(line(f));
      kindsShown.add(f.kind);
    }
    out.push('');
  }

  if (configVsLive.length > 0 || promptDiffers.length > 0) {
    // "disagrees" rather than the previous "config.json cron edit(s) that are NOT in effect".
    // Most of these were never edited — the LIVE side diverged from them, which is the opposite
    // direction. A narrated causal claim in the header of a report about narrated-vs-measured.
    out.push(
      `${configVsLive.length + promptDiffers.length} place(s) where config.json disagrees with the ` +
        `live scheduler (config.json is dead text after the .crons-migrated marker, so EDITING IT ` +
        `changes nothing that runs — but a missing-live entry may be a cron someone intended and ` +
        `never got):`,
    );
    for (const f of configVsLive) {
      out.push(line(f));
      kindsShown.add(f.kind);
    }
    if (promptDiffers.length > 0) {
      out.push(
        `  ${promptDiffers.length} prompt-differs not listed — a live prompt improved while ` +
          `config.json stayed frozen is the norm, not an event. Use --json for the full list.`,
      );
    }
    out.push('');
  }

  // Each explainer names its own action, so the old generic trailer
  // ("Fix with: bus update-cron ...") is gone — it was wrong for missing-live, where the cron does
  // not exist to update.
  for (const kind of Object.keys(KIND_ORDER) as CronDriftKind[]) {
    if (kindsShown.has(kind)) out.push(KIND_EXPLAINER[kind]);
  }

  return out.join('\n');
}
