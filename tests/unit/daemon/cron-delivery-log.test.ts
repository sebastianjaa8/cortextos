/**
 * tests/unit/daemon/cron-delivery-log.test.ts — task_1786971045376 (2026-08-17)
 *
 * Tests for cron-delivery-log.ts (appendDeliveryLog / rotateIfNeeded), mirroring
 * cron-execution-log.test.ts's pattern for its sibling writer.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { CronDeliveryLogEntry } from '../../../src/types/index';

let tmpRoot: string;
const originalCtxRoot = process.env.CTX_ROOT;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cron-delivery-log-test-'));
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

async function importLog() {
  return await import('../../../src/daemon/cron-delivery-log.js');
}

function makeEntry(overrides: Partial<CronDeliveryLogEntry> = {}): CronDeliveryLogEntry {
  return {
    ts: new Date().toISOString(),
    cron: 'heartbeat',
    fired_at: new Date(Date.now() - 5000).toISOString(),
    waited_ms: 5000,
    trigger: 'quiet-boundary',
    ...overrides,
  };
}

function logFilePath(agentName = 'boris'): string {
  return join(tmpRoot, '.cortextOS', 'state', 'agents', agentName, 'cron-delivery.log');
}

function readLogFile(agentName = 'boris'): CronDeliveryLogEntry[] {
  const fp = logFilePath(agentName);
  if (!existsSync(fp)) return [];
  const raw = readFileSync(fp, 'utf-8');
  return raw.split('\n').filter(l => l.trim().length > 0).map(l => JSON.parse(l) as CronDeliveryLogEntry);
}

describe('appendDeliveryLog — single entry', () => {
  it('creates the log file and writes one entry with correct shape', async () => {
    const { appendDeliveryLog } = await importLog();
    appendDeliveryLog('boris', makeEntry());

    const entries = readLogFile('boris');
    expect(entries).toHaveLength(1);
    expect(entries[0].cron).toBe('heartbeat');
    expect(entries[0].trigger).toBe('quiet-boundary');
    expect(entries[0].waited_ms).toBe(5000);
    expect(typeof entries[0].ts).toBe('string');
    expect(typeof entries[0].fired_at).toBe('string');
  });

  it('creates parent directory if it does not exist', async () => {
    const { appendDeliveryLog } = await importLog();
    expect(existsSync(logFilePath())).toBe(false);
    appendDeliveryLog('boris', makeEntry());
    expect(existsSync(logFilePath())).toBe(true);
  });

  it('records the max-wait-valve trigger distinctly from quiet-boundary', async () => {
    const { appendDeliveryLog } = await importLog();
    appendDeliveryLog('boris', makeEntry({ trigger: 'max-wait-valve' }));

    const entries = readLogFile();
    expect(entries[0].trigger).toBe('max-wait-valve');
  });

  it('is agent-scoped: different agents have separate log files — this is the WHOLE POINT of the file existing separately per agent (mirrors cron-execution.log)', async () => {
    const { appendDeliveryLog } = await importLog();
    appendDeliveryLog('boris', makeEntry({ cron: 'heartbeat' }));
    appendDeliveryLog('paul', makeEntry({ cron: 'morning-briefing' }));

    const borisEntries = readLogFile('boris');
    const paulEntries = readLogFile('paul');
    expect(borisEntries).toHaveLength(1);
    expect(borisEntries[0].cron).toBe('heartbeat');
    expect(paulEntries).toHaveLength(1);
    expect(paulEntries[0].cron).toBe('morning-briefing');
  });

  it('multiple appends produce multiple ordered lines', async () => {
    const { appendDeliveryLog } = await importLog();
    appendDeliveryLog('boris', makeEntry({ cron: 'heartbeat' }));
    appendDeliveryLog('boris', makeEntry({ cron: 'autoresearch-pulse' }));

    const entries = readLogFile();
    expect(entries).toHaveLength(2);
    expect(entries[0].cron).toBe('heartbeat');
    expect(entries[1].cron).toBe('autoresearch-pulse');
  });

  it('never throws even if the write path is unwritable — observational only, must not crash the drain loop', async () => {
    const { appendDeliveryLog } = await importLog();
    // A path component that is a FILE, not a directory, makes mkdirSync/appendFileSync fail.
    const agentsDir = join(tmpRoot, '.cortextOS', 'state', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'blockedagent'), 'i am a file, not a directory');

    expect(() => appendDeliveryLog('blockedagent', makeEntry())).not.toThrow();
  });
});

describe('log rotation — mirrors cron-execution-log.ts, same threshold/behaviour', () => {
  it('rotation keeps the most recent entries when the file exceeds the size threshold', async () => {
    const { appendDeliveryLog, ROTATION_SIZE_BYTES, MAX_LOG_LINES } = await importLog();

    const agentDir = join(tmpRoot, '.cortextOS', 'state', 'agents', 'boris');
    mkdirSync(agentDir, { recursive: true });
    const fp = logFilePath();

    const TOTAL = 1000 + 100;
    const lines: string[] = [];
    for (let i = 0; i < TOTAL; i++) {
      lines.push(JSON.stringify(makeEntry({ cron: `c-${String(i).padStart(4, '0')}` })));
    }
    const padding = 'x'.repeat(ROTATION_SIZE_BYTES + 1);
    lines.push(JSON.stringify({ ...makeEntry({ cron: 'last' }), _pad: padding }));
    writeFileSync(fp, lines.join('\n') + '\n', 'utf-8');

    appendDeliveryLog('boris', makeEntry({ cron: 'trigger-rotation' }));

    // TIGHTENED after adversarial review (Codex): the original assertions permitted anywhere
    // from 1 to MAX_LOG_LINES entries and conditionally skipped the oldest-entry check when the
    // result was empty — a rotation that over-pruned to zero, or under-pruned to 999, would have
    // passed silently. EXACT count: file had 1101 lines pre-append + 1 appended = 1102 total,
    // pruned to precisely MAX_LOG_LINES, keeping the newest.
    const entries = readLogFile();
    expect(entries).toHaveLength(MAX_LOG_LINES);
    expect(entries[0].cron).not.toBe('c-0000');
    expect(entries[entries.length - 1].cron).toBe('trigger-rotation');
  });

  it('CONTROL: a small file well under the threshold is never rotated', async () => {
    const { appendDeliveryLog } = await importLog();
    for (let i = 0; i < 5; i++) appendDeliveryLog('boris', makeEntry({ cron: `c-${i}` }));

    const entries = readLogFile();
    expect(entries).toHaveLength(5);
  });
});

describe('disk persistence across module resets (simulated daemon restart)', () => {
  it('entries written before vi.resetModules() are still on disk and readable after', async () => {
    const log1 = await importLog();
    log1.appendDeliveryLog('boris', makeEntry({ cron: 'heartbeat' }));
    log1.appendDeliveryLog('boris', makeEntry({ cron: 'autoresearch-pulse' }));

    vi.resetModules();

    // Read raw, without re-importing the module's own reader (none exists yet) — plain JSONL.
    const fp = logFilePath('boris');
    const raw = readFileSync(fp, 'utf-8');
    const parsed = raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    expect(parsed).toHaveLength(2);
    expect(parsed[0].cron).toBe('heartbeat');
    expect(parsed[1].cron).toBe('autoresearch-pulse');
  });
});
