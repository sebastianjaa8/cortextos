#!/usr/bin/env node
// Interim mitigation for a real cortextOS daemon bug (task_1790590503920_46716808,
// builder_1, 2026-09-28): src/pty/output-buffer.ts's isBootstrapped() is a one-way latch
// that src/daemon/agent-process.ts's drainTick() (the QUEUED cron-delivery path) gates
// on. If a hermes-runtime agent's PTY respawns and that latch never re-confirms true —
// observed live on hermes_local after an unlogged ~02:26Z PTY restart — every QUEUED
// cron injection (heartbeat fires) silently piles up forever: no error, no
// cron_inject_dropped event, nothing. The only path that bypasses the isBootstrapped
// gate is the DIRECT/interactive injection used by `cortextos bus send-message`
// (injectMessageDetailed, not injectMessageQueued) — confirmed live: a direct message
// produced a fresh output chunk, re-ran output-buffer.ts's checkBootstrap() (which scans
// on every push()), re-latched the flag, and the backlog drained within ~45s.
//
// This script is the STOPGAP: detect a stale hermes-runtime agent via the same
// kb-ingest-receipt staleness signal kb-ingest-gap-check.mjs already trusts, and if
// stale, send ONE direct low-priority bus message to force the repaint that re-latches
// isBootstrapped(). NOT a fix for the daemon bug itself — that requires a Tier-3,
// daylight-reviewed change to drainTick()/output-buffer.ts (self-healing re-check or a
// proper watchdog on pendingInjections), scoped in task_1790590503920_46716808 and
// deliberately NOT landed at night per seb_boss's call.
//
//   node scripts/hermes-queue-nudge.mjs              check + nudge the live fleet
//   node scripts/hermes-queue-nudge.mjs --notify     also message seb_boss when a nudge fires
//   node scripts/hermes-queue-nudge.mjs --self-test  prove the verdict logic can fire AND stay clean
//
// exit 0 clean (nothing stale, or a stale agent was successfully nudged) · 2 a nudge
// failed to send (the agent may be genuinely down, not just stuck) · 3 the check itself
// could not run.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// INLINED, not imported from kb-ingest-gap-check.mjs, on purpose (caught by this script's own
// self-test, not assumed): that file's `if (process.argv.includes('--self-test')) selfTest()`
// runs as a top-level side effect at IMPORT time, before this file's own --self-test check ever
// runs — importing it here made `node scripts/hermes-queue-nudge.mjs --self-test` silently run
// (and exit inside) kb-ingest-gap-check.mjs's OWN self-test instead of this script's, 22 cases
// vs the 9 written for this file, an exact-count match that only surfaced because the case
// names in the output didn't match what was written here. A shared side-effecting script is not
// a safe import target; the ~30 lines of pure logic below are copied instead.
function parseDurationMs(raw) {
  const m = /^(\d+)\s*(h|m|d)$/i.exec((raw || '').trim());
  if (!m) return null;
  const mult = { h: 3_600_000, m: 60_000, d: 86_400_000 }[m[2].toLowerCase()];
  return Number(m[1]) * mult;
}
function parseCronExpressionIntervalMs(raw) {
  const expr = (raw || '').trim();
  let m = /^\d{1,2}\s+\*\/(\d{1,2})\s+\*\s+\*\s+\*$/.exec(expr);
  if (m) return Number(m[1]) * 3_600_000;
  m = /^\d{1,2}\s+\*\s+\*\s+\*\s+\*$/.exec(expr);
  if (m) return 3_600_000;
  return null;
}
function heartbeatIntervalMs(cronsJson) {
  const hb = (cronsJson?.crons || []).find((c) => c.name === 'heartbeat' && c.enabled !== false);
  if (!hb) return null;
  return parseDurationMs(hb.schedule) ?? parseCronExpressionIntervalMs(hb.schedule);
}
function verdict({ agent, hasReceiptFile, lastReceiptTs, now, intervalMs, cycles }) {
  if (!hasReceiptFile) {
    return { code: 2, status: 'NEVER-WIRED', detail: `${agent}: no kb-ingest receipt file exists at all.` };
  }
  const gapMs = now - lastReceiptTs;
  const thresholdMs = intervalMs * cycles;
  const gapH = (gapMs / 3_600_000).toFixed(1);
  const cadenceH = (intervalMs / 3_600_000).toFixed(1);
  if (gapMs >= thresholdMs) {
    const cyclesMissed = Math.floor(gapMs / intervalMs);
    return {
      code: 2, status: 'RECEIPT-GAP',
      detail: `${agent}: last kb-ingest receipt ${gapH}h ago (~${cyclesMissed} expected cycle(s) at ${cadenceH}h cadence).`,
    };
  }
  return { code: 0, status: 'OK', detail: `${agent}: last receipt ${gapH}h ago, within ${cycles}x cadence (${cadenceH}h).` };
}

const REPO = '/Users/Sebas/cortextos';
const CTX_ROOT = (process.env.CTX_ROOT || `${process.env.HOME}/.cortextos/default`).replace(/\\/g, '/');
const DEFAULT_CYCLES = 1; // nudge on the FIRST missed cycle, not the 2x kb-ingest-gap-check waits for — a
// stuck queue never self-heals, so waiting longer only means a longer real outage, not more signal.
const NUDGE_COOLDOWN_MS = 30 * 60_000; // >= drainTick's own 15-min max-wait valve (agent-process.ts
// DRAIN_MAX_WAIT_MS), so a nudge gets a full chance to land before this script tries again.

/**
 * Pure decision logic so --self-test can drive it without touching disk or the bus.
 * @returns {{shouldNudge:boolean, reason:string}}
 */
export function nudgeDecision({ v, lastNudgeTs, now, cooldownMs = NUDGE_COOLDOWN_MS }) {
  if (v.code === 0) return { shouldNudge: false, reason: 'not stale' };
  if (lastNudgeTs !== null && now - lastNudgeTs < cooldownMs) {
    const remainMin = Math.ceil((cooldownMs - (now - lastNudgeTs)) / 60_000);
    return { shouldNudge: false, reason: `nudged ${Math.round((now - lastNudgeTs) / 60_000)}min ago, cooldown has ${remainMin}min left` };
  }
  return { shouldNudge: true, reason: v.status === 'NEVER-WIRED' ? 'never wired, nudging anyway (harmless if genuinely never bootstrapped)' : 'stale, cooldown clear' };
}

function selfTest() {
  const now = Date.parse('2026-09-28T10:00:00Z');
  const H = 3_600_000;
  const staleVerdict = { code: 2, status: 'RECEIPT-GAP', detail: 'x: stale' };
  const cleanVerdict = { code: 0, status: 'OK', detail: 'x: fine' };
  const cases = [
    ['clean verdict never nudges', () => nudgeDecision({ v: cleanVerdict, lastNudgeTs: null, now }).shouldNudge === false],
    ['stale verdict with no prior nudge DOES nudge', () => nudgeDecision({ v: staleVerdict, lastNudgeTs: null, now }).shouldNudge === true],
    ['stale verdict inside cooldown does NOT re-nudge', () =>
      nudgeDecision({ v: staleVerdict, lastNudgeTs: now - 10 * 60_000, now }).shouldNudge === false],
    ['stale verdict past cooldown nudges again', () =>
      nudgeDecision({ v: staleVerdict, lastNudgeTs: now - 31 * 60_000, now }).shouldNudge === true],
    ['exactly at the cooldown boundary still withholds (< not <=)', () =>
      nudgeDecision({ v: staleVerdict, lastNudgeTs: now - NUDGE_COOLDOWN_MS, now }).shouldNudge === true],
    ['NEVER-WIRED (code 2, different status) still nudges', () =>
      nudgeDecision({ v: { code: 2, status: 'NEVER-WIRED', detail: 'x' }, lastNudgeTs: null, now }).shouldNudge === true],
    // CONTROL: a clean verdict inside what WOULD be cooldown still never nudges — proves the
    // cooldown check is secondary to staleness, not a standalone "just nudge periodically" timer.
    ['CONTROL: clean verdict ignores cooldown entirely', () =>
      nudgeDecision({ v: cleanVerdict, lastNudgeTs: now - 60 * 60_000, now }).shouldNudge === false],
    // Local copies of kb-ingest-gap-check.mjs's verdict()/heartbeatIntervalMs (inlined, not
    // imported — see the top-of-file note on why). Covered here too so a future edit to this
    // file's own copy can't silently drift from the behavior these tests assume.
    ['local heartbeatIntervalMs still resolves a 4h cadence', () =>
      heartbeatIntervalMs({ crons: [{ name: 'heartbeat', schedule: '4h', enabled: true }] }) === 4 * H],
    ['local verdict() still flags a real gap', () =>
      verdict({ agent: 'x', hasReceiptFile: true, lastReceiptTs: now - 5 * H, now, intervalMs: 4 * H, cycles: DEFAULT_CYCLES }).code === 2],
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

const notify = process.argv.includes('--notify');

let agents;
try {
  agents = JSON.parse(execSync('cortextos bus list-agents --format json', { encoding: 'utf8' }));
} catch (err) {
  fail(`could not list agents: ${err.message}`);
}

const now = Date.now();
const nudged = [];
const skipped = [];
const excluded = [];

for (const a of agents) {
  if (!a.enabled) continue;

  const configPath = `${REPO}/orgs/${a.org}/agents/${a.name}/config.json`;
  let runtime = null;
  if (existsSync(configPath)) {
    try { runtime = JSON.parse(readFileSync(configPath, 'utf8')).runtime ?? null; } catch { /* treated as non-hermes below */ }
  }
  if (runtime !== 'hermes') continue; // this mitigation only applies to the affected runtime

  const cronsPath = `${CTX_ROOT}/.cortextOS/state/agents/${a.name}/crons.json`;
  let intervalMs = null;
  if (existsSync(cronsPath)) {
    try { intervalMs = heartbeatIntervalMs(JSON.parse(readFileSync(cronsPath, 'utf8'))); } catch { /* absent below */ }
  }
  if (intervalMs === null) {
    excluded.push({ agent: a.name, reason: 'no interval-form heartbeat cron — cadence cannot be computed' });
    continue;
  }

  const receiptPath = `${CTX_ROOT}/state/${a.name}/.kb-ingest-receipts.jsonl`;
  let hasReceiptFile = existsSync(receiptPath);
  let lastReceiptTs = null;
  if (hasReceiptFile) {
    try {
      const lines = readFileSync(receiptPath, 'utf8').trim().split('\n').filter(Boolean);
      if (lines.length) lastReceiptTs = Date.parse(JSON.parse(lines[lines.length - 1]).ts);
      else hasReceiptFile = false;
    } catch { hasReceiptFile = false; }
  }

  const v = verdict({ agent: a.name, hasReceiptFile, lastReceiptTs, now, intervalMs, cycles: DEFAULT_CYCLES });

  const nudgeReceiptPath = `${CTX_ROOT}/state/${a.name}/.hermes-queue-nudge-receipts.jsonl`;
  let lastNudgeTs = null;
  if (existsSync(nudgeReceiptPath)) {
    try {
      const lines = readFileSync(nudgeReceiptPath, 'utf8').trim().split('\n').filter(Boolean);
      if (lines.length) lastNudgeTs = Date.parse(JSON.parse(lines[lines.length - 1]).ts);
    } catch { /* treat as no prior nudge */ }
  }

  const decision = nudgeDecision({ v, lastNudgeTs, now });
  if (!decision.shouldNudge) {
    skipped.push({ agent: a.name, verdict: v.status, reason: decision.reason });
    continue;
  }

  try {
    execSync(
      `cortextos bus send-message ${a.name} low ${JSON.stringify('hermes-queue-nudge: automated repaint ping (staleness detected, forcing an isBootstrapped re-check per task_1790590503920_46716808 — no action needed from you).')}`,
      { encoding: 'utf8' },
    );
    mkdirSync(dirname(nudgeReceiptPath), { recursive: true });
    appendFileSync(nudgeReceiptPath, JSON.stringify({ ts: new Date().toISOString(), agent: a.name, reason: v.detail }) + '\n');
    nudged.push({ agent: a.name, verdict: v.detail });
  } catch (err) {
    console.log(`NUDGE-FAILED ${a.name}: ${err.message}`);
    skipped.push({ agent: a.name, verdict: v.status, reason: `send-message failed: ${err.message}` });
  }
}

console.log(`Checked ${nudged.length + skipped.length} enabled hermes-runtime agent(s); ${excluded.length} excluded (no computable cadence).`);
if (nudged.length === 0) {
  console.log('VERDICT: CLEAN — no hermes-runtime agent needed a nudge this cycle.');
} else {
  console.log(`\n${nudged.length} nudge(s) sent:`);
  for (const n of nudged) console.log(`  ${n.agent}: ${n.verdict}`);
}
if (skipped.length) {
  console.log(`\n${skipped.length} skipped (clean or in cooldown):`);
  for (const s of skipped) console.log(`  ${s.agent} (${s.verdict}): ${s.reason}`);
}

if (notify && nudged.length > 0) {
  try {
    const contextPath = `${REPO}/orgs/${process.env.CTX_ORG}/context.json`;
    if (existsSync(contextPath)) {
      const ctx = JSON.parse(readFileSync(contextPath, 'utf8'));
      if (ctx.orchestrator && ctx.orchestrator !== process.env.CTX_AGENT_NAME) {
        const body = nudged.map((n) => `  ${n.agent}: ${n.verdict}`).join('\n');
        execSync(
          `cortextos bus send-message ${ctx.orchestrator} normal ${JSON.stringify(`hermes-queue-nudge: ${nudged.length} agent(s) nudged (interim mitigation for task_1790590503920_46716808).\n\n${body}`)}`,
          { encoding: 'utf8' },
        );
      }
    }
  } catch { /* the console report above already carries the finding */ }
}

process.exit(skipped.some((s) => s.reason.startsWith('send-message failed')) ? 2 : 0);
