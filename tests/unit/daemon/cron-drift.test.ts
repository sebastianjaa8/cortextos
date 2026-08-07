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

import { detectConfigCronDrift, detectMissingMigrationMarker, detectScheduleContradictsPrompt, formatDriftFindings, countActionableFindings, statedTimeCoverage, sweepConfigCronDrift, listExcludedRetiredAgents, wipeConditionArmed } from '../../../src/daemon/cron-drift.js';
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

  // Found 2026-08-07 on the real fleet: seb_boss/branch-consolidation's prompt documents its own
  // UTC->ET conversion ("nightly 3am UTC = 11pm ET"), which is exactly the good practice this
  // checker exists to reward. The old 20-char lookahead let "3am" reach past "11pm" to claim the
  // distant "ET" that belongs to "11pm ET", producing a false stated hour of 3 instead of the real
  // claim, 23 — and the schedule (0 3 * * *, 03:00 UTC = 23:00 ET) is correct and must stay silent.
  it('does NOT flag a prompt that documents its own UTC->ET conversion (the branch-consolidation case)', () => {
    expect(
      detectScheduleContradictsPrompt(
        AGENT,
        [live({
          name: 'branch-consolidation',
          schedule: '0 3 * * *',
          prompt: 'BRANCH CONSOLIDATION BATCH (nightly 3am UTC = 11pm ET). Standing directive...',
        })],
        TZ,
      ),
    ).toEqual([]);
  });

  // Both directions, same discipline as every other guard in this file: rejecting the decoy token
  // (the one with no tz suffix of its own) must not also swallow the token that IS correctly
  // attached to that suffix — it gets its own turn at the same "ET" once the decoy is out of the
  // way, and a genuine mismatch on THAT token must still surface.
  it('STILL FLAGS when the token correctly attached to ET does not match the schedule', () => {
    const findings = detectScheduleContradictsPrompt(
      AGENT,
      [live({
        name: 'probe',
        schedule: '0 16 * * *', // 16:00 UTC = 12pm ET
        // "9am" is the decoy (rejected, second-token-between); "5am ET" is the token immediately
        // preceding the suffix and is the only surviving claim — 12 is not in [5].
        prompt: 'Runs 9am UTC = 5am ET today.',
      })],
      TZ,
    );
    expect(findings).toHaveLength(1);
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

  // The negation guard above was LATENT — 0 live crons affected. This one shipped against three
  // live false positives, and the three do not share a phrasing, only a grammar: the time is the
  // OBJECT of a comparison. A cron may fire at any hour to evaluate a boundary, so reading the
  // boundary as a fire-time claim inverts the check — the more precisely a prompt names the window
  // it inspects, the more certainly it is flagged for not firing inside it.
  describe('a time introduced by a comparison is a threshold, not a claim', () => {
    it.each([
      // The three live grammars, verbatim in shape from the fleet on 2026-07-31. Each schedule
      // below is the REAL one and is correct by design: fire outside the window, inspect inside it.
      [
        'threshold (atlas/weekly-review-check)',
        '0 16 * * 1',
        'If mtime is older than Sunday 22:00 UTC (6pm ET Sunday = start of review window), flag it.',
      ],
      [
        // The live prompt ALSO states its own fire time ("10:00 UTC = 6am ET"), which on the
        // finding path masks this entirely — the live cost is in the match count, not a finding.
        // Dropped here so the case can actually discriminate: with the threshold as the only time,
        // the guard is the difference between silence and a false positive.
        'positional reference to another cron (builder_1/check-expectations)',
        '0 10 * * *',
        'Fires 10:00 UTC daily, before the 7am ET brief composes.',
      ],
      [
        'filter bound (email_triage/midday-triage)',
        '0 16 * * *',
        'Pull unread Gmail received after 6:30am ET and triage it.',
      ],
      ['prior to', '0 16 * * 1', 'Sweep anything landed prior to 9am ET.'],
      ['since', '0 16 * * 1', 'Report everything since 7am ET.'],
      ['until', '0 16 * * 1', 'Hold the queue until 8am ET.'],
      ['newer than', '0 16 * * 1', 'Skip anything newer than 7am ET.'],
      ['earlier than', '0 16 * * 1', 'Escalate anything earlier than 9am ET.'],
      ['later than', '0 16 * * 1', 'Escalate anything later than 8am ET.'],
    ])('stays silent: %s', (_label, schedule, prompt) => {
      expect(
        detectScheduleContradictsPrompt(AGENT, [live({ name: 'probe', schedule, prompt })], TZ),
      ).toEqual([]);
    });

    // Both directions, same discipline as the negation block. A guard that can never fire is as
    // broken as one that never goes quiet — it just fails silently instead of loudly.
    it('STILL FLAGS when the comparison word FOLLOWS the time — lookback is directional', () => {
      // "at 9am ET, after checking the inbox": `after` governs the checking, not the hour. This is
      // the property that lets a bare word list like `after` be safe at all, so it is asserted
      // rather than assumed.
      const findings = detectScheduleContradictsPrompt(
        AGENT,
        [live({ name: 'probe', schedule: '0 16 * * *', prompt: 'Runs at 9am ET, after checking the inbox.' })],
        TZ,
      );
      expect(findings).toHaveLength(1);
    });

    it('STILL FLAGS when the comparison word is closed off by a sentence terminator', () => {
      // A preposition in a previous sentence must not reach forward and delete a real claim —
      // the same clause bound the negation guard uses, for the same reason.
      const findings = detectScheduleContradictsPrompt(
        AGENT,
        [live({ name: 'probe', schedule: '0 16 * * *', prompt: 'Skip anything older than a week. Runs 9am ET.' })],
        TZ,
      );
      expect(findings).toHaveLength(1);
    });

    // GUARD FOR ONE LEG SUPPRESSING ANOTHER. Two of the three live false positives state a real
    // time in the SAME prompt as the threshold, so a guard that suppressed the whole prompt rather
    // than the token would have silently un-checked two correct crons while looking like a fix.
    it('suppresses only the threshold token — a threshold must not MASK a real contradiction', () => {
      // Two of the three live false positives state a real time in the SAME prompt as the
      // threshold, so a guard applied to the prompt rather than the token would silently
      // un-check two correct crons while looking like a fix.
      //
      // Chosen so it DISCRIMINATES, which the obvious version of this test does not: here the
      // schedule matches the THRESHOLD (12pm) and contradicts the CLAIM (9am). Ungrarded, the
      // threshold token satisfies `stated.some(...)` and the detector goes silent on a real
      // contradiction — the guard turns a false NEGATIVE into a finding, not just a finding
      // into silence. A first draft of this test asserted the same outcome on both sides of the
      // guard and passed with the rule deleted.
      const prompt = 'Runs at 9am ET, after the 12pm ET sweep.';
      expect(
        detectScheduleContradictsPrompt(AGENT, [live({ name: 'probe', schedule: '0 16 * * *', prompt })], TZ),
      ).toHaveLength(1);
      // ...and the surviving claim is the 9am one: a schedule that matches IT is silent.
      expect(
        detectScheduleContradictsPrompt(AGENT, [live({ name: 'probe', schedule: '0 13 * * *', prompt })], TZ),
      ).toEqual([]);
    });
  });
});

/**
 * The counters, not the findings. `stating` falling is a finding BY DESIGN — it is how a prompt
 * tidied into a doc pointer gets caught. So a suppression rule that lowers `stating` without
 * reporting itself is indistinguishable from the regression this metric exists to detect, and the
 * run it ships on would read as a silent tidy. These assert the accounting, which is the only
 * thing that keeps the drop legible.
 */
describe('statedTimeCoverage accounting', () => {
  const A = 'probe_agent';

  function seedCrons(crons: Array<{ name: string; schedule: string; prompt: string }>): void {
    const dir = join(tmp, CRONS_DIRECTORY, A);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'crons.json'),
      JSON.stringify({ updated_at: '2026-07-31T00:00:00Z', crons: crons.map((c) => ({ ...c, enabled: true })) }),
      'utf-8',
    );
  }

  it('counts a threshold token separately from a disclaimed one', () => {
    seedCrons([
      { name: 'thresh', schedule: '0 16 * * 1', prompt: 'Flag anything older than 6pm ET.' },
      { name: 'neg', schedule: '0 16 * * 0', prompt: 'Runs 12pm ET, not 8am ET.' },
    ]);
    const c = statedTimeCoverage();
    expect(c.threshold).toBe(1);
    expect(c.disclaimed).toBe(1);
    // The threshold cron states nothing that survives, so it drops out of `stating` — and the
    // count above is what explains the drop to a reader who would otherwise see a regression.
    expect(c.stating).toBe(1);
    expect(c.timeAnchored).toBe(2);
  });

  it('classifies a token carrying BOTH as disclaimed, so this change cannot move the other number', () => {
    // "not before 8am ET" is negated AND comparative. Negation is checked first deliberately:
    // the pre-existing counter must keep its pre-existing meaning, or shipping this guard would
    // silently redistribute a number nobody asked it to touch.
    seedCrons([{ name: 'both', schedule: '0 16 * * *', prompt: 'This does not run before 8am ET.' }]);
    const c = statedTimeCoverage();
    expect(c.disclaimed).toBe(1);
    expect(c.threshold).toBe(0);
  });

  // task_1785780835345_12163173, fix 1: the aggregate must name WHICH crons it counted, not just
  // how many — a frozen number cannot be audited without membership.
  it('publishes membership for stating/disclaimed/threshold, not just counts', () => {
    seedCrons([
      { name: 'claim', schedule: '0 16 * * *', prompt: 'Runs 12pm ET.' },
      { name: 'neg', schedule: '0 16 * * 0', prompt: 'Runs 12pm ET, not 8am ET.' },
      { name: 'thresh', schedule: '0 16 * * 1', prompt: 'Flag anything older than 6pm ET.' },
    ]);
    const c = statedTimeCoverage();
    expect(c.statingCrons).toEqual([{ agent: A, cron: 'claim' }, { agent: A, cron: 'neg' }]);
    expect(c.disclaimedCrons).toEqual([{ agent: A, cron: 'neg' }]);
    expect(c.thresholdCrons).toEqual([{ agent: A, cron: 'thresh' }]);
  });

  // task_1785780835345_12163173, fix 2, THE MUST-FAIL CASE: a cron whose only time signal is a
  // stated UTC time must not inflate the denominator. extractLocalHours is blind to UTC BY
  // DESIGN (unambiguous, no conversion to verify) — counting it anyway is what let the metric
  // fall as prompts got MORE precise, the exact regression this fix removes.
  it('excludes a UTC-only-stated cron from timeAnchored entirely (out of scope, not uncovered)', () => {
    seedCrons([{ name: 'utc-only', schedule: '0 13 * * *', prompt: 'Fires 13:07Z, checks the queue.' }]);
    const c = statedTimeCoverage();
    expect(c.timeAnchored).toBe(0);
    expect(c.stating).toBe(0);
    expect(c.utcOnlyExcluded).toEqual([{ agent: A, cron: 'utc-only' }]);
  });

  it('also excludes the "H UTC" word form, not just the "HH:MMZ" form', () => {
    seedCrons([{ name: 'utc-word', schedule: '0 3 * * *', prompt: 'Nightly batch, fires 3am UTC.' }]);
    const c = statedTimeCoverage();
    expect(c.timeAnchored).toBe(0);
    expect(c.utcOnlyExcluded).toEqual([{ agent: A, cron: 'utc-word' }]);
  });

  // PAIRED NEGATIVE: a cron stating a real ET claim must still raise timeAnchored AND stating
  // together — otherwise the UTC guard has silently narrowed the check into never firing.
  it('a cron stating a real ET time still counts normally (paired negative)', () => {
    seedCrons([{ name: 'et-claim', schedule: '0 11 * * *', prompt: 'Fires 7am ET.' }]);
    const c = statedTimeCoverage();
    expect(c.timeAnchored).toBe(1);
    expect(c.stating).toBe(1);
    expect(c.utcOnlyExcluded).toEqual([]);
  });

  // A prompt with NO time signal at all (not even UTC) is a DIFFERENT claim than "out of scope" —
  // it is a real, uncovered gap, and must still count in timeAnchored so the ratio reflects it.
  it('a fully silent prompt still counts as time-anchored (uncovered, not out-of-scope)', () => {
    seedCrons([{ name: 'silent', schedule: '0 16 * * *', prompt: 'Do the thing. See AGENTS.md.' }]);
    const c = statedTimeCoverage();
    expect(c.timeAnchored).toBe(1);
    expect(c.stating).toBe(0);
    expect(c.utcOnlyExcluded).toEqual([]);
  });

  // ORDER MATTERS: an incidental UTC mention alongside a real local-time signal must NOT trigger
  // the out-of-scope exclusion — the exclusion only applies when local extraction found nothing.
  it('does not exclude a cron that has BOTH a UTC mention and a real local-time signal', () => {
    seedCrons([{ name: 'both-tz', schedule: '0 16 * * 0', prompt: 'Runs 12pm ET (16:00 UTC), not 8am ET.' }]);
    const c = statedTimeCoverage();
    expect(c.timeAnchored).toBe(1);
    expect(c.disclaimed).toBe(1);
    expect(c.utcOnlyExcluded).toEqual([]);
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
 * ADDED 2026-08-04 (seb_boss): the --notify bus message headline used raw findings.length, so a run
 * with 22 prompt-differs and nothing else produced "22 edit(s) not in effect" — an alarm headline
 * immediately contradicted by formatDriftFindings's own body, which already demotes prompt-differs
 * to "the norm, not an event". This is the single source of truth both the headline and the report
 * body now share, so they cannot say opposite things again.
 */
describe('countActionableFindings', () => {
  const f = (over: Partial<CronDriftFinding>): CronDriftFinding => ({
    agent: 'someagent',
    cron: 'somecron',
    kind: 'prompt-differs',
    configValue: '100 chars',
    liveValue: '200 chars',
    ...over,
  });

  it('is zero when every finding is prompt-differs — the exact shape that triggered this fix', () => {
    const findings = [f({}), f({ cron: 'b' }), f({ cron: 'c' })];
    expect(countActionableFindings(findings)).toBe(0);
  });

  it('counts missing-live as actionable', () => {
    const findings = [f({ kind: 'missing-live', liveValue: '(absent)' }), f({ cron: 'b' })];
    expect(countActionableFindings(findings)).toBe(1);
  });

  it('counts marker-missing and interval-mismatch as actionable alongside prompt-differs', () => {
    const findings = [
      f({ kind: 'marker-missing', cron: '(agent-level)' }),
      f({ kind: 'interval-mismatch' }),
      f({ cron: 'noise' }),
    ];
    expect(countActionableFindings(findings)).toBe(2);
  });

  it('is zero on an empty finding set — no false alarm from nothing', () => {
    expect(countActionableFindings([])).toBe(0);
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

/**
 * The wipe condition, asked at the moment of enabling rather than in a 6-hourly report the person
 * flipping the switch is not reading. Takes ctxRoot explicitly because the CLI caller has no
 * CTX_ROOT in the environment — a human in a terminal is exactly who this needs to reach.
 */
describe('wipeConditionArmed', () => {
  const A = 'probe_agent';
  const stateDir = () => join(tmp, CRONS_DIRECTORY, A);

  function seed(opts: { marker: boolean; crons: unknown }): void {
    mkdirSync(stateDir(), { recursive: true });
    if (opts.crons !== undefined) {
      writeFileSync(join(stateDir(), 'crons.json'), JSON.stringify(opts.crons), 'utf-8');
    }
    if (opts.marker) writeFileSync(join(stateDir(), '.crons-migrated'), '', 'utf-8');
  }

  it('ARMED: marker absent and crons.json holds crons — names what would be lost', () => {
    seed({ marker: false, crons: { crons: [{ name: 'unified-watchdog' }, { name: 'liveness-poke' }] } });
    expect(wipeConditionArmed(A, tmp)).toEqual(['unified-watchdog', 'liveness-poke']);
  });

  it('NOT armed when the marker is present — the normal case for every live agent', () => {
    seed({ marker: true, crons: { crons: [{ name: 'x' }] } });
    expect(wipeConditionArmed(A, tmp)).toBeNull();
  });

  it('NOT armed when there are no crons to lose — half a condition is not a finding', () => {
    // Reporting this would put permanent entries in front of the operator on every start, which is
    // how a real warning gets trained out of existence.
    seed({ marker: false, crons: { crons: [] } });
    expect(wipeConditionArmed(A, tmp)).toBeNull();
  });

  it('NOT armed when crons.json does not exist at all', () => {
    seed({ marker: false, crons: undefined });
    expect(wipeConditionArmed(A, tmp)).toBeNull();
  });

  it('ARMED when crons.json is present but unparseable — migration overwrites it regardless', () => {
    // Treating a corrupt file as "no crons" would report the condition unarmed while the overwrite
    // is exactly as destructive. Present is the question, not valid.
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(join(stateDir(), 'crons.json'), '{ not json', 'utf-8');
    expect(wipeConditionArmed(A, tmp)).toEqual(['(crons.json present but unparseable)']);
  });

  it('accepts the bare-array crons.json shape as well as the wrapped one', () => {
    seed({ marker: false, crons: [{ name: 'bare-form' }] });
    expect(wipeConditionArmed(A, tmp)).toEqual(['bare-form']);
  });
});
