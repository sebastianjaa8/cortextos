/**
 * tests/unit/daemon/expectations.test.ts
 *
 * The cross-agent artifact-freshness harness. Three modules, one bar per test:
 *
 *  - expectations.ts — manifest reading (tolerant, but REJECTIONS are recorded rather than
 *    swallowed) and local-timezone date resolution.
 *  - freshness.ts — the two predicates and the sweep's coverage arithmetic.
 *  - cron-receipts.ts — receipt discovery in strength order, plus the chunk-tolerant stdout.log
 *    banner matcher.
 *
 * What these tests are built to catch, beyond "does it work":
 *
 *  1. SABOTAGE. Several tests assert that the naive implementation gives a DIFFERENT answer, so a
 *     future simplification that removes the load-bearing part goes red instead of silently
 *     degrading. Three vacuous assertions got through this month; a test that passes against both
 *     the real and the broken version measures nothing.
 *  2. BOUNDARIES, not just happy paths. THIN/MISSING and PENDING/CLEAN/DRIFT are where a
 *     three-state check quietly collapses into a two-state one.
 *  3. THE COVERAGE DENOMINATOR. A shrinking denominator reads exactly like a clean report, so an
 *     exact-number assertion on `evaluable` / `declared` is mandatory rather than nice to have.
 *
 * CTX_ROOT is set to a per-test mkdtemp and restored in afterEach. Not optional: this suite exercises
 * modules that resolve CTX_ROOT from the environment, and a suite that omitted exactly this wrote
 * 1,342 fake cron fires into the LIVE state dir over ten weeks and manufactured two "ghost agents".
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  readExpectations,
  localDateStamp,
  resolveCandidatePaths,
} from '../../../src/daemon/expectations.js';
import type {
  ArtifactFreshExpectation,
  PromptMatchesDocExpectation,
} from '../../../src/daemon/expectations.js';
import {
  checkArtifactFresh,
  checkPromptMatchesDoc,
  countBodyLines,
  sweepExpectations,
  formatSweep,
  writeCheckerReceipt,
} from '../../../src/daemon/freshness.js';
import type { ArtifactProbe, ProbeFn } from '../../../src/daemon/freshness.js';
import {
  densify,
  bannerReached,
  findReceipt,
  readTail,
  readRotatedTail,
  writeRunReceipt,
  RECEIPTS_FILENAME,
} from '../../../src/daemon/cron-receipts.js';
import { CRONS_DIRECTORY } from '../../../src/bus/crons-schema.js';
import type { CronDefinition } from '../../../src/types/index.js';

// 02:00Z on 07-30 is 22:00 on 07-29 in America/New_York. Chosen deliberately: a clock where UTC
// and local agree cannot catch a UTC-vs-local mistake, and this harness is full of date arithmetic.
const NOW = new Date('2026-07-30T02:00:00.000Z');

let tmp: string;
let prevCtxRoot: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'expectations-'));
  prevCtxRoot = process.env.CTX_ROOT;
  process.env.CTX_ROOT = tmp;
});

afterEach(() => {
  if (prevCtxRoot === undefined) delete process.env.CTX_ROOT;
  else process.env.CTX_ROOT = prevCtxRoot;
  rmSync(tmp, { recursive: true, force: true });
});

function agentDir(agent: string, org = 'TestOrg', timezone = 'America/New_York'): string {
  const dir = join(tmp, 'orgs', org, 'agents', agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ agent_name: agent, timezone }), 'utf-8');
  return dir;
}

function writeManifest(dir: string, expectations: unknown): void {
  writeFileSync(join(dir, 'expectations.json'), JSON.stringify({ expectations }), 'utf-8');
}

function writeLiveCrons(agent: string, crons: Partial<CronDefinition>[]): void {
  const dir = join(tmp, CRONS_DIRECTORY, agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'crons.json'),
    JSON.stringify({
      updated_at: NOW.toISOString(),
      crons: crons.map((c) => ({
        name: 'unnamed',
        prompt: '',
        schedule: '2h',
        enabled: true,
        created_at: '2026-06-01T00:00:00Z',
        ...c,
      })),
    }),
    'utf-8',
  );
}

/** In-memory probe. The injectable seam the plan requires — chmod does not block writes on this box. */
function probeFrom(files: Record<string, { bytes: number; ageMs: number; bodyLines?: number }>): ProbeFn {
  return (path) => {
    const f = files[path];
    if (!f) return null;
    const p: ArtifactProbe = {
      mtimeMs: NOW.getTime() - f.ageMs,
      bytes: f.bytes,
      bodyLines: () => (f.bodyLines === undefined ? 99 : f.bodyLines),
    };
    return p;
  };
}

function artifact(over: Partial<ArtifactFreshExpectation> = {}): ArtifactFreshExpectation {
  return {
    id: 'a1',
    agent: 'agent_a',
    timezone: 'America/New_York',
    type: 'artifact-fresh',
    path: '/vault/notes.md',
    max_age: '26h',
    ...over,
  };
}

function promptDoc(over: Partial<PromptMatchesDocExpectation> = {}): PromptMatchesDocExpectation {
  return {
    id: 'p1',
    agent: 'agent_a',
    timezone: 'America/New_York',
    type: 'prompt-matches-doc',
    cron: 'heartbeat',
    doc: 'HEARTBEAT.md',
    inline_forbidden: ['TotalVisibleMemorySize', 'NIGHT MODE:'],
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe('readExpectations', () => {
  it('yields nothing and does not throw when no manifest exists — the normal opted-out state', () => {
    const dir = agentDir('agent_a');
    expect(readExpectations('agent_a', dir)).toEqual({ expectations: [], rejected: [] });
  });

  it('records an unparseable manifest as a rejection instead of throwing — one bad file must not abort a fleet sweep', () => {
    const dir = agentDir('agent_a');
    writeFileSync(join(dir, 'expectations.json'), '{ this is not json', 'utf-8');
    const res = readExpectations('agent_a', dir);
    expect(res.expectations).toHaveLength(0);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0].id).toBe('(whole manifest)');
    expect(res.rejected[0].reason).toMatch(/unparseable/);
  });

  it('rejects a bad max_age with a stated reason rather than dropping the entry silently', () => {
    const dir = agentDir('agent_a');
    writeManifest(dir, [{ id: 'a1', type: 'artifact-fresh', path: '/x', max_age: 'soonish' }]);
    const res = readExpectations('agent_a', dir);
    expect(res.expectations).toHaveLength(0);
    expect(res.rejected[0]).toMatchObject({ id: 'a1' });
    expect(res.rejected[0].reason).toMatch(/max_age is not an interval/);
  });

  it('rejects an empty inline_forbidden — a check that cannot fail would inflate coverage forever', () => {
    const dir = agentDir('agent_a');
    writeManifest(dir, [
      { id: 'p1', type: 'prompt-matches-doc', cron: 'heartbeat', doc: 'H.md', inline_forbidden: [] },
    ]);
    const res = readExpectations('agent_a', dir);
    expect(res.expectations).toHaveLength(0);
    expect(res.rejected[0].reason).toMatch(/inline_forbidden is empty/);
  });

  it('stamps each expectation with its owning agent and that agent config.json timezone', () => {
    const dir = agentDir('agent_a', 'TestOrg', 'Asia/Tokyo');
    writeManifest(dir, [{ id: 'a1', type: 'artifact-fresh', path: '/x', max_age: '26h' }]);
    const res = readExpectations('agent_a', dir);
    expect(res.expectations[0]).toMatchObject({ agent: 'agent_a', timezone: 'Asia/Tokyo' });
  });
});

describe('localDateStamp', () => {
  it('resolves the stamp in the AGENT timezone, which is a different calendar day from UTC at 05:00Z', () => {
    // 2026-07-30T02:00Z is 2026-07-30 in UTC but still 22:00 on 2026-07-29 in New York.
    expect(localDateStamp(NOW, 'America/New_York')).toBe('2026-07-29');
    expect(localDateStamp(NOW, 'UTC')).toBe('2026-07-30');
  });

  it('SABOTAGE: the toISOString().slice(0,10) shortcut gives the WRONG day here, so the Intl path is load-bearing', () => {
    const naive = NOW.toISOString().slice(0, 10);
    expect(naive).toBe('2026-07-30');
    expect(localDateStamp(NOW, 'America/New_York')).not.toBe(naive);
  });

  it('is DST-aware rather than fixed-offset', () => {
    const january = new Date('2026-01-15T04:30:00.000Z'); // EST, UTC-5 -> still Jan 14 local
    const july = new Date('2026-07-15T04:30:00.000Z'); // EDT, UTC-4 -> still Jul 15 local
    expect(localDateStamp(january, 'America/New_York')).toBe('2026-01-14');
    expect(localDateStamp(july, 'America/New_York')).toBe('2026-07-15');
  });
});

describe('resolveCandidatePaths', () => {
  it('returns exactly one path for an undated template', () => {
    expect(resolveCandidatePaths('/vault/notes.md', NOW, 'UTC', 26 * 3_600_000)).toEqual([
      '/vault/notes.md',
    ]);
  });

  it('offers today-local FIRST and yesterday-local next, so a check just after local midnight is not a false MISSING', () => {
    const paths = resolveCandidatePaths('/v/{YYYY-MM-DD}.md', NOW, 'America/New_York', 26 * 3_600_000);
    expect(paths[0]).toBe('/v/2026-07-29.md');
    expect(paths).toContain('/v/2026-07-28.md');
  });

  it('SABOTAGE: today-only resolution would miss the file that actually exists', () => {
    const probe = probeFrom({ '/v/2026-07-28.md': { bytes: 5000, ageMs: 3_600_000 } });
    // The real implementation walks back through the window and finds it.
    const res = checkArtifactFresh(artifact({ path: '/v/{YYYY-MM-DD}.md' }), NOW, probe);
    expect(res.state).toBe('FRESH');
    // A today-only implementation would have probed this path and found nothing.
    expect(probe('/v/2026-07-29.md')).toBeNull();
  });
});

describe('countBodyLines', () => {
  it('matches check-context-save.sh exactly: blank and h1 excluded, deeper headings counted', () => {
    expect(countBodyLines('# Title\n\n## Section\nreal line\n   \n')).toBe(2);
  });
});

describe('checkArtifactFresh', () => {
  it('FRESH when present, recent and above both floors', () => {
    const probe = probeFrom({ '/vault/notes.md': { bytes: 4000, ageMs: 3_600_000, bodyLines: 40 } });
    const res = checkArtifactFresh(artifact({ min_bytes: 300, min_body_lines: 2 }), NOW, probe);
    expect(res.state).toBe('FRESH');
  });

  it('min_bytes boundary: exactly at the floor is FRESH, one byte under is THIN', () => {
    const at = probeFrom({ '/vault/notes.md': { bytes: 300, ageMs: 1_000, bodyLines: 9 } });
    const under = probeFrom({ '/vault/notes.md': { bytes: 299, ageMs: 1_000, bodyLines: 9 } });
    expect(checkArtifactFresh(artifact({ min_bytes: 300 }), NOW, at).state).toBe('FRESH');
    expect(checkArtifactFresh(artifact({ min_bytes: 300 }), NOW, under).state).toBe('THIN');
  });

  it('min_body_lines boundary: at the floor is FRESH, one under is THIN', () => {
    const at = probeFrom({ '/vault/notes.md': { bytes: 9999, ageMs: 1_000, bodyLines: 2 } });
    const under = probeFrom({ '/vault/notes.md': { bytes: 9999, ageMs: 1_000, bodyLines: 1 } });
    expect(checkArtifactFresh(artifact({ min_body_lines: 2 }), NOW, at).state).toBe('FRESH');
    expect(checkArtifactFresh(artifact({ min_body_lines: 2 }), NOW, under).state).toBe('THIN');
  });

  it('MISSING with stale=false when nothing exists at any candidate path', () => {
    const res = checkArtifactFresh(artifact(), NOW, probeFrom({}));
    expect(res.state).toBe('MISSING');
    expect(res.stale).toBe(false);
    expect(res.detail).toMatch(/no file at/);
  });

  it('MISSING with stale=TRUE when present but past the age budget — same severity, different fix', () => {
    const probe = probeFrom({ '/vault/notes.md': { bytes: 9999, ageMs: 30 * 3_600_000 } });
    const res = checkArtifactFresh(artifact({ max_age: '26h' }), NOW, probe);
    expect(res.state).toBe('MISSING');
    expect(res.stale).toBe(true);
    expect(res.detail).toMatch(/present but stale/);
  });

  it('age boundary: inside the budget is FRESH, one millisecond past it is MISSING', () => {
    const inside = probeFrom({ '/vault/notes.md': { bytes: 9999, ageMs: 26 * 3_600_000 } });
    const outside = probeFrom({ '/vault/notes.md': { bytes: 9999, ageMs: 26 * 3_600_000 + 1 } });
    expect(checkArtifactFresh(artifact(), NOW, inside).state).toBe('FRESH');
    expect(checkArtifactFresh(artifact(), NOW, outside).state).toBe('MISSING');
  });

  it('an UNREADABLE body (-1) is not reported as THIN — that would blame the producer for a permissions problem', () => {
    const probe = probeFrom({ '/vault/notes.md': { bytes: 9999, ageMs: 1_000, bodyLines: -1 } });
    expect(checkArtifactFresh(artifact({ min_body_lines: 2 }), NOW, probe).state).toBe('FRESH');
  });

  it('judges the NEWEST existing candidate, not the first one it finds', () => {
    const probe = probeFrom({
      '/v/2026-07-29.md': { bytes: 100, ageMs: 40 * 3_600_000 },
      '/v/2026-07-28.md': { bytes: 9999, ageMs: 2 * 3_600_000 },
    });
    const res = checkArtifactFresh(artifact({ path: '/v/{YYYY-MM-DD}.md' }), NOW, probe);
    expect(res.path).toBe('/v/2026-07-28.md');
    expect(res.state).toBe('FRESH');
  });
});

describe('checkPromptMatchesDoc', () => {
  const live = (over: Partial<CronDefinition> = {}): CronDefinition[] => [
    {
      name: 'heartbeat',
      prompt: 'Read HEARTBEAT.md and follow it.',
      schedule: '2h',
      enabled: true,
      created_at: '2026-06-01T00:00:00Z',
      ...over,
    } as CronDefinition,
  ];

  it('CLEAN when no forbidden term is present', () => {
    expect(checkPromptMatchesDoc(promptDoc(), live()).state).toBe('CLEAN');
  });

  it('DRIFT when a forbidden term is present in a SHORT (already converted) prompt', () => {
    const crons = live({ prompt: 'Read HEARTBEAT.md. NIGHT MODE: stay quiet.' });
    const res = checkPromptMatchesDoc(promptDoc({ max_prompt_chars: 400 }), crons);
    expect(res.state).toBe('DRIFT');
    expect(res.detail).toMatch(/NIGHT MODE:/);
  });

  it('PENDING-CONVERSION when the same term sits in a LONG prompt — expected before conversion, not a flag', () => {
    const crons = live({ prompt: 'NIGHT MODE: ' + 'x'.repeat(500) });
    expect(checkPromptMatchesDoc(promptDoc({ max_prompt_chars: 400 }), crons).state).toBe(
      'PENDING-CONVERSION',
    );
  });

  it('length boundary: exactly at max_prompt_chars is DRIFT, one char over is PENDING', () => {
    const term = 'NIGHT MODE:';
    const atLen = 100;
    const at = live({ prompt: term + 'x'.repeat(atLen - term.length) });
    const over = live({ prompt: term + 'x'.repeat(atLen - term.length + 1) });
    expect(checkPromptMatchesDoc(promptDoc({ max_prompt_chars: atLen }), at).state).toBe('DRIFT');
    expect(checkPromptMatchesDoc(promptDoc({ max_prompt_chars: atLen }), over).state).toBe(
      'PENDING-CONVERSION',
    );
  });

  it('with NO max_prompt_chars declared, a forbidden term is DRIFT — the quiet state must be opted into', () => {
    const crons = live({ prompt: 'NIGHT MODE: ' + 'x'.repeat(2000) });
    expect(checkPromptMatchesDoc(promptDoc(), crons).state).toBe('DRIFT');
  });

  it('matches terms case-insensitively, so a re-capitalisation does not launder drift', () => {
    const crons = live({ prompt: 'read the doc. night mode: be quiet.' });
    expect(checkPromptMatchesDoc(promptDoc({ max_prompt_chars: 400 }), crons).state).toBe('DRIFT');
  });

  it('NOT-EVALUABLE when the named cron does not exist — a coverage gap, never a pass', () => {
    const res = checkPromptMatchesDoc(promptDoc({ cron: 'gone' }), live());
    expect(res.state).toBe('NOT-EVALUABLE');
    expect(res.state).not.toBe('CLEAN');
  });
});

describe('stdout.log banner matcher', () => {
  const ts = '2026-07-29T20:44:44.568Z';
  const ESC = String.fromCharCode(27);

  it('counts a DELIVERED fire whose timestamp was split by an ANSI sequence as reached', () => {
    const sample = `[CRON FIRED 2026-07-29T20:4${ESC}[0m4:44.568Z] heartbeat`;
    expect(bannerReached(densify(sample), ts)).not.toBeNull();
  });

  it('counts a DELIVERED fire whose timestamp was split by a chunk newline as reached', () => {
    const sample = '[CRON FIRED 2026-07-29T20:44:4\n4.568Z] heartbeat';
    expect(bannerReached(densify(sample), ts)).not.toBeNull();
  });

  it('does NOT count a different fire banner', () => {
    expect(bannerReached(densify('[CRON FIRED 2026-07-29T16:45:06.463Z] heartbeat'), ts)).toBeNull();
  });

  it('does NOT count a bare timestamp with no banner — that fragment appears constantly in 40MB of output', () => {
    expect(bannerReached(densify(`${ts} some unrelated log line`), ts)).toBeNull();
  });

  it('does NOT count a timestamp beyond the anchor slack from its banner', () => {
    const sample = `[CRON FIRED 2026-07-29T16:45:06.463Z] ${'x'.repeat(200)} ${ts}`;
    expect(bannerReached(densify(sample), ts)).toBeNull();
  });

  it('SABOTAGE: the naive includes() matcher gets BOTH directions wrong, so densify+anchor is load-bearing', () => {
    const split = `[CRON FIRED 2026-07-29T20:4${ESC}[0m4:44.568Z] heartbeat`;
    const bare = `${ts} some unrelated log line`;
    // Naive misses a real delivery...
    expect(split.includes(ts)).toBe(false);
    expect(bannerReached(densify(split), ts)).not.toBeNull();
    // ...and accepts a fragment that is not a delivery.
    expect(bare.includes(ts)).toBe(true);
    expect(bannerReached(densify(bare), ts)).toBeNull();
  });
});

describe('readTail', () => {
  it('returns the END of a file larger than the cap, not the beginning', () => {
    const p = join(tmp, 'big.log');
    writeFileSync(p, 'A'.repeat(5000) + 'TAILMARK', 'utf-8');
    const tail = readTail(p, 100);
    expect(tail.endsWith('TAILMARK')).toBe(true);
    expect(tail.length).toBe(100);
  });

  it('returns empty string for a missing file rather than throwing', () => {
    expect(readTail(join(tmp, 'nope.log'), 100)).toBe('');
  });

  it('readRotatedTail spans the rotated predecessor, newest content LAST', () => {
    const dir = join(tmp, 'logs', 'a');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'stdout.log.1'), 'OLDMARK', 'utf-8');
    writeFileSync(join(dir, 'stdout.log'), 'NEWMARK', 'utf-8');
    const out = readRotatedTail(dir, 'stdout.log', 1000);
    expect(out).toBe('OLDMARKNEWMARK');
    // negative control: the same call must NOT invent content when the rotated file is absent.
    const dir2 = join(tmp, 'logs', 'b');
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir2, 'stdout.log'), 'ONLYNEW', 'utf-8');
    expect(readRotatedTail(dir2, 'stdout.log', 1000)).toBe('ONLYNEW');
  });

  it('readRotatedTail spends the budget NEWEST-first and never exceeds it', () => {
    const dir = join(tmp, 'logs', 'c');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'stdout.log.1'), 'O'.repeat(500), 'utf-8');
    writeFileSync(join(dir, 'stdout.log'), 'N'.repeat(500), 'utf-8');
    const out = readRotatedTail(dir, 'stdout.log', 600);
    expect(out.length).toBe(600);
    // 500 newest bytes kept in full, only the remaining 100 spent on the older file.
    expect(out.endsWith('N'.repeat(500))).toBe(true);
    expect(out.startsWith('O'.repeat(100))).toBe(true);
  });

  it('REGRESSION: a banner living only in the ROTATED log still counts as a receipt', () => {
    // Measured cause: finance_tracker/stdout.log.1 held 1572 CRON FIRED banners against 1011 in the
    // current log. Reading only stdout.log scored those delivered fires as NONE, which this harness
    // reports as "the injection dropped and the producer is innocent" — rotation silently
    // MISATTRIBUTED BLAME using evidence I had failed to look at.
    const cronDir = join(tmp, CRONS_DIRECTORY, 'agent_a');
    mkdirSync(cronDir, { recursive: true });
    writeFileSync(
      join(cronDir, 'cron-execution.log'),
      JSON.stringify({ ts: '2026-07-29T21:00:14.085Z', cron: 'daily-hygiene', status: 'fired' }) + '\n',
      'utf-8',
    );
    const logDir = join(tmp, 'logs', 'agent_a');
    mkdirSync(logDir, { recursive: true });
    // Banner ONLY in the rotated file; current log has unrelated output.
    writeFileSync(
      join(logDir, 'stdout.log.1'),
      '[CRON FIRED 2026-07-29T21:00:14.085Z] daily-hygiene: go\n',
      'utf-8',
    );
    writeFileSync(join(logDir, 'stdout.log'), 'later unrelated output\n', 'utf-8');

    const res = findReceipt({
      agent: 'agent_a',
      cron: 'daily-hygiene',
      date: '2026-07-29',
      timezone: 'America/New_York',
      now: NOW,
      windowMs: 26 * 3_600_000,
    });
    expect(res.kind).toBe('stdout-banner');
  });
});

describe('findReceipt', () => {
  const base = {
    agent: 'agent_a',
    cron: 'daily-hygiene',
    date: '2026-07-29',
    timezone: 'America/New_York',
    now: NOW,
    windowMs: 26 * 3_600_000,
  };

  function writeFires(agent: string, records: Array<Record<string, unknown>>): void {
    const dir = join(tmp, CRONS_DIRECTORY, agent);
    mkdirSync(dir, { recursive: true });
    for (const r of records) {
      appendFileSync(join(dir, 'cron-execution.log'), JSON.stringify(r) + '\n', 'utf-8');
    }
  }

  it('prefers the receipts file — receiving-side evidence outranks a PTY banner', () => {
    const dir = join(tmp, 'state', 'agent_a');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, RECEIPTS_FILENAME),
      JSON.stringify({ ts: '2026-07-29T21:00:20Z', cron: 'daily-hygiene', status: 'success' }) + '\n',
      'utf-8',
    );
    const res = findReceipt(base);
    expect(res.kind).toBe('receipts-file');
    expect(res.evidence).toMatch(/status=success/);
  });

  it('ignores a receipts entry for a DIFFERENT cron on the same day', () => {
    const dir = join(tmp, 'state', 'agent_a');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, RECEIPTS_FILENAME),
      JSON.stringify({ ts: '2026-07-29T21:00:20Z', cron: 'other-cron' }) + '\n',
      'utf-8',
    );
    expect(findReceipt(base).kind).toBe('NONE');
  });

  it('falls back to a declared artifact path when no receipts file exists', () => {
    const artifactPath = join(tmp, 'declared.md');
    writeFileSync(artifactPath, 'content', 'utf-8');
    const res = findReceipt({ ...base, declared: { cron: 'daily-hygiene', path: artifactPath } });
    expect(res.kind).toBe('declared-path');
  });

  it('does NOT accept a declared artifact that is older than the window', () => {
    const artifactPath = join(tmp, 'stale.md');
    writeFileSync(artifactPath, 'content', 'utf-8');
    const old = (NOW.getTime() - 40 * 3_600_000) / 1000;
    utimesSync(artifactPath, old, old);
    const res = findReceipt({ ...base, declared: { cron: 'daily-hygiene', path: artifactPath } });
    expect(res.kind).toBe('NONE');
  });

  it('falls through to the stdout.log banner, and labels it as ARRIVAL rather than processing', () => {
    writeFires('agent_a', [
      { ts: '2026-07-29T21:00:14.085Z', cron: 'daily-hygiene', status: 'fired', duration_ms: 1 },
    ]);
    const logDir = join(tmp, 'logs', 'agent_a');
    mkdirSync(logDir, { recursive: true });
    writeFileSync(
      join(logDir, 'stdout.log'),
      '[CRON FIRED 2026-07-29T21:00:14.085Z] daily-hygiene: go\n',
      'utf-8',
    );
    const res = findReceipt(base);
    expect(res.kind).toBe('stdout-banner');
    expect(res.evidence).toMatch(/PTY arrival only, not processing/);
  });

  it('reports NONE — not a banner hit — when the daemon logged a fire that never reached the PTY', () => {
    // The injection-drop fingerprint: status=fired, duration_ms 0-1, and no banner anywhere.
    writeFires('agent_a', [
      { ts: '2026-07-29T21:00:14.085Z', cron: 'daily-hygiene', status: 'fired', duration_ms: 0 },
    ]);
    const logDir = join(tmp, 'logs', 'agent_a');
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, 'stdout.log'), 'ordinary output, no banner\n', 'utf-8');
    expect(findReceipt(base).kind).toBe('NONE');
  });

  it('SABOTAGE: a scheduler-side fired record alone must NEVER count as a receipt', () => {
    writeFires('agent_a', [
      { ts: '2026-07-29T21:00:14.085Z', cron: 'daily-hygiene', status: 'fired', duration_ms: 1 },
    ]);
    // No stdout.log at all, no receipts file, no declared path. cron-execution.log says "fired".
    const res = findReceipt(base);
    expect(res.kind).toBe('NONE');
  });

  it('attributes a UTC-stamped receipt to the LOCAL day it belongs to, not to the day its string starts with', () => {
    // 2026-07-30T01:30Z is 21:30 on 2026-07-29 in New York. A string-prefix compare against the
    // local day '2026-07-29' misses it entirely and reports a healthy fire as having no receipt —
    // the same UTC-vs-local mistake that had two chef crons firing four hours late since June.
    const utcStamped = '2026-07-30T01:30:00.000Z';
    const dir = join(tmp, 'state', 'agent_a');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, RECEIPTS_FILENAME),
      JSON.stringify({ ts: utcStamped, cron: 'daily-hygiene', status: 'success' }) + '\n',
      'utf-8',
    );
    expect(utcStamped.startsWith('2026-07-29')).toBe(false); // a prefix compare would miss it
    expect(findReceipt(base).kind).toBe('receipts-file');
  });

  it('does NOT attribute a receipt from a different local day', () => {
    const dir = join(tmp, 'state', 'agent_a');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, RECEIPTS_FILENAME),
      // 12:00Z on 07-30 is 08:00 on 07-30 local — the day AFTER the one being asked about.
      JSON.stringify({ ts: '2026-07-30T12:00:00.000Z', cron: 'daily-hygiene' }) + '\n',
      'utf-8',
    );
    expect(findReceipt(base).kind).toBe('NONE');
  });

  it('accepts a STEP-0 task created seconds after a real fire', () => {
    writeFires('agent_a', [
      { ts: '2026-07-29T21:00:14.085Z', cron: 'daily-hygiene', status: 'fired', duration_ms: 1 },
    ]);
    const res = findReceipt({
      ...base,
      org: 'TestOrg',
      taskSource: () => [
        { id: 't1', title: 'STEP-0 daily-hygiene', created_at: '2026-07-29T21:00:19.000Z' },
      ],
    });
    expect(res.kind).toBe('bus-task');
    expect(res.evidence).toMatch(/5s after the/);
  });

  it('REGRESSION: a remediation task naming the cron hours later is NOT a receipt', () => {
    // Observed on real data, and it is the worst possible false positive: the tasks filed while
    // INVESTIGATING two dropped fires contained the cron name and were scored as receipts, so the
    // artifact proving the cron failed read as proof it succeeded. Title text alone cannot separate
    // these; distance from the fire can.
    writeFires('agent_a', [
      { ts: '2026-07-29T21:00:14.085Z', cron: 'daily-hygiene', status: 'fired', duration_ms: 1 },
    ]);
    const res = findReceipt({
      ...base,
      org: 'TestOrg',
      taskSource: () => [
        {
          id: 't2',
          title: 'daily-hygiene missed-fire recovery (07-29 21:00 UTC)',
          created_at: '2026-07-30T03:55:56.000Z',
        },
      ],
    });
    expect(res.kind).toBe('NONE');
  });

  it('STEP-0 window boundary: 30 minutes after the fire is accepted, one second later is not', () => {
    writeFires('agent_a', [
      { ts: '2026-07-29T21:00:00.000Z', cron: 'daily-hygiene', status: 'fired', duration_ms: 1 },
    ]);
    const at = findReceipt({
      ...base,
      org: 'TestOrg',
      taskSource: () => [
        { id: 't3', title: 'daily-hygiene', created_at: '2026-07-29T21:30:00.000Z' },
      ],
    });
    const over = findReceipt({
      ...base,
      org: 'TestOrg',
      taskSource: () => [
        { id: 't4', title: 'daily-hygiene', created_at: '2026-07-29T21:30:01.000Z' },
      ],
    });
    expect(at.kind).toBe('bus-task');
    expect(over.kind).toBe('NONE');
  });

  it('rejects a task created BEFORE the fire — a receipt cannot precede what it evidences', () => {
    writeFires('agent_a', [
      { ts: '2026-07-29T21:00:00.000Z', cron: 'daily-hygiene', status: 'fired', duration_ms: 1 },
    ]);
    const res = findReceipt({
      ...base,
      org: 'TestOrg',
      taskSource: () => [
        { id: 't5', title: 'daily-hygiene', created_at: '2026-07-29T20:59:59.000Z' },
      ],
    });
    expect(res.kind).toBe('NONE');
  });

  it('a task with NO fire on record is not a receipt — nothing for it to be the receipt OF', () => {
    // No cron-execution.log at all. Someone did the work; that says nothing about whether the
    // injection arrived, which is the only question this function answers.
    const res = findReceipt({
      ...base,
      org: 'TestOrg',
      taskSource: () => [
        { id: 't6', title: 'daily-hygiene', created_at: '2026-07-29T21:00:05.000Z' },
      ],
    });
    expect(res.kind).toBe('NONE');
  });

  it('NOT-CHECKED is distinct from NONE when there is nowhere to look', () => {
    delete process.env.CTX_ROOT;
    expect(findReceipt({ ...base, ctxRoot: undefined }).kind).toBe('NOT-CHECKED');
  });
});

describe('sweepExpectations coverage', () => {
  it('counts an unresolvable cron in the DENOMINATOR, so a shrinking numerator cannot read as clean', () => {
    const dir = agentDir('agent_a');
    writeManifest(dir, [
      { id: 'ok-artifact', type: 'artifact-fresh', path: '/vault/notes.md', max_age: '26h' },
      { id: 'ok-prompt', type: 'prompt-matches-doc', cron: 'heartbeat', doc: 'H.md', inline_forbidden: ['NIGHT MODE:'] },
      { id: 'gone-prompt', type: 'prompt-matches-doc', cron: 'deleted-cron', doc: 'H.md', inline_forbidden: ['NIGHT MODE:'] },
      { id: 'bad', type: 'artifact-fresh', path: '/x', max_age: 'whenever' },
    ]);
    writeLiveCrons('agent_a', [{ name: 'heartbeat', prompt: 'Read HEARTBEAT.md.' }]);

    const probe = probeFrom({ '/vault/notes.md': { bytes: 9999, ageMs: 3_600_000 } });
    const res = sweepExpectations(tmp, NOW, probe);

    expect(res.coverage.declared).toBe(4);
    expect(res.coverage.evaluable).toBe(2);
    expect(res.coverage.notEvaluable).toEqual([
      { agent: 'agent_a', id: 'gone-prompt', reason: 'no live cron by that name' },
    ]);
    expect(res.coverage.rejected.map((r) => r.id)).toEqual(['bad']);
    expect(res.findings).toHaveLength(0);
    // The point of the test: zero findings while a QUARTER of the manifest is unevaluable.
    expect(res.coverage.evaluable).toBeLessThan(res.coverage.declared);
  });

  it('counts receipt coverage separately from findings — an expectation with no declared receipt is a gap', () => {
    const dir = agentDir('agent_a');
    writeManifest(dir, [
      { id: 'with-receipt', type: 'artifact-fresh', path: '/vault/a.md', max_age: '26h', receipt: { cron: 'daily-hygiene' } },
      { id: 'no-receipt', type: 'artifact-fresh', path: '/vault/b.md', max_age: '26h' },
    ]);
    const stateDir = join(tmp, 'state', 'agent_a');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, RECEIPTS_FILENAME),
      JSON.stringify({ ts: '2026-07-29T21:00:20Z', cron: 'daily-hygiene', status: 'success' }) + '\n',
      'utf-8',
    );

    const probe = probeFrom({
      '/vault/a.md': { bytes: 9999, ageMs: 3_600_000 },
      '/vault/b.md': { bytes: 9999, ageMs: 3_600_000 },
    });
    const res = sweepExpectations(tmp, NOW, probe);

    expect(res.coverage.receiptEligible).toBe(2);
    expect(res.coverage.receiptDeclared).toBe(1);
    expect(res.coverage.receiptFound).toBe(1);
    expect(formatSweep(res)).toMatch(/1 artifact expectation\(s\) declare none/);
  });

  it('reproduces the real failing case: artifact MISSING and receipt NONE together point at the injection, not the producer', () => {
    const dir = agentDir('analyst');
    writeManifest(dir, [
      {
        id: 'analyst-theta-wave',
        type: 'artifact-fresh',
        path: '/vault/theta-{YYYY-MM-DD}.md',
        max_age: '26h',
        receipt: { cron: 'theta-wave' },
      },
    ]);
    // The daemon says it fired. Nothing else exists: no artifact, no STEP-0 task, no PTY banner.
    const cronDir = join(tmp, CRONS_DIRECTORY, 'analyst');
    mkdirSync(cronDir, { recursive: true });
    writeFileSync(
      join(cronDir, 'cron-execution.log'),
      JSON.stringify({ ts: '2026-07-29T00:00:11.004Z', cron: 'theta-wave', status: 'fired', duration_ms: 1 }) + '\n',
      'utf-8',
    );

    const res = sweepExpectations(tmp, NOW, probeFrom({}));
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]).toMatchObject({ agent: 'analyst', id: 'analyst-theta-wave', kind: 'MISSING' });
    expect(res.findings[0].receipt?.kind).toBe('NONE');
    expect(formatSweep(res)).toMatch(/receipt: NONE/);
  });

  it('reproduces the passing counterweight: full coverage with zero new instrumentation stays silent', () => {
    // todoist_keeper's shape — a receipts artifact already on disk, nothing new built.
    const dir = agentDir('todoist_keeper');
    const logPath = join(tmp, 'todoist-keeper-log.md');
    writeFileSync(logPath, '# log\n\nreal entry\nanother entry\n', 'utf-8');
    writeManifest(dir, [
      {
        id: 'tk-daily-hygiene',
        type: 'artifact-fresh',
        path: logPath,
        max_age: '26h',
        min_bytes: 10,
        min_body_lines: 2,
        receipt: { cron: 'daily-hygiene', path: logPath },
      },
    ]);

    const res = sweepExpectations(tmp, NOW);
    expect(res.findings).toHaveLength(0);
    expect(res.coverage.receiptFound).toBe(1);
    expect(formatSweep(res)).toMatch(/No expectation failures/);
  });

  it('one unparseable manifest does not stop other agents being evaluated', () => {
    const bad = agentDir('agent_bad');
    writeFileSync(join(bad, 'expectations.json'), 'not json at all', 'utf-8');
    const good = agentDir('agent_good');
    writeManifest(good, [{ id: 'g1', type: 'artifact-fresh', path: '/vault/g.md', max_age: '26h' }]);

    const res = sweepExpectations(tmp, NOW, probeFrom({}));
    expect(res.findings.map((f) => f.agent)).toEqual(['agent_good']);
    expect(res.coverage.rejected.map((r) => r.agent)).toEqual(['agent_bad']);
  });
});

describe('speculative expectations', () => {
  it('defaults to false when the manifest does not say otherwise', () => {
    const dir = agentDir('agent_a');
    writeManifest(dir, [{ id: 'a1', type: 'artifact-fresh', path: '/x', max_age: '26h' }]);
    expect(readExpectations('agent_a', dir).expectations[0].speculative).toBe(false);
  });

  it('counts them in coverage without hiding them from findings', () => {
    const dir = agentDir('agent_a');
    writeManifest(dir, [
      { id: 'guessed', type: 'artifact-fresh', path: '/vault/guessed.md', max_age: '26h', speculative: true },
    ]);
    const res = sweepExpectations(tmp, NOW, probeFrom({}));
    expect(res.coverage.speculative).toBe(1);
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0].speculative).toBe(true);
  });

  it('ranks a speculative failure BELOW a confirmed one, so a naming error cannot bury an outage', () => {
    const dir = agentDir('agent_a');
    writeManifest(dir, [
      // The speculative entry is declared FIRST and would sort first alphabetically by id.
      { id: 'aaa-guessed', type: 'artifact-fresh', path: '/vault/guessed.md', max_age: '26h', speculative: true },
      { id: 'zzz-real', type: 'artifact-fresh', path: '/vault/real.md', max_age: '26h' },
    ]);
    const out = formatSweep(sweepExpectations(tmp, NOW, probeFrom({})));
    const confirmedAt = out.indexOf('zzz-real');
    const speculativeAt = out.indexOf('aaa-guessed');
    expect(confirmedAt).toBeGreaterThan(-1);
    expect(speculativeAt).toBeGreaterThan(-1);
    expect(confirmedAt).toBeLessThan(speculativeAt);
    expect(out).toMatch(/on CONFIRMED expectations/);
    expect(out).toMatch(/on SPECULATIVE expectations/);
  });

  it('marks a PASSING speculative expectation as promotable — a provisional flag nobody removes decays into noise', () => {
    const dir = agentDir('agent_a');
    writeManifest(dir, [
      { id: 'guess-was-right', type: 'artifact-fresh', path: '/vault/real.md', max_age: '26h', speculative: true },
    ]);
    const probe = probeFrom({ '/vault/real.md': { bytes: 9999, ageMs: 3_600_000 } });
    const res = sweepExpectations(tmp, NOW, probe);
    expect(res.findings).toHaveLength(0);
    expect(res.coverage.promotable).toEqual([{ agent: 'agent_a', id: 'guess-was-right' }]);
    expect(formatSweep(res)).toMatch(/remove `"speculative": true`/);
  });

  it('does NOT mark a passing CONFIRMED expectation as promotable — there is nothing to promote', () => {
    const dir = agentDir('agent_a');
    writeManifest(dir, [
      { id: 'already-confirmed', type: 'artifact-fresh', path: '/vault/real.md', max_age: '26h' },
    ]);
    const probe = probeFrom({ '/vault/real.md': { bytes: 9999, ageMs: 3_600_000 } });
    expect(sweepExpectations(tmp, NOW, probe).coverage.promotable).toEqual([]);
  });

  it('applies to prompt-matches-doc too: a speculative DRIFT ranks below a confirmed one', () => {
    const dir = agentDir('agent_a');
    writeManifest(dir, [
      { id: 'aaa-guessed-prompt', type: 'prompt-matches-doc', cron: 'heartbeat', doc: 'H.md', inline_forbidden: ['NIGHT MODE:'], max_prompt_chars: 400, speculative: true },
      { id: 'zzz-real-prompt', type: 'prompt-matches-doc', cron: 'other', doc: 'O.md', inline_forbidden: ['NIGHT MODE:'], max_prompt_chars: 400 },
    ]);
    writeLiveCrons('agent_a', [
      { name: 'heartbeat', prompt: 'NIGHT MODE: quiet' },
      { name: 'other', prompt: 'NIGHT MODE: quiet' },
    ]);
    const out = formatSweep(sweepExpectations(tmp, NOW, probeFrom({})));
    expect(out.indexOf('zzz-real-prompt')).toBeLessThan(out.indexOf('aaa-guessed-prompt'));
  });
});

describe('speculative shelf life', () => {
  function guessed(over: Record<string, unknown>) {
    const dir = agentDir('agent_a');
    writeManifest(dir, [
      {
        id: 'guessed',
        type: 'artifact-fresh',
        path: '/vault/guessed.md',
        max_age: '26h',
        speculative: true,
        ...over,
      },
    ]);
    return sweepExpectations(tmp, NOW, probeFrom({}));
  }

  it('reports the age of a failing speculative flag on the finding line', () => {
    const res = guessed({ speculative_since: '2026-07-20' });
    expect(res.findings[0].speculativeDays).toBe(10);
    expect(formatSweep(res)).toMatch(/\[speculative 10d\]/);
  });

  it('shelf-life boundary: 14 days is tolerated, 15 is confirm-or-delete', () => {
    // NOW is 2026-07-30T02:00Z. 07-16 is 14d, 07-15 is 15d.
    expect(guessed({ speculative_since: '2026-07-16' }).coverage.speculativeStale).toEqual([]);
    expect(guessed({ speculative_since: '2026-07-15' }).coverage.speculativeStale).toEqual([
      { agent: 'agent_a', id: 'guessed', days: 15 },
    ]);
  });

  it('treats an UNDATED speculative failure as stale immediately — omitting one field must not buy permanence', () => {
    const res = guessed({});
    expect(res.findings[0].speculativeDays).toBeNull();
    expect(res.coverage.speculativeStale).toEqual([
      { agent: 'agent_a', id: 'guessed', days: null },
    ]);
    expect(formatSweep(res)).toMatch(/NO DATE — add speculative_since/);
    expect(formatSweep(res)).toMatch(/no speculative_since declared/);
  });

  it('an unparseable date is treated as undated, not as day zero', () => {
    expect(guessed({ speculative_since: 'last tuesday' }).coverage.speculativeStale).toEqual([
      { agent: 'agent_a', id: 'guessed', days: null },
    ]);
  });

  it('a PASSING speculative expectation is never stale — it is promotable instead', () => {
    const dir = agentDir('agent_a');
    writeManifest(dir, [
      {
        id: 'old-but-passing',
        type: 'artifact-fresh',
        path: '/vault/real.md',
        max_age: '26h',
        speculative: true,
        speculative_since: '2026-01-01',
      },
    ]);
    const res = sweepExpectations(tmp, NOW, probeFrom({ '/vault/real.md': { bytes: 9999, ageMs: 1_000 } }));
    expect(res.coverage.speculativeStale).toEqual([]);
    expect(res.coverage.promotable).toHaveLength(1);
  });

  it('a CONFIRMED failure is never bucketed as stale, however old the expectation is', () => {
    const dir = agentDir('agent_a');
    writeManifest(dir, [
      { id: 'confirmed', type: 'artifact-fresh', path: '/vault/gone.md', max_age: '26h' },
    ]);
    const res = sweepExpectations(tmp, NOW, probeFrom({}));
    expect(res.findings).toHaveLength(1);
    expect(res.coverage.speculativeStale).toEqual([]);
    expect(formatSweep(res)).not.toMatch(/\[speculative/);
  });
});

describe('writeRunReceipt', () => {
  it('appends under state/<agent>/ with the ts first, creating the directory', () => {
    const p = writeRunReceipt(tmp, 'builder_1', 'cron-drift-receipt.jsonl', { cron: 'x', findings: 0 }, NOW);
    expect(p).toBe(join(tmp, 'state', 'builder_1', 'cron-drift-receipt.jsonl'));
    expect(JSON.parse(readFileSync(p, 'utf-8').trim())).toEqual({
      ts: NOW.toISOString(),
      cron: 'x',
      findings: 0,
    });
  });

  it('writes on a CLEAN run too — otherwise "ran, found nothing" is indistinguishable from "never ran"', () => {
    const p = writeRunReceipt(tmp, 'builder_1', 'r.jsonl', { findings: 0 }, NOW);
    expect(JSON.parse(readFileSync(p, 'utf-8').trim()).findings).toBe(0);
  });
});

describe('writeCheckerReceipt', () => {
  it('appends a line on every run so a DIFFERENT agent can notice this checker going mute', () => {
    const empty = sweepExpectations(tmp, NOW, probeFrom({}));
    const p = writeCheckerReceipt(tmp, 'builder_1', empty, NOW);
    writeCheckerReceipt(tmp, 'builder_1', empty, NOW);
    const lines = require('fs').readFileSync(p, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ cron: 'check-expectations', ts: NOW.toISOString() });
  });
});
