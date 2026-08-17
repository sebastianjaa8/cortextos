#!/usr/bin/env node
// Detects an agent whose kb-ingest heartbeat step (HEARTBEAT.md step 10, wrapped by
// scripts/kb-ingest-receipt.mjs) has silently stopped producing receipts.
//
// WHY THIS EXISTS (task_1786954838352, seb_boss 2026-08-17). brand_writer's kb-ingest step
// produced ZERO receipts for 104 hours / ~26 expected heartbeat cycles (2026-08-13T00:11Z to
// 2026-08-17T08:11Z) with no error surfaced anywhere — the wrapper itself only ever writes a
// receipt when it RUNS, so a step that never fires (a wedged session, a crashed heartbeat, a
// cron silently dropped) leaves nothing behind to notice. Same class this whole receipt/verdict
// family already fixed for the ingest ITSELF (kb-ingest-receipt.mjs's own header: "exited 0,
// ingested nothing" and "never wired" are indistinguishable from success without a receipt) —
// this file is the one level UP: is the receipt-writer itself still running at all.
//
// THIS IS NOT A kb-ingest-receipt.mjs BUG. Investigated first (task_1786954326936): the skip
// logic there is correctly gated on prior status (a ZERO-TOKENS prior forces retry regardless of
// matching hash) and behaved exactly as designed. The absence was operational — brand_writer's
// session was not completing heartbeat cycles — not a defect in the ingest wrapper.
//
//   node scripts/kb-ingest-gap-check.mjs              check the live fleet
//   node scripts/kb-ingest-gap-check.mjs --notify     also send ONE consolidated message to seb_boss
//   node scripts/kb-ingest-gap-check.mjs --json       raw JSON instead of the formatted report
//   node scripts/kb-ingest-gap-check.mjs --self-test  prove the verdict logic can fire AND come back clean
//
// exit 0 all clear · 2 a real finding (gap or never-wired) · 3 the check itself could not run.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const REPO = 'C:/Users/Sebas/cortextos';
const CTX_ROOT = (process.env.CTX_ROOT || `${process.env.HOME}/.cortextos/default`).replace(/\\/g, '/');
const DEFAULT_CYCLES = 2;

/**
 * Duration-form cron intervals only ("2h", "30m", "1d"). A cron-EXPRESSION heartbeat (5-field)
 * has no fixed cadence to multiply, so those agents are EXCLUDED and named, not silently skipped
 * or treated as a check failure — same "state what was narrowed" discipline as cron-drift's
 * utcOnlyExcluded/uncomparable lists.
 */
export function parseDurationMs(raw) {
  const m = /^(\d+)\s*(h|m|d)$/i.exec((raw || '').trim());
  if (!m) return null;
  const mult = { h: 3_600_000, m: 60_000, d: 86_400_000 }[m[2].toLowerCase()];
  return Number(m[1]) * mult;
}

/** @returns {number|null} the heartbeat cron's interval in ms, or null if not interval-form / absent. */
export function heartbeatIntervalMs(cronsJson) {
  const hb = (cronsJson?.crons || []).find((c) => c.name === 'heartbeat' && c.enabled !== false);
  if (!hb) return null;
  // FIELD IS `schedule`, NOT `interval` — verified against the real crons.json on disk
  // (builder_1: {"name":"heartbeat","schedule":"2h",...}), not assumed from the cron-drift.ts
  // CronEntry type shape, which uses a DIFFERENT field name for the still-unmigrated config.json
  // form. Live run caught this: 14 of 14 agents excluded on first try, all with real 2h/4h/6h
  // heartbeats. A "0 checked, 14 excluded" result is the same "confident empty result from a
  // wrong field name" class already logged fleet-wide (my-open-tasks.sh: assignee vs
  // assigned_to). --self-test alone did not catch it because its fabricated fixtures used the
  // field name I assumed, not the one actually on disk — a lesson for the next fixture too.
  return parseDurationMs(hb.schedule);
}

/**
 * Pure verdict logic so --self-test can drive it without touching disk.
 * @returns {{code:0|2, status:string, detail:string}}
 */
export function verdict({ agent, hasReceiptFile, lastReceiptTs, now, intervalMs, cycles = DEFAULT_CYCLES }) {
  if (!hasReceiptFile) {
    return {
      code: 2, status: 'NEVER-WIRED',
      detail: `${agent}: no kb-ingest receipt file exists at all — step 10 has never produced one ` +
        `(the wrapper writes on every outcome, including failures, so an absent file means the step ` +
        `itself has never run, not that it ran and succeeded).`,
    };
  }
  const gapMs = now - lastReceiptTs;
  const thresholdMs = intervalMs * cycles;
  const gapH = (gapMs / 3_600_000).toFixed(1);
  const cadenceH = (intervalMs / 3_600_000).toFixed(1);
  if (gapMs >= thresholdMs) {
    const cyclesMissed = Math.floor(gapMs / intervalMs);
    return {
      code: 2, status: 'RECEIPT-GAP',
      detail: `${agent}: last kb-ingest receipt ${gapH}h ago (~${cyclesMissed} expected cycle(s) at ` +
        `${cadenceH}h cadence) — step 10 silently stopped firing. This is a REAL absence, not evidence ` +
        `of a quiet content period: an unchanged-input run still writes a receipt (status UNCHANGED).`,
    };
  }
  return {
    code: 0, status: 'OK',
    detail: `${agent}: last receipt ${gapH}h ago, within ${cycles}x cadence (${cadenceH}h).`,
  };
}

function selfTest() {
  const H = 3_600_000;
  const now = Date.parse('2026-08-17T08:00:00Z');
  const cases = [
    ['parses a plain interval', () => parseDurationMs('2h') === 2 * H],
    ['parses minutes and days too', () => parseDurationMs('30m') === 30 * 60_000 && parseDurationMs('1d') === 24 * H],
    ['a cron expression is not a duration', () => parseDurationMs('0 */6 * * *') === null],
    ['empty/absent is not a duration', () => parseDurationMs('') === null && parseDurationMs(undefined) === null],
    ['finds the enabled heartbeat cron', () =>
      heartbeatIntervalMs({ crons: [{ name: 'heartbeat', schedule: '4h', enabled: true }] }) === 4 * H],
    ['a DISABLED heartbeat cron does not count', () =>
      heartbeatIntervalMs({ crons: [{ name: 'heartbeat', schedule: '4h', enabled: false }] }) === null],
    ['a cron-expression heartbeat yields null, not NaN or 0', () =>
      heartbeatIntervalMs({ crons: [{ name: 'heartbeat', schedule: '0 */6 * * *' }] }) === null],
    ['no heartbeat cron at all yields null', () => heartbeatIntervalMs({ crons: [] }) === null],

    // --- THE MOTIVATING CASE: brand_writer, 104h / ~26 cycles at 4h cadence ---
    ['THE INCIDENT ITSELF: 104h gap at 4h cadence is a real finding', () => {
      const v = verdict({ agent: 'brand_writer', hasReceiptFile: true,
        lastReceiptTs: now - 104 * H, now, intervalMs: 4 * H });
      return v.code === 2 && v.status === 'RECEIPT-GAP';
    }],
    ['the cycles-missed count is named and roughly right', () => {
      const v = verdict({ agent: 'brand_writer', hasReceiptFile: true,
        lastReceiptTs: now - 104 * H, now, intervalMs: 4 * H });
      return v.detail.includes('~26 expected cycle');
    }],

    // --- boundary: exactly 2x cadence fires, just under does not ---
    ['exactly at the 2x-cadence threshold fires', () => {
      const v = verdict({ agent: 'x', hasReceiptFile: true, lastReceiptTs: now - 2 * (4 * H), now, intervalMs: 4 * H, cycles: 2 });
      return v.code === 2;
    }],
    ['just under the threshold stays clean', () => {
      const v = verdict({ agent: 'x', hasReceiptFile: true, lastReceiptTs: now - (2 * (4 * H) - 60_000), now, intervalMs: 4 * H, cycles: 2 });
      return v.code === 0 && v.status === 'OK';
    }],
    // CONTROL for the pair above: without it, a verdict() that always fires would pass the
    // "exactly at threshold" case too.
    ['CONTROL: a recent receipt is clean', () => {
      const v = verdict({ agent: 'x', hasReceiptFile: true, lastReceiptTs: now - 30 * 60_000, now, intervalMs: 4 * H });
      return v.code === 0;
    }],

    // --- never-wired: distinct status from a gap, same code, different remedy ---
    ['no receipt file at all is NEVER-WIRED, not RECEIPT-GAP', () => {
      const v = verdict({ agent: 'x', hasReceiptFile: false, lastReceiptTs: null, now, intervalMs: 4 * H });
      return v.code === 2 && v.status === 'NEVER-WIRED';
    }],
    ['NEVER-WIRED and RECEIPT-GAP are different statuses', () =>
      verdict({ agent: 'x', hasReceiptFile: false, lastReceiptTs: null, now, intervalMs: 4 * H }).status !==
      verdict({ agent: 'x', hasReceiptFile: true, lastReceiptTs: now - 104 * H, now, intervalMs: 4 * H }).status],

    // --- a fast-cadence agent's SAME wall-clock gap can be clean OR a finding, cadence-relative ---
    ['a 6h gap is clean at 6h cadence (1x) but a finding at 2h cadence (3x)', () => {
      const clean = verdict({ agent: 'x', hasReceiptFile: true, lastReceiptTs: now - 6 * H, now, intervalMs: 6 * H });
      const finding = verdict({ agent: 'y', hasReceiptFile: true, lastReceiptTs: now - 6 * H, now, intervalMs: 2 * H });
      return clean.code === 0 && finding.code === 2;
    }],
  ];
  let failed = 0;
  for (const [name, fn] of cases) {
    let ok = false;
    try { ok = fn() === true; } catch { ok = false; }
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  }
  console.log(failed === 0 ? `\nself-test PASSED (${cases.length} cases)` : `\nself-test FAILED: ${failed}`);
  process.exit(failed === 0 ? 0 : 2);
}

if (process.argv.includes('--self-test')) selfTest();

function fail(msg) {
  console.log(`VERDICT: COULD-NOT-RUN — ${msg}`);
  process.exit(3);
}

const jsonMode = process.argv.includes('--json');
const notify = process.argv.includes('--notify');
const cyclesFlagIdx = process.argv.indexOf('--cycles');
const cycles = cyclesFlagIdx !== -1 ? Number(process.argv[cyclesFlagIdx + 1]) : DEFAULT_CYCLES;
if (!Number.isFinite(cycles) || cycles <= 0) fail(`--cycles must be a positive number, got ${process.argv[cyclesFlagIdx + 1]}`);

let agents;
try {
  agents = JSON.parse(execSync('cortextos bus list-agents --format json', { encoding: 'utf8' }));
} catch (err) {
  fail(`could not list agents: ${err.message}`);
}

const now = Date.now();
const findings = [];
const clean = [];
const excluded = [];

for (const a of agents) {
  if (!a.enabled) continue; // retired agents never boot; their crons never fire; out of scope.
  const cronsPath = `${CTX_ROOT}/.cortextOS/state/agents/${a.name}/crons.json`;
  let intervalMs = null;
  if (existsSync(cronsPath)) {
    try { intervalMs = heartbeatIntervalMs(JSON.parse(readFileSync(cronsPath, 'utf8'))); } catch { /* treated as absent below */ }
  }
  if (intervalMs === null) {
    excluded.push({ agent: a.name, reason: 'no interval-form heartbeat cron (cron-expression or absent) — cadence cannot be computed' });
    continue;
  }

  const receiptPath = `${CTX_ROOT}/state/${a.name}/.kb-ingest-receipts.jsonl`;
  let hasReceiptFile = existsSync(receiptPath);
  let lastReceiptTs = null;
  if (hasReceiptFile) {
    try {
      const lines = readFileSync(receiptPath, 'utf8').trim().split('\n').filter(Boolean);
      if (lines.length) lastReceiptTs = Date.parse(JSON.parse(lines[lines.length - 1]).ts);
      else hasReceiptFile = false; // an empty file is functionally the same as absent
    } catch {
      hasReceiptFile = false; // unreadable/corrupt: same remedy as never-wired, re-run will recreate it
    }
  }

  const v = verdict({ agent: a.name, hasReceiptFile, lastReceiptTs, now, intervalMs, cycles });
  (v.code === 0 ? clean : findings).push(v);
}

const receiptOut = {
  ts: new Date().toISOString(),
  cron: 'kb-ingest-gap-check',
  checked: clean.length + findings.length,
  excluded: excluded.length,
  findings: findings.length,
};
try {
  const receiptPath = `${CTX_ROOT}/state/builder_1/.kb-ingest-gap-check-receipts.jsonl`;
  mkdirSync(dirname(receiptPath), { recursive: true });
  appendFileSync(receiptPath, JSON.stringify(receiptOut) + '\n');
} catch (err) {
  console.log(`NOTE: verdict stands but the receipt could not be written (${err.message}).`);
}

if (jsonMode) {
  console.log(JSON.stringify({ findings, clean, excluded }, null, 2));
} else {
  console.log(`Checked ${clean.length + findings.length} enabled agent(s) with an interval heartbeat; ${excluded.length} excluded (no computable cadence): ${excluded.map((e) => e.agent).join(', ') || '(none)'}.`);
  if (findings.length === 0) {
    console.log('VERDICT: CLEAN — every checked agent has a recent kb-ingest receipt.');
  } else {
    console.log(`\n${findings.length} finding(s):`);
    for (const f of findings) console.log(`  ${f.status}: ${f.detail}`);
  }
}

if (notify && findings.length > 0) {
  try {
    const env = process.env;
    const contextPath = `${REPO}/orgs/${env.CTX_ORG}/context.json`;
    if (existsSync(contextPath)) {
      const ctx = JSON.parse(readFileSync(contextPath, 'utf8'));
      if (ctx.orchestrator && ctx.orchestrator !== env.CTX_AGENT_NAME) {
        const body = findings.map((f) => `  ${f.status}: ${f.detail}`).join('\n');
        execSync(
          `cortextos bus send-message ${ctx.orchestrator} normal ${JSON.stringify(`kb-ingest receipt gap check: ${findings.length} finding(s).\n\n${body}`)}`,
          { encoding: 'utf8' },
        );
      }
    }
  } catch { /* the console report above already carries the finding */ }
}

process.exit(findings.length > 0 ? 2 : 0);
