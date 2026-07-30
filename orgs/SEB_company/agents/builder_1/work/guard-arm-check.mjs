#!/usr/bin/env node
// Is the RUNNING daemon executing the current src? Three facts, two comparisons, nobody was
// making either one.
//
//   A  last commit touching src/      (when the code last changed)
//   B  mtime of dist/daemon.js        (when the bundle was last built)
//   C  pm2 up_since for the daemon    (when the resident copy was loaded)
//
// The chain must hold A <= B <= C. Break it anywhere and the daemon is running code that is not
// what the repo says:
//   B < A   the bundle was never rebuilt after a src change      -> STALE-BUNDLE
//   C < B   the daemon started before the current bundle existed -> STALE-DAEMON
// Restarting an AGENT fixes neither: agents respawn from the daemon's already-loaded copy.
//
// WHY GENERIC, NOT ONE-SHA. This started life checking one known commit (the crons.json snapshot
// guard) against B and C. That version was correct and useless one commit later: on 2026-07-30
// the daemon was restarted at 13:56:03Z onto a bundle built 12:13:45Z, which predated 496a70a
// (13:51:40Z) — a fix to heartbeat reporting. The one-SHA check said ARMED, truthfully, about a
// different commit. The failure is generic, so the check has to be. Third recurrence of this trap
// (2026-07-16, 2026-07-25, 2026-07-30); the first two were narrated in memory, not detected.
//
// LIMIT, stated next to the pass because a clean score needs its denominator more than a dirty
// one does: this proves the daemon loaded a bundle built from the current committed src. It does
// NOT prove any particular code path executes. Loaded is not exercised.
//
//   node work/guard-arm-check.mjs              check the live daemon
//   node work/guard-arm-check.mjs --self-test  prove the verdict logic can fire AND come back clean
//
// exit 0 CURRENT · 2 a real finding (stale bundle or stale daemon) · 3 could not run
import { execSync } from 'node:child_process';
import { statSync, existsSync } from 'node:fs';

const REPO = 'C:/Users/Sebas/cortextos';
const BUNDLE = `${REPO}/dist/daemon.js`;

/**
 * Pure verdict logic, so --self-test can drive it with fabricated times.
 * @returns {{code:0|2, lines:string[]}}
 */
export function verdict({ lastSrcCommit, bundleMtime, daemonUpSince, dirtySrcFiles }) {
  const lines = [];
  const findings = [];

  if (bundleMtime < lastSrcCommit) {
    findings.push(
      `STALE-BUNDLE — dist/daemon.js (${bundleMtime.toISOString()}) is OLDER than the last src/ ` +
        `commit (${lastSrcCommit.toISOString()}). The bundle was never rebuilt. npm run build.`,
    );
  }
  if (daemonUpSince < bundleMtime) {
    findings.push(
      `STALE-DAEMON — the daemon started ${daemonUpSince.toISOString()}, before the bundle on ` +
        `disk was built (${bundleMtime.toISOString()}). Its resident copy is older than dist/. ` +
        `Needs a DAEMON restart; restarting agents does nothing.`,
    );
  }

  // Advisory only: uncommitted src cannot be compared against a commit date, so it neither
  // confirms nor refutes. Said out loud rather than silently folded into the pass.
  if (dirtySrcFiles > 0) {
    lines.push(
      `NOTE: ${dirtySrcFiles} uncommitted file(s) under src/. Those changes are in NO bundle, and ` +
        `the comparison below covers committed src only.`,
    );
  }

  if (findings.length === 0) {
    lines.push(
      'VERDICT: CURRENT — the running daemon loaded a bundle built from the current committed src.',
      'This does NOT prove any given code path executes. Loaded is not exercised.',
    );
    return { code: 0, lines };
  }
  lines.push(...findings.map((f) => `VERDICT: ${f}`));
  return { code: 2, lines };
}

function selfTest() {
  const t = (iso) => new Date(iso);
  const cases = [
    // name, input, expected code, expected substring
    ['clean chain', { lastSrcCommit: t('2026-07-30T01:00:00Z'), bundleMtime: t('2026-07-30T02:00:00Z'), daemonUpSince: t('2026-07-30T03:00:00Z'), dirtySrcFiles: 0 }, 0, 'CURRENT'],
    ['boundary: all equal', { lastSrcCommit: t('2026-07-30T02:00:00Z'), bundleMtime: t('2026-07-30T02:00:00Z'), daemonUpSince: t('2026-07-30T02:00:00Z'), dirtySrcFiles: 0 }, 0, 'CURRENT'],
    ['bundle older than src', { lastSrcCommit: t('2026-07-30T04:00:00Z'), bundleMtime: t('2026-07-30T02:00:00Z'), daemonUpSince: t('2026-07-30T05:00:00Z'), dirtySrcFiles: 0 }, 2, 'STALE-BUNDLE'],
    ['daemon older than bundle', { lastSrcCommit: t('2026-07-30T01:00:00Z'), bundleMtime: t('2026-07-30T04:00:00Z'), daemonUpSince: t('2026-07-30T02:00:00Z'), dirtySrcFiles: 0 }, 2, 'STALE-DAEMON'],
    // The real 2026-07-30 case: bundle 12:13:45Z, commit 13:51:40Z, daemon 13:56:03Z.
    ['the case that motivated this', { lastSrcCommit: t('2026-07-30T13:51:40Z'), bundleMtime: t('2026-07-30T12:13:45Z'), daemonUpSince: t('2026-07-30T13:56:03Z'), dirtySrcFiles: 0 }, 2, 'STALE-BUNDLE'],
    ['dirty src still passes but says so', { lastSrcCommit: t('2026-07-30T01:00:00Z'), bundleMtime: t('2026-07-30T02:00:00Z'), daemonUpSince: t('2026-07-30T03:00:00Z'), dirtySrcFiles: 3 }, 0, 'uncommitted'],
  ];

  let failed = 0;
  for (const [name, input, wantCode, wantText] of cases) {
    const got = verdict(input);
    const text = got.lines.join('\n');
    const ok = got.code === wantCode && text.includes(wantText);
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} (code ${got.code}, want ${wantCode})`);
  }
  // Both directions covered: 3 cases must come back clean, 3 must fire. A check that can only
  // ever fire is as broken as one that can never fire; it just fails loudly instead of silently.
  console.log(failed === 0 ? '\nself-test PASSED (3 clean, 3 firing)' : `\nself-test FAILED: ${failed}`);
  process.exit(failed === 0 ? 0 : 2);
}

if (process.argv.includes('--self-test')) selfTest();

function fail(msg) {
  console.log(`VERDICT: COULD-NOT-RUN — ${msg}`);
  // Distinct from 2 on purpose: "the check is broken" and "the check found something" were the
  // same exit code once, and that is what let a wrong invocation read as a real finding.
  process.exit(3);
}

let jlist;
try {
  jlist = JSON.parse(
    execSync('npx pm2 jlist', { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
  );
} catch (err) {
  fail(`could not read pm2 process list: ${err.message}`);
}
const proc = jlist.find((p) => p.name?.includes('cortextos-daemon'));
if (!proc) fail('cortextos daemon is not running under pm2');
if (!existsSync(BUNDLE)) fail(`no bundle at ${BUNDLE}`);

let lastSrcCommitIso, dirtySrcFiles;
try {
  lastSrcCommitIso = execSync('git log -1 --format=%cI -- src/', {
    cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  dirtySrcFiles = execSync('git status --porcelain -- src/', {
    cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).split('\n').filter((l) => l.trim()).length;
} catch (err) {
  fail(`could not read git state: ${err.message}`);
}
if (!lastSrcCommitIso) fail('git returned no commit touching src/ — wrong repo path?');

const input = {
  lastSrcCommit: new Date(lastSrcCommitIso),
  bundleMtime: statSync(BUNDLE).mtime,
  daemonUpSince: new Date(proc.pm2_env.pm_uptime),
  dirtySrcFiles,
};

console.log(`A last src/ commit  ${input.lastSrcCommit.toISOString()}`);
console.log(`B dist bundle built ${input.bundleMtime.toISOString()}`);
console.log(`C daemon up_since   ${input.daemonUpSince.toISOString()} (pid ${proc.pid}, restarts ${proc.pm2_env.restart_time})`);

const { code, lines } = verdict(input);
lines.forEach((l) => console.log(l));
process.exit(code);
