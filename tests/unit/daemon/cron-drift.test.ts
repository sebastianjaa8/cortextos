/**
 * tests/unit/daemon/cron-drift.test.ts
 *
 * Covers two things found by the 2026-07-30 fleet cron audit:
 *
 *  1. cron-drift.ts — config.json cron edits that silently did nothing, WITH the two
 *     exclusions that keep it from crying wolf (live-only crons, timezone-normalised cron
 *     expressions). The exclusion tests matter more than the detection tests: the detector
 *     is easy, and a detector that reports 90 correct entries is worse than none.
 *
 *  2. cron-migration.ts — the pre-overwrite snapshot on the one boot-time write that can wipe
 *     every runtime-added cron (marker absent while crons.json holds live crons).
 *
 * Real temp dirs, no fs mocking: the snapshot behaviour IS filesystem behaviour, and a mocked
 * writeFileSync would let an assertion pass while no file existed — the exact failure the
 * snapshot verification is there to prevent.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Swappable per-test so the abort branch is reachable without depending on the OS refusing a
// write. Defaults to the real implementation, so the happy-path tests exercise real file I/O.
let snapshotImpl: ((livePath: string, snapshotPath: string) => boolean) | null = null;
vi.mock('../../../src/daemon/cron-snapshot.js', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../../../src/daemon/cron-snapshot.js');
  return {
    snapshotLiveCrons: (livePath: string, snapshotPath: string) =>
      (snapshotImpl ?? actual.snapshotLiveCrons)(livePath, snapshotPath),
  };
});

import { detectConfigCronDrift, detectMissingMigrationMarker, detectScheduleContradictsPrompt, formatDriftFindings, sweepConfigCronDrift, listExcludedRetiredAgents } from '../../../src/daemon/cron-drift.js';
import type { CronDriftFinding } from '../../../src/daemon/cron-drift.js';
import { migrateCronsForAgent } from '../../../src/daemon/cron-migration.js';
import { CRONS_DIRECTORY } from '../../../src/bus/crons-schema.js';
import type { CronDefinition } from '../../../src/types/index.js';

const AGENT = 'test-drift-agent';

let tmp: string;
let configPath: string;
let prevCtxRoot: string | undefined;

function writeConfig(crons: unknown[]): void {
  writeFileSync(configPath, JSON.stringify({ agent_name: AGENT, crons }, null, 2), 'utf-8');
}

function live(over: Partial<CronDefinition> = {}): CronDefinition {
  return {
    name: 'heartbeat',
    prompt: 'do the heartbeat',
    schedule: '2h',
    enabled: true,
    created_at: '2026-06-03T00:00:00Z',
    ...over,
  } as CronDefinition;
}

beforeEach(() => {
  snapshotImpl = null;
  tmp = mkdtempSync(join(tmpdir(), "cron-drift-"));
  configPath = join(tmp, 'config.json');
  prevCtxRoot = process.env.CTX_ROOT;
  process.env.CTX_ROOT = tmp;
});

afterEach(() => {
  if (prevCtxRoot === undefined) delete process.env.CTX_ROOT;
  else process.env.CTX_ROOT = prevCtxRoot;
  rmSync(tmp, { recursive: true, force: true });
});

describe('detectConfigCronDrift', () => {
  it('reports a config.json cron with no live counterpart — it will never fire', () => {
    writeConfig([{ name: 'db-freshness-check', interval: '24h', prompt: 'check' }]);
    const findings = detectConfigCronDrift(AGENT, configPath, []);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ cron: 'db-freshness-check', kind: 'missing-live' });
  });

  it('reports an interval mismatch (the 2h-vs-4h case)', () => {
    writeConfig([{ name: 'heartbeat', interval: '2h', prompt: 'do the heartbeat' }]);
    const findings = detectConfigCronDrift(AGENT, configPath, [live({ schedule: '4h' })]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'interval-mismatch',
      configValue: '2h',
      liveValue: '4h',
    });
  });

  it('reports a prompt difference — the stale-role-instructions case', () => {
    writeConfig([{ name: 'heartbeat', interval: '2h', prompt: 'NEW role text, adversarial review' }]);
    const findings = detectConfigCronDrift(AGENT, configPath, [live({ prompt: 'old role text' })]);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('prompt-differs');
  });

  it('finds nothing when config.json and crons.json agree', () => {
    writeConfig([{ name: 'heartbeat', interval: '2h', prompt: 'do the heartbeat' }]);
    expect(detectConfigCronDrift(AGENT, configPath, [live()])).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Exclusions. These are the tests that make the detector usable.
  // ---------------------------------------------------------------------------

  it('EXCLUSION: does not report a live-only cron (added at runtime via bus add-cron)', () => {
    writeConfig([]);
    const findings = detectConfigCronDrift(AGENT, configPath, [
      live({ name: 'unified-watchdog', schedule: '*/30 * * * *' }),
    ]);
    expect(findings).toEqual([]);
  });

  it('EXCLUSION: does not compare cron expressions — a +4h ET-to-UTC pair is not drift', () => {
    // Every expression pair on the real fleet differed by exactly the timezone offset and was
    // correct. Comparing them would have produced 15 false findings on day one.
    writeConfig([{ name: 'morning-brief', cron: '0 7 * * *', prompt: 'brief' }]);
    const findings = detectConfigCronDrift(AGENT, configPath, [
      live({ name: 'morning-brief', schedule: '0 11 * * *', prompt: 'brief' }),
    ]);
    expect(findings).toEqual([]);
  });

  it('EXCLUSION: does not report a one-shot config entry that migration declines to convert', () => {
    writeConfig([{ name: 'one-off', type: 'once', fire_at: '2026-12-01T00:00:00Z', prompt: 'x' }]);
    expect(detectConfigCronDrift(AGENT, configPath, [])).toEqual([]);
  });

  it('a cron expression on one side and an interval on the other is still not compared', () => {
    // Mixed forms cannot be compared without reimplementing cron semantics, and guessing is
    // how a false positive gets shipped. Presence is still checked; the schedule is not.
    writeConfig([{ name: 'heartbeat', cron: '0 */4 * * *', prompt: 'do the heartbeat' }]);
    const findings = detectConfigCronDrift(AGENT, configPath, [live({ schedule: '4h' })]);
    expect(findings.filter((f) => f.kind === 'interval-mismatch')).toEqual([]);
  });
});

describe('cron-migration pre-overwrite snapshot', () => {
  const stateDir = () => join(tmp, CRONS_DIRECTORY, AGENT);
  const cronsPath = () => join(stateDir(), 'crons.json');

  function seedLiveCronsWithoutMarker(): void {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(
      cronsPath(),
      JSON.stringify(
        { updated_at: '2026-07-30T00:00:00Z', crons: [live({ name: 'unified-watchdog', schedule: '30m' })] },
        null,
        2,
      ),
      'utf-8',
    );
    // Deliberately NO .crons-migrated marker — this is the disaster precondition.
  }

  it('snapshots live crons.json before overwriting it, and escalates', () => {
    seedLiveCronsWithoutMarker();
    writeConfig([{ name: 'heartbeat', interval: '2h', prompt: 'from config' }]);

    const criticals: string[] = [];
    const result = migrateCronsForAgent(AGENT, configPath, tmp, {
      log: () => {},
      onCritical: (msg) => criticals.push(msg),
    });

    expect(result.status).toBe('migrated');
    expect(criticals).toHaveLength(1);
    expect(criticals[0]).toContain('unified-watchdog');

    const snapshots = readdirSync(stateDir()).filter((f) => f.includes('.pre-migration-'));
    expect(snapshots).toHaveLength(1);

    // The snapshot must hold the PRE-change bytes. A snapshot equal to the post-change file
    // is proof it did not work — worse than none, because it reads as safe.
    const snapshot = readFileSync(join(stateDir(), snapshots[0]), 'utf-8');
    expect(snapshot).toContain('unified-watchdog');
    expect(readFileSync(cronsPath(), 'utf-8')).not.toContain('unified-watchdog');
  });

  // Two cases, because "the snapshot did not work" arrives in two different shapes and only
  // one of them is an exception. The first version of this test tried to block the write with
  // chmod on the directory, which Windows ignores — it silently stopped exercising the abort
  // path and passed anyway. Mocking the snapshot module makes both shapes reachable on any
  // platform, which is why that module exists.
  it.each([
    ['returns false without throwing', false, undefined],
    ['throws', undefined, new Error('EROFS: read-only file system')],
  ])(
    'ABORTS the migration when the snapshot %s, leaving live crons intact',
    async (_label, returnValue, thrown) => {
      seedLiveCronsWithoutMarker();
      writeConfig([{ name: 'heartbeat', interval: '2h', prompt: 'from config' }]);
      const before = readFileSync(cronsPath(), 'utf-8');

      snapshotImpl = () => {
        if (thrown) throw thrown;
        return returnValue as boolean;
      };

      const { migrateCronsForAgent: migrate } = await import('../../../src/daemon/cron-migration.js');
      const criticals: Array<Record<string, unknown>> = [];
      const result = migrate(AGENT, configPath, tmp, {
        log: () => {},
        onCritical: (_m, meta) => criticals.push(meta),
      });

      expect(criticals[0]?.reason).toBe('snapshot-unverified');
      expect(result.status).not.toBe('migrated');
      // The whole point: live crons survive an unverifiable snapshot.
      expect(readFileSync(cronsPath(), 'utf-8')).toBe(before);
      // Marker must NOT be written, so the next boot retries instead of silently giving up.
      expect(existsSync(join(stateDir(), '.crons-migrated'))).toBe(false);
    },
  );

  it('does not snapshot or escalate for a genuinely new agent with no live crons', () => {
    writeConfig([{ name: 'heartbeat', interval: '2h', prompt: 'from config' }]);
    const criticals: string[] = [];
    const result = migrateCronsForAgent(AGENT, configPath, tmp, {
      log: () => {},
      onCritical: (msg) => criticals.push(msg),
    });
    expect(result.status).toBe('migrated');
    expect(criticals).toEqual([]);
    expect(readdirSync(stateDir()).filter((f) => f.includes('.pre-migration-'))).toEqual([]);
  });
});

describe('detectMissingMigrationMarker', () => {
  const stateDir = () => join(tmp, CRONS_DIRECTORY, AGENT);

  function writeLiveCrons(): void {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(
      join(stateDir(), 'crons.json'),
      JSON.stringify({ updated_at: '2026-07-30T00:00:00Z', crons: [live({ name: 'unified-watchdog' })] }),
      'utf-8',
    );
  }

  it('flags the assembled trigger: marker absent WITH live crons', () => {
    writeLiveCrons();
    const findings = detectMissingMigrationMarker(AGENT);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('marker-missing');
    // The names must be in the message: the whole point is knowing what is at risk.
    expect(findings[0].liveValue).toContain('unified-watchdog');
  });

  it('does NOT flag marker absent with NO live crons — harmless, and two permanent entries at the top of a daily report is how a real finding gets ignored', () => {
    mkdirSync(stateDir(), { recursive: true });
    expect(detectMissingMigrationMarker(AGENT)).toEqual([]);
  });

  it('does NOT flag when the marker is present', () => {
    writeLiveCrons();
    writeFileSync(join(stateDir(), '.crons-migrated'), '', 'utf-8');
    expect(detectMissingMigrationMarker(AGENT)).toEqual([]);
  });
});

describe('detectScheduleContradictsPrompt', () => {
  // Fixed offset so the test does not depend on the date it runs. UTC-4 = EDT.
  const TZ = 'America/New_York';

  it('flags the chef double conversion: prompt says 8:30am ET, cron fires 12:30pm ET', () => {
    const findings = detectScheduleContradictsPrompt(
      AGENT,
      [live({ name: 'atlas-sync', schedule: '30 16 * * 0', prompt: 'Atlas volume sync (Sunday 8:30am ET, fires after sunday-grocery)' })],
      TZ,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('schedule-contradicts-prompt');
  });

  it('does NOT flag a correct normalisation: prompt says 7am ET, cron fires 11 UTC', () => {
    expect(
      detectScheduleContradictsPrompt(
        AGENT,
        [live({ name: 'morning-brief', schedule: '0 11 * * *', prompt: 'Morning brief at 7am ET.' })],
        TZ,
      ),
    ).toEqual([]);
  });

  it('is silent when the prompt states no time — an absent claim is not a contradiction', () => {
    expect(
      detectScheduleContradictsPrompt(
        AGENT,
        [live({ name: 'x', schedule: '0 16 * * 0', prompt: 'Do the thing. See AGENTS.md for timing.' })],
        TZ,
      ),
    ).toEqual([]);
  });

  it('ignores interval crons — they have no wall-clock time to contradict', () => {
    expect(
      detectScheduleContradictsPrompt(
        AGENT,
        [live({ name: 'heartbeat', schedule: '2h', prompt: 'Heartbeat. Night mode starts 8pm ET.' })],
        TZ,
      ),
    ).toEqual([]);
  });

  it('matches any hour in a multi-hour expression', () => {
    expect(
      detectScheduleContradictsPrompt(
        AGENT,
        [live({ name: 'relay', schedule: '0 14,20 * * *', prompt: 'Relay at 10am ET and 4pm ET.' })],
        TZ,
      ),
    ).toEqual([]);
  });

  // A matcher over prose fires on prose ABOUT the thing. Documenting WHY a schedule is right
  // introduces the rejected alternative into the same text, so the better the note the likelier
  // it trips the check. Each case below states a CORRECT schedule and must stay silent.
  describe('a time inside a negation is not a claim', () => {
    it.each([
      ['post-hoc rejection (chef shape)', '0 16 * * 0', 'Sunday grocery (12pm ET — deliberate, not 8am ET).'],
      ['rather than',                      '0 16 * * 0', 'Sunday grocery at 12pm ET rather than 9am ET.'],
      ['instead of',                       '0 16 * * 0', 'Sunday grocery at 12pm ET instead of 10am ET.'],
      ['never',                            '0 16 * * 0', 'Sunday grocery at 12pm ET. Never 5am ET.'],
      // Order-independence is the whole reason this is a negator lookback and not a
      // first-match-wins rule: here the DISCLAIMED time comes first.
      ['negation first, claim second',     '0 16 * * 0', 'Not 8am ET — this runs 12pm ET.'],
    ])('stays silent: %s', (_label, schedule, prompt) => {
      expect(
        detectScheduleContradictsPrompt(AGENT, [live({ name: 'sunday-grocery', schedule, prompt })], TZ),
      ).toEqual([]);
    });

    // Both directions. A guard that can never fire is as broken as one that never goes quiet —
    // it just fails silently instead of loudly. These prove the negator lookback did not simply
    // disable the check.
    it('STILL FLAGS a real contradiction that merely mentions a negator elsewhere', () => {
      const findings = detectScheduleContradictsPrompt(
        AGENT,
        [live({
          name: 'sunday-grocery',
          schedule: '0 16 * * 0',
          // The negator governs a different clause and is closed off by a full stop, so it must
          // not reach forward and disclaim the real 8am ET claim.
          prompt: 'Do not skip this run. Sunday grocery at 8am ET.',
        })],
        TZ,
      );
      expect(findings).toHaveLength(1);
      expect(findings[0].kind).toBe('schedule-contradicts-prompt');
    });

    it('STILL FLAGS when every stated time is disclaimed except a wrong one', () => {
      const findings = detectScheduleContradictsPrompt(
        AGENT,
        [live({ name: 'sunday-grocery', schedule: '0 16 * * 0', prompt: 'Runs 8am ET, not 11am ET.' })],
        TZ,
      );
      expect(findings).toHaveLength(1);
    });

    it('goes silent rather than flagging when the ONLY stated time is disclaimed', () => {
      // No surviving claim means no contradiction — the same rule as a prompt stating no time.
      // Asserted explicitly because the alternative (treating a disclaimed time as the claim)
      // is exactly the false positive this change exists to remove.
      expect(
        detectScheduleContradictsPrompt(
          AGENT,
          [live({ name: 'sunday-grocery', schedule: '0 16 * * 0', prompt: 'This does not run at 8am ET.' })],
          TZ,
        ),
      ).toEqual([]);
    });
  });
});

/**
 * The report's job is triage, so its BRANCHES are the behaviour — which line prints, and which
 * does not, decides whether a real finding is read or skimmed past. Every assertion below is
 * about an ABSENCE as much as a presence, which is exactly the shape that passes vacuously if
 * nobody sabotages it (see work/negation-sabotage.mjs for the same discipline on the extractor).
 */
describe('formatDriftFindings', () => {
  const f = (over: Partial<CronDriftFinding>): CronDriftFinding => ({
    agent: 'someagent',
    cron: 'somecron',
    kind: 'prompt-differs',
    configValue: '100 chars',
    liveValue: '200 chars',
    ...over,
  });

  const MARKER_LINE = 'marker-missing is the assembled trigger';
  const CONTRADICT_LINE = 'schedule-contradicts-prompt: the prompt states a time';

  it('does NOT print the marker-missing explainer when there are no marker findings', () => {
    // The whole point of P1. On a clean fleet this line used to print every 6 hours below 33
    // non-actions, so the day it means something it looks like the noise.
    const out = formatDriftFindings([f({ kind: 'missing-live', liveValue: '(absent)' })]);
    expect(out).not.toContain(MARKER_LINE);
    expect(out).not.toContain(CONTRADICT_LINE);
  });

  it('DOES print the marker-missing explainer when a marker finding exists', () => {
    // Both directions. An explainer that can never print is as broken as one that always does.
    const out = formatDriftFindings([f({ kind: 'marker-missing', configValue: 'marker absent' })]);
    expect(out).toContain(MARKER_LINE);
    expect(out).not.toContain(CONTRADICT_LINE);
  });

  it('separates live-vs-live findings from config-vs-live', () => {
    const out = formatDriftFindings([
      f({ kind: 'marker-missing', cron: '(agent-level)' }),
      f({ kind: 'missing-live', cron: 'ghost', liveValue: '(absent)' }),
    ]);
    expect(out).toContain('1 LIVE finding(s)');
    expect(out).toContain('EDITING IT changes nothing that runs');
    // Ordering is load-bearing: the actionable block must come first in the string.
    expect(out.indexOf('LIVE finding(s)')).toBeLessThan(out.indexOf('disagrees with the'));
  });

  it('does NOT claim config-vs-live findings are all inconsequential', () => {
    // The first version of the header said "NONE of these affect what runs". Too strong, and it
    // contradicted the missing-live explainer two lines below: a missing-live entry can be a cron
    // someone INTENDED and never got, which is the original eight-week failure. The bounded claim
    // is that EDITING config.json changes nothing — not that nothing is wrong.
    const out = formatDriftFindings([f({ kind: 'missing-live', cron: 'ghost', liveValue: '(absent)' })]);
    expect(out).not.toContain('NONE of these affect what runs');
    expect(out).toContain('may be a cron someone intended and never got');
  });

  it('collapses prompt-differs to a count instead of one line each', () => {
    const many = Array.from({ length: 21 }, (_, i) => f({ cron: `c${i}` }));
    const out = formatDriftFindings(many);
    expect(out).toContain('21 prompt-differs not listed');
    expect(out).not.toContain('  someagent/c0  prompt-differs');
    // The count survives so a JUMP is still visible — that jump is the original 8-week failure.
    expect(out).toContain('21 place(s) where config.json disagrees');
  });

  it('still lists missing-live per line — it is demoted in noise, not in importance', () => {
    const out = formatDriftFindings([f({ kind: 'missing-live', cron: 'ghost', liveValue: '(absent)' })]);
    expect(out).toContain('someagent/ghost  missing-live');
  });

  it('the empty report claims only what it compared', () => {
    // Not "no drift found": the detector cannot see cron EXPRESSIONS or live-only crons at all,
    // so an unqualified all-clear would overstate its own coverage.
    expect(formatDriftFindings([])).toBe(
      'config.json and the live scheduler agree everywhere they can be compared.',
    );
  });
});

/**
 * Retired agents are out of scope on a DETERMINABLE signal (roster `enabled: false`), not a
 * hardcoded name — so every future retirement is covered, not just builder_2 (retired 2026-07-07).
 *
 * A disabled agent never boots, so its crons cannot fire and its migration cannot run: none of the
 * comparisons in this module have a consequence for it. Leaving a known-permanent row in a report
 * the fleet is actively working from teaches people the list has residents.
 */
describe('retired agents are out of scope', () => {
  let prevFrameworkRoot: string | undefined;

  // BOTH agents always exist with IDENTICAL drift; only the ROSTER varies between tests. The first
  // version built the second agent's directory only in the disabled case, so the control asserting
  // "both reported when nobody is disabled" was asserting on an agent that did not exist — it would
  // have failed for a reason unrelated to the filter, and had the polarity been reversed it would
  // have PASSED vacuously. The fixture must differ in exactly the variable under test.
  const AGENTS = ['live_agent', 'dead_agent'];

  function seedFleet(disabled: string[]): void {
    prevFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
    process.env.CTX_FRAMEWORK_ROOT = tmp;
    mkdirSync(join(tmp, 'config'), { recursive: true });
    const roster: Record<string, unknown> = {};
    for (const name of AGENTS) {
      roster[name] = { org: 'testorg', enabled: !disabled.includes(name) };
    }
    writeFileSync(join(tmp, 'config', 'enabled-agents.json'), JSON.stringify(roster), 'utf-8');

    for (const name of AGENTS) {
      const dir = join(tmp, 'orgs', 'testorg', 'agents', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({ agent_name: name, crons: [{ name: 'ghost', interval: '4h', prompt: 'x' }] }),
        'utf-8',
      );
    }
  }

  afterEach(() => {
    if (prevFrameworkRoot === undefined) delete process.env.CTX_FRAMEWORK_ROOT;
    else process.env.CTX_FRAMEWORK_ROOT = prevFrameworkRoot;
  });

  it('excludes a disabled agent while still reporting an enabled one with IDENTICAL drift', () => {
    // Both directions in one assertion pair. An exclusion that suppresses everything is as broken
    // as no exclusion at all — it just fails quietly instead of loudly.
    seedFleet(['dead_agent']);
    const agents = sweepConfigCronDrift(tmp).map((f) => f.agent);
    expect(agents).toContain('live_agent');
    expect(agents).not.toContain('dead_agent');
  });

  it('reports BOTH when nobody is disabled — proves the filter is the cause, not the fixture', () => {
    seedFleet([]);
    const agents = sweepConfigCronDrift(tmp).map((f) => f.agent);
    expect(agents).toContain('live_agent');
    expect(agents).toContain('dead_agent');
  });

  it('surfaces the excluded set so the scope narrowing is not silent', () => {
    // An unstated scope narrowing is indistinguishable from a clean bill of health, and re-enabling
    // one of these returns it to scope with nothing announcing that.
    seedFleet(['dead_agent']);
    expect(listExcludedRetiredAgents()).toEqual(['dead_agent']);
  });

  it('fails OPEN when the roster is unreadable — never silently empties the report', () => {
    seedFleet(['dead_agent']);
    writeFileSync(join(tmp, 'config', 'enabled-agents.json'), 'not json at all', 'utf-8');
    // listAgents swallows the parse error and falls back to the directory scan, where absence of an
    // explicit entry means enabled. Suppressing a live agent's finding costs more than printing a
    // retired one's, so this asymmetry is deliberate.
    const agents = sweepConfigCronDrift(tmp).map((f) => f.agent);
    expect(agents).toContain('live_agent');
    expect(agents).toContain('dead_agent');
    expect(listExcludedRetiredAgents()).toEqual([]);
  });
});
