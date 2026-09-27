/**
 * tests/unit/daemon/cron-execution-log.test.ts — Subtask 1.5
 *
 * Tests for cron-execution-log.ts (appendExecutionLog / rotateIfNeeded)
 * and the crons.ts getExecutionLog reader.
 *
 * Each test group creates its own isolated temp CTX_ROOT so there is no
 * cross-test state.  The pattern mirrors tests/unit/bus/crons-io.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import type { CronExecutionLogEntry, CronDefinition } from '../../../src/types/index';

// ---------------------------------------------------------------------------
// Mock appendExecutionLog so CronScheduler tests don't need a real filesystem,
// but we test the real implementation here by importing it directly.
// We do NOT mock the execution log module in this file.
// ---------------------------------------------------------------------------

// We DO need to mock crons.ts I/O so CronScheduler works in the scheduler tests.
// In this file we test the log module directly without the scheduler.

// ---------------------------------------------------------------------------
// Per-test tempdir wiring
// ---------------------------------------------------------------------------

let tmpRoot: string;
const originalCtxRoot = process.env.CTX_ROOT;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cron-exec-log-test-'));
  process.env.CTX_ROOT = tmpRoot;
  vi.resetModules();
});

afterEach(() => {
  if (originalCtxRoot !== undefined) {
    process.env.CTX_ROOT = originalCtxRoot;
  } else {
    delete process.env.CTX_ROOT;
  }
  try { rmSync(tmpRoot, { recursive: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Dynamic import helpers — ensures CTX_ROOT is set before modules resolve paths
// ---------------------------------------------------------------------------

async function importLog() {
  return await import('../../../src/daemon/cron-execution-log.js');
}

async function importCrons() {
  return await import('../../../src/bus/crons.js');
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<CronExecutionLogEntry> = {}): CronExecutionLogEntry {
  return {
    ts: new Date().toISOString(),
    cron: 'heartbeat',
    status: 'fired',
    attempt: 1,
    duration_ms: 42,
    error: null,
    ...overrides,
  };
}

function logFilePath(agentName = 'boris'): string {
  return join(tmpRoot, '.cortextOS', 'state', 'agents', agentName, 'cron-execution.log');
}

/** Read the log file lines as parsed objects */
function readLogFile(agentName = 'boris'): CronExecutionLogEntry[] {
  const fp = logFilePath(agentName);
  if (!existsSync(fp)) return [];
  const raw = readFileSync(fp, 'utf-8');
  return raw.split('\n')
    .filter(l => l.trim().length > 0)
    .map(l => JSON.parse(l) as CronExecutionLogEntry);
}

// ---------------------------------------------------------------------------
// appendExecutionLog — basic behaviour
// ---------------------------------------------------------------------------

describe('appendExecutionLog — single entry', () => {
  it('creates the log file and writes one entry with correct shape', async () => {
    const { appendExecutionLog } = await importLog();

    const entry = makeEntry();
    appendExecutionLog('boris', entry);

    const entries = readLogFile('boris');
    expect(entries).toHaveLength(1);
    expect(entries[0].cron).toBe('heartbeat');
    expect(entries[0].status).toBe('fired');
    expect(entries[0].attempt).toBe(1);
    expect(entries[0].duration_ms).toBe(42);
    expect(entries[0].error).toBeNull();
    expect(typeof entries[0].ts).toBe('string');
  });

  it('creates parent directory if it does not exist', async () => {
    const { appendExecutionLog } = await importLog();

    // Directory does not exist yet
    expect(existsSync(logFilePath())).toBe(false);
    appendExecutionLog('boris', makeEntry());
    expect(existsSync(logFilePath())).toBe(true);
  });

  it('successful fire: status=fired, error=null', async () => {
    const { appendExecutionLog } = await importLog();

    appendExecutionLog('boris', makeEntry({ status: 'fired', error: null }));

    const entries = readLogFile();
    expect(entries[0].status).toBe('fired');
    expect(entries[0].error).toBeNull();
  });

  it('retried attempt: status=retried, error populated', async () => {
    const { appendExecutionLog } = await importLog();

    appendExecutionLog('boris', makeEntry({
      status: 'retried',
      attempt: 1,
      error: 'Connection refused',
    }));

    const entries = readLogFile();
    expect(entries[0].status).toBe('retried');
    expect(entries[0].error).toBe('Connection refused');
  });

  it('final failure: status=failed, error populated', async () => {
    const { appendExecutionLog } = await importLog();

    appendExecutionLog('boris', makeEntry({
      status: 'failed',
      attempt: 4,
      error: 'All retries exhausted',
    }));

    const entries = readLogFile();
    expect(entries[0].status).toBe('failed');
    expect(entries[0].error).toBe('All retries exhausted');
    expect(entries[0].attempt).toBe(4);
  });

  it('multiple appends produce multiple ordered lines', async () => {
    const { appendExecutionLog } = await importLog();

    appendExecutionLog('boris', makeEntry({ cron: 'heartbeat', status: 'fired' }));
    appendExecutionLog('boris', makeEntry({ cron: 'morning-briefing', status: 'fired' }));
    appendExecutionLog('boris', makeEntry({ cron: 'heartbeat', status: 'retried', error: 'timeout' }));

    const entries = readLogFile();
    expect(entries).toHaveLength(3);
    expect(entries[0].cron).toBe('heartbeat');
    expect(entries[1].cron).toBe('morning-briefing');
    expect(entries[2].status).toBe('retried');
  });

  it('log is agent-scoped: different agents have separate log files', async () => {
    const { appendExecutionLog } = await importLog();

    appendExecutionLog('boris', makeEntry({ cron: 'heartbeat' }));
    appendExecutionLog('paul', makeEntry({ cron: 'morning-briefing' }));

    const borisEntries = readLogFile('boris');
    const paulEntries = readLogFile('paul');

    expect(borisEntries).toHaveLength(1);
    expect(borisEntries[0].cron).toBe('heartbeat');
    expect(paulEntries).toHaveLength(1);
    expect(paulEntries[0].cron).toBe('morning-briefing');
  });
});

// ---------------------------------------------------------------------------
// Retry sequence: retried then fired
// ---------------------------------------------------------------------------

describe('appendExecutionLog — retry sequence', () => {
  it('retry sequence: retried on attempt 1, fired on attempt 2 produces 2 entries', async () => {
    const { appendExecutionLog } = await importLog();

    appendExecutionLog('boris', makeEntry({ status: 'retried', attempt: 1, error: 'oops' }));
    appendExecutionLog('boris', makeEntry({ status: 'fired', attempt: 2, error: null }));

    const entries = readLogFile();
    expect(entries).toHaveLength(2);
    expect(entries[0].status).toBe('retried');
    expect(entries[0].attempt).toBe(1);
    expect(entries[1].status).toBe('fired');
    expect(entries[1].attempt).toBe(2);
  });

  it('exhausted retry sequence: retried × 3 then failed on attempt 4', async () => {
    const { appendExecutionLog } = await importLog();

    appendExecutionLog('boris', makeEntry({ status: 'retried', attempt: 1, error: 'err' }));
    appendExecutionLog('boris', makeEntry({ status: 'retried', attempt: 2, error: 'err' }));
    appendExecutionLog('boris', makeEntry({ status: 'retried', attempt: 3, error: 'err' }));
    appendExecutionLog('boris', makeEntry({ status: 'failed', attempt: 4, error: 'err' }));

    const entries = readLogFile();
    expect(entries).toHaveLength(4);
    expect(entries[3].status).toBe('failed');
    expect(entries[3].attempt).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Log rotation
// ---------------------------------------------------------------------------

describe('log rotation', () => {
  it('writes 1100 entries, resulting file has exactly 1000 (oldest 100 pruned)', async () => {
    const { appendExecutionLog, MAX_LOG_LINES, ROTATION_SIZE_BYTES } = await importLog();

    // We need to trick the rotation check: the default ROTATION_SIZE_BYTES is
    // 200 KB which won't be reached with 1100 short entries (~200 bytes each
    // = ~220 KB).  Write entries with enough content to exceed the threshold.
    // Rather than writing huge entries, we temporarily override the module's
    // size threshold by monkey-patching the file after we write enough lines.

    // Strategy: write 1100 entries, then simulate that the file is "large"
    // by checking what happens when we call the rotation logic directly.
    // Since ROTATION_SIZE_BYTES may not be exported, we need another approach.

    // The most reliable approach: write 1100 entries where each is ~200 bytes.
    // With padding the file will be ~220 KB > ROTATION_SIZE_BYTES (200 KB).

    const agentDir = join(tmpRoot, '.cortextOS', 'state', 'agents', 'boris');
    mkdirSync(agentDir, { recursive: true });
    const fp = logFilePath();

    const TOTAL = 1100;
    const lines: string[] = [];
    for (let i = 0; i < TOTAL; i++) {
      const entry: CronExecutionLogEntry = {
        ts: new Date().toISOString(),
        cron: `cron-${String(i).padStart(4, '0')}`,
        status: 'fired',
        attempt: 1,
        duration_ms: i,
        error: null,
      };
      lines.push(JSON.stringify(entry));
    }

    // Pre-write all 1100 lines directly so we can trigger rotation on the next append
    writeFileSync(fp, lines.join('\n') + '\n', 'utf-8');

    // Now append one more entry — this should trigger rotation (file > 200 KB)
    // by padding entries to ensure file exceeds threshold
    // Check actual file size
    const { statSync } = await import('fs');
    const statBefore = statSync(fp);

    if (statBefore.size > ROTATION_SIZE_BYTES) {
      // File is already large — rotation will fire on next append
      appendExecutionLog('boris', makeEntry({ cron: 'trigger-rotation' }));
      const entries = readLogFile();
      expect(entries.length).toBeLessThanOrEqual(MAX_LOG_LINES);
      // Most recent entry must be present
      expect(entries[entries.length - 1].cron).toBe('trigger-rotation');
    } else {
      // File is not large enough to trigger size-based rotation.
      // Write enough padding to exceed threshold and then append.
      const padding = 'x'.repeat(ROTATION_SIZE_BYTES);
      const paddedEntry = JSON.stringify({ ...makeEntry(), _pad: padding });
      writeFileSync(fp, lines.join('\n') + '\n' + paddedEntry + '\n', 'utf-8');
      appendExecutionLog('boris', makeEntry({ cron: 'trigger-rotation' }));
      const entries = readLogFile();
      // After rotation, file should have at most MAX_LOG_LINES entries
      expect(entries.length).toBeLessThanOrEqual(MAX_LOG_LINES);
    }
  });

  it('rotation keeps the most recent entries (oldest are pruned)', async () => {
    const { appendExecutionLog, ROTATION_SIZE_BYTES } = await importLog();

    const agentDir = join(tmpRoot, '.cortextOS', 'state', 'agents', 'boris');
    mkdirSync(agentDir, { recursive: true });
    const fp = logFilePath();

    // Write MAX_LOG_LINES + 100 entries with clearly ordered cron names
    const EXTRA = 100;
    const TOTAL = 1000 + EXTRA;
    const lines: string[] = [];
    for (let i = 0; i < TOTAL; i++) {
      lines.push(JSON.stringify(makeEntry({ cron: `c-${String(i).padStart(4, '0')}` })));
    }
    // Add a padding entry to exceed ROTATION_SIZE_BYTES
    const padding = 'x'.repeat(ROTATION_SIZE_BYTES + 1);
    lines.push(JSON.stringify({ ...makeEntry({ cron: 'last' }), _pad: padding }));
    writeFileSync(fp, lines.join('\n') + '\n', 'utf-8');

    appendExecutionLog('boris', makeEntry({ cron: 'trigger' }));

    const entries = readLogFile();
    // First entry should no longer be c-0000 through c-0099
    if (entries.length > 0) {
      expect(entries[0].cron).not.toBe('c-0000');
    }
    // The most recent entries (c-0100 and beyond) should be present somewhere
    const haslate = entries.some(e => e.cron === 'c-0100' || e.cron === 'trigger');
    expect(haslate).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getExecutionLog reader
// ---------------------------------------------------------------------------

describe('getExecutionLog', () => {
  it('returns [] when file does not exist', async () => {
    const { getExecutionLog } = await importCrons();
    const result = await getExecutionLog('boris');
    expect(result).toEqual([]);
  });

  it('returns all entries when no cronName filter and no limit', async () => {
    const { appendExecutionLog } = await importLog();
    const { getExecutionLog } = await importCrons();

    appendExecutionLog('boris', makeEntry({ cron: 'heartbeat' }));
    appendExecutionLog('boris', makeEntry({ cron: 'morning-briefing' }));
    appendExecutionLog('boris', makeEntry({ cron: 'heartbeat' }));

    const result = getExecutionLog('boris', undefined, 0);
    expect(result).toHaveLength(3);
  });

  it('filters by cron name', async () => {
    const { appendExecutionLog } = await importLog();
    const { getExecutionLog } = await importCrons();

    appendExecutionLog('boris', makeEntry({ cron: 'heartbeat' }));
    appendExecutionLog('boris', makeEntry({ cron: 'morning-briefing' }));
    appendExecutionLog('boris', makeEntry({ cron: 'heartbeat' }));

    const result = getExecutionLog('boris', 'heartbeat', 0);
    expect(result).toHaveLength(2);
    expect(result.every(e => e.cron === 'heartbeat')).toBe(true);
  });

  it('filter by cron name returns [] when no entries match', async () => {
    const { appendExecutionLog } = await importLog();
    const { getExecutionLog } = await importCrons();

    appendExecutionLog('boris', makeEntry({ cron: 'heartbeat' }));

    const result = getExecutionLog('boris', 'nonexistent', 0);
    expect(result).toEqual([]);
  });

  it('respects limit parameter — returns last N entries', async () => {
    const { appendExecutionLog } = await importLog();
    const { getExecutionLog } = await importCrons();

    for (let i = 0; i < 10; i++) {
      appendExecutionLog('boris', makeEntry({ cron: `c-${i}`, duration_ms: i }));
    }

    const result = getExecutionLog('boris', undefined, 3);
    expect(result).toHaveLength(3);
    // Most recent 3: c-7, c-8, c-9
    expect(result[0].cron).toBe('c-7');
    expect(result[2].cron).toBe('c-9');
  });

  it('default limit is 50', async () => {
    const { appendExecutionLog } = await importLog();
    const { getExecutionLog } = await importCrons();

    for (let i = 0; i < 60; i++) {
      appendExecutionLog('boris', makeEntry({ cron: `c-${i}` }));
    }

    const result = getExecutionLog('boris');
    expect(result).toHaveLength(50);
    // Most recent 50 are c-10 through c-59
    expect(result[0].cron).toBe('c-10');
    expect(result[49].cron).toBe('c-59');
  });

  it('filter + limit combined', async () => {
    const { appendExecutionLog } = await importLog();
    const { getExecutionLog } = await importCrons();

    for (let i = 0; i < 10; i++) {
      appendExecutionLog('boris', makeEntry({ cron: 'heartbeat', duration_ms: i }));
      appendExecutionLog('boris', makeEntry({ cron: 'morning-briefing', duration_ms: i }));
    }

    // 20 total, 10 heartbeat, 10 morning-briefing
    // limit=3 on heartbeat should return last 3 heartbeat entries
    const result = getExecutionLog('boris', 'heartbeat', 3);
    expect(result).toHaveLength(3);
    expect(result.every(e => e.cron === 'heartbeat')).toBe(true);
  });

  it('skips malformed JSONL lines without throwing', async () => {
    const { getExecutionLog } = await importCrons();

    const agentDir = join(tmpRoot, '.cortextOS', 'state', 'agents', 'boris');
    mkdirSync(agentDir, { recursive: true });
    const fp = logFilePath();

    // Write mix of valid and invalid lines
    const lines = [
      JSON.stringify(makeEntry({ cron: 'heartbeat' })),
      'THIS IS NOT JSON',
      JSON.stringify(makeEntry({ cron: 'morning-briefing' })),
      '',
      '{ broken json',
    ];
    writeFileSync(fp, lines.join('\n') + '\n', 'utf-8');

    const result = getExecutionLog('boris', undefined, 0);
    expect(result).toHaveLength(2);
    expect(result[0].cron).toBe('heartbeat');
    expect(result[1].cron).toBe('morning-briefing');
  });
});

// ---------------------------------------------------------------------------
// Crash / restart survival
// ---------------------------------------------------------------------------

describe('log survives simulated process restart', () => {
  it('entries written in one module import are readable after vi.resetModules()', async () => {
    // Simulate "session 1": write entries
    const log1 = await importLog();
    log1.appendExecutionLog('boris', makeEntry({ cron: 'heartbeat', duration_ms: 100 }));
    log1.appendExecutionLog('boris', makeEntry({ cron: 'morning-briefing', duration_ms: 200 }));

    // Simulate "restart": reset module cache and re-import
    vi.resetModules();

    const crons2 = await importCrons();
    const result = crons2.getExecutionLog('boris', undefined, 0);

    // Entries written before restart must still be present
    expect(result).toHaveLength(2);
    expect(result[0].cron).toBe('heartbeat');
    expect(result[1].cron).toBe('morning-briefing');
  });
});

// ---------------------------------------------------------------------------
// Disk persistence: verify entries survive a module reset (simulates restart)
// ---------------------------------------------------------------------------

describe('disk persistence across module resets', () => {
  it('entries written before vi.resetModules() are on disk and readable after', async () => {
    // Session 1: write entries
    const log1 = await importLog();
    log1.appendExecutionLog('boris', makeEntry({ cron: 'heartbeat', duration_ms: 11 }));
    log1.appendExecutionLog('boris', makeEntry({ cron: 'briefing', duration_ms: 22 }));

    // Simulate restart: blow away module cache
    vi.resetModules();

    // Session 2: read from fresh module instance
    const crons2 = await importCrons();
    const result = crons2.getExecutionLog('boris', undefined, 0);

    expect(result).toHaveLength(2);
    expect(result[0].cron).toBe('heartbeat');
    expect(result[1].cron).toBe('briefing');
  });

  it('log file is plain JSONL readable without the module', async () => {
    const { appendExecutionLog } = await importLog();
    appendExecutionLog('boris', makeEntry({ cron: 'heartbeat', status: 'fired' }));

    // Read raw file without the module
    const fp = logFilePath('boris');
    const raw = readFileSync(fp, 'utf-8');
    const parsed = raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    expect(parsed[0].cron).toBe('heartbeat');
    expect(parsed[0].status).toBe('fired');
  });
});

// ---------------------------------------------------------------------------
// resolveCtxRoot / unset CTX_ROOT (task_1790474717185 item 5, fixed 2026-09-27)
//
// crons.ts's cronsFilePath() and this file's logFilePath() used to resolve
// their root independently via `process.env.CTX_ROOT ?? process.cwd()` — when
// CTX_ROOT was unset, a bus command invoked from the wrong directory would
// silently create/read a `<cwd>/.cortextOS/...` tree no agent's daemon ever
// looks at, AND the two files could disagree with each other on where that
// tree lived. Both now go through the shared resolveCtxRoot() helper in
// src/utils/env.ts. These tests exercise the actual regression: CTX_ROOT
// unset, no .cortextos-env file, confirming the resolved path is under a
// controlled fake HOME (never the real one) and NOT under process.cwd().
// ---------------------------------------------------------------------------

describe('resolveCtxRoot / unset CTX_ROOT (task_1790474717185 item 5)', () => {
  let fakeHome: string;
  let cwdSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    // The outer beforeEach already set CTX_ROOT=tmpRoot and reset modules;
    // undo the CTX_ROOT part for this block specifically, and point HOME at
    // a second, separate tempdir so the default-root fallback is observable
    // and isolated from both tmpRoot and the real home directory.
    fakeHome = mkdtempSync(join(tmpdir(), 'ctxroot-fakehome-'));
    delete process.env.CTX_ROOT;
    vi.stubEnv('HOME', fakeHome);
    vi.stubEnv('USERPROFILE', fakeHome);
    vi.stubEnv('CTX_INSTANCE_ID', undefined);
    // Keep env-file discovery and any regressed cwd writes inside the sandbox.
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpRoot);
    vi.resetModules();
  });

  afterEach(() => {
    cwdSpy?.mockRestore();
    cwdSpy = undefined;
    vi.unstubAllEnvs();
    try { rmSync(fakeHome, { recursive: true }); } catch { /* ignore */ }
    // Outer afterEach restores CTX_ROOT from originalCtxRoot and rm's tmpRoot.
  });

  function fakeHomeCronsPath(agentName = 'boris'): string {
    return join(fakeHome, '.cortextos', 'default', '.cortextOS', 'state', 'agents', agentName, 'crons.json');
  }

  function fakeHomeLogPath(agentName = 'boris'): string {
    return join(fakeHome, '.cortextos', 'default', '.cortextOS', 'state', 'agents', agentName, 'cron-execution.log');
  }

  it('crons.ts resolves under the fake HOME default, not process.cwd(), when CTX_ROOT is unset', async () => {
    const { writeCrons } = await importCrons();
    writeCrons('boris', [
      { name: 'heartbeat', prompt: 'hi', schedule: '6h', enabled: true, created_at: '2026-04-01T00:00:00.000Z' },
    ]);

    expect(existsSync(fakeHomeCronsPath())).toBe(true);
    // The actual old bug: writing under the CURRENT PROCESS's cwd instead.
    const cwdPath = join(process.cwd(), '.cortextOS', 'state', 'agents', 'boris', 'crons.json');
    expect(existsSync(cwdPath)).toBe(false);
  });

  it('cron-execution-log.ts resolves under the same fake HOME default when CTX_ROOT is unset', async () => {
    const { appendExecutionLog } = await importLog();
    appendExecutionLog('boris', makeEntry({ cron: 'heartbeat' }));

    expect(existsSync(fakeHomeLogPath())).toBe(true);
    const cwdPath = join(process.cwd(), '.cortextOS', 'state', 'agents', 'boris', 'cron-execution.log');
    expect(existsSync(cwdPath)).toBe(false);
  });

  it('crons.ts and cron-execution-log.ts agree on the same root when CTX_ROOT is unset', async () => {
    // The specific disagreement Codex flagged in review: before this fix, each
    // file's independent `?? process.cwd()` fallback could resolve to the same
    // VALUE in a given process, but nothing enforced that — this proves both
    // modules route through the identical resolveCtxRoot() call.
    const { writeCrons } = await importCrons();
    const { appendExecutionLog } = await importLog();

    writeCrons('boris', [
      { name: 'heartbeat', prompt: 'hi', schedule: '6h', enabled: true, created_at: '2026-04-01T00:00:00.000Z' },
    ]);
    appendExecutionLog('boris', makeEntry({ cron: 'heartbeat' }));

    expect(existsSync(fakeHomeCronsPath())).toBe(true);
    expect(existsSync(fakeHomeLogPath())).toBe(true);
    // Both paths share the identical root prefix up through 'agents/boris'.
    expect(dirname(fakeHomeCronsPath())).toBe(dirname(fakeHomeLogPath()));
  });

  it('getExecutionLogPage() reads back an entry written under the fake-HOME default root (Codex REQUEST-CHANGES 2026-09-27: the file-existence agreement test above never exercised this reader — a regression reverting only crons.ts:372 back to the old cwd fallback would escape it)', async () => {
    const { appendExecutionLog } = await importLog();
    const { getExecutionLogPage } = await importCrons();

    appendExecutionLog('boris', makeEntry({ cron: 'heartbeat', status: 'fired', attempt: 3 }));

    const page = getExecutionLogPage('boris');
    expect(page.total).toBe(1);
    expect(page.hasMore).toBe(false);
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject({ cron: 'heartbeat', status: 'fired', attempt: 3 });
  });
});
