#!/usr/bin/env node
// Is the RUNNING daemon executing the current src? Three facts, two comparisons, nobody was
// making either one.
//
//   A  newest mtime under src/        (when the code last changed)
//   B  mtime of dist/daemon.js        (when the bundle was last built)
//   C  pm2 up_since for the daemon    (when the resident copy was loaded)
//
// A was the last COMMIT date until 2026-07-30, when that leg fired a false positive by 278ms —
// git commit times have 1-second resolution, file mtimes have milliseconds, and the real workflow
// is edit->build->test->commit, so a healthy build lands a fraction of a second BEFORE its commit.
// All three facts are now file/process timestamps on one clock. See the STALE-BUNDLE leg.
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
import { statSync, existsSync, readdirSync } from 'node:fs';

const REPO = 'C:/Users/Sebas/cortextos';
const BUNDLE = `${REPO}/dist/daemon.js`;

/**
 * Pure verdict logic, so --self-test can drive it with fabricated times.
 * @returns {{code:0|2, lines:string[]}}
 */
export function verdict({ newestSrcMtime, bundleMtime, daemonUpSince, dirtySrcFiles }) {
  const lines = [];
  const findings = [];

  // COMPARED AGAINST THE NEWEST src/ FILE MTIME, NOT THE LAST COMMIT DATE. This leg fired a false
  // positive on 2026-07-30 by 278 MILLISECONDS, and the cause was a clock-domain mismatch:
  //
  //   * git commit timestamps have ONE-SECOND resolution (the value read back ends in .000)
  //   * file mtimes have millisecond resolution
  //
  // and worse, the comparison assumed build-AFTER-commit while the real workflow is
  // edit -> build -> test -> commit. So a healthy build-then-commit leaves the bundle a fraction of
  // a second OLDER than the commit, every time, and this leg reported that as staleness. The
  // artifact points at "stale", so the check was biased toward firing on correct behaviour.
  //
  // Two file mtimes are the same clock at the same resolution, and they answer the question this
  // leg actually asks — was the bundle built after the last source EDIT. A tolerance would only
  // have been a guess about how long a commit takes.
  //
  // It also closes a gap the commit-based version could not see at all: editing src without
  // committing never moved the old comparand, so uncommitted-and-unbuilt read as CURRENT.
  if (bundleMtime < newestSrcMtime) {
    findings.push(
      `STALE-BUNDLE — dist/daemon.js (${bundleMtime.toISOString()}) is OLDER than the newest src/ ` +
        `file (${newestSrcMtime.toISOString()}). The bundle was not rebuilt after the last source ` +
        `edit. npm run build.`,
    );
  }
  if (daemonUpSince < bundleMtime) {
    findings.push(
      `STALE-DAEMON — the daemon started ${daemonUpSince.toISOString()}, before the bundle on ` +
        `disk was built (${bundleMtime.toISOString()}). Its resident copy is older than dist/. ` +
        `Needs a DAEMON restart; restarting agents does nothing.`,
    );
  }

  // Advisory. Now that the bundle is compared against file mtimes, uncommitted edits ARE covered by
  // the comparison — but they are still worth naming, because a bundle built from uncommitted source
  // is current on this box and unreproducible anywhere else.
  if (dirtySrcFiles > 0) {
    lines.push(
      `NOTE: ${dirtySrcFiles} uncommitted file(s) under src/. The comparison below DOES cover them ` +
        `(it uses file mtimes), but a bundle built from uncommitted source cannot be rebuilt from ` +
        `git alone.`,
    );
  }

  if (findings.length === 0) {
    lines.push(
      'VERDICT: CURRENT — the running daemon loaded a bundle built after the newest src/ edit.',
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
    ['clean chain', { newestSrcMtime: t('2026-07-30T01:00:00Z'), bundleMtime: t('2026-07-30T02:00:00Z'), daemonUpSince: t('2026-07-30T03:00:00Z'), dirtySrcFiles: 0 }, 0, 'CURRENT'],
    ['boundary: all equal', { newestSrcMtime: t('2026-07-30T02:00:00Z'), bundleMtime: t('2026-07-30T02:00:00Z'), daemonUpSince: t('2026-07-30T02:00:00Z'), dirtySrcFiles: 0 }, 0, 'CURRENT'],
    ['bundle older than src', { newestSrcMtime: t('2026-07-30T04:00:00Z'), bundleMtime: t('2026-07-30T02:00:00Z'), daemonUpSince: t('2026-07-30T05:00:00Z'), dirtySrcFiles: 0 }, 2, 'STALE-BUNDLE'],
    ['daemon older than bundle', { newestSrcMtime: t('2026-07-30T01:00:00Z'), bundleMtime: t('2026-07-30T04:00:00Z'), daemonUpSince: t('2026-07-30T02:00:00Z'), dirtySrcFiles: 0 }, 2, 'STALE-DAEMON'],
    // The real 2026-07-30 case: bundle 12:13:45Z, commit 13:51:40Z, daemon 13:56:03Z.
    ['the case that motivated this', { newestSrcMtime: t('2026-07-30T13:51:40Z'), bundleMtime: t('2026-07-30T12:13:45Z'), daemonUpSince: t('2026-07-30T13:56:03Z'), dirtySrcFiles: 0 }, 2, 'STALE-BUNDLE'],
    ['dirty src still passes but says so', { newestSrcMtime: t('2026-07-30T01:00:00Z'), bundleMtime: t('2026-07-30T02:00:00Z'), daemonUpSince: t('2026-07-30T03:00:00Z'), dirtySrcFiles: 3 }, 0, 'uncommitted'],
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

let dirtySrcFiles;
try {
  dirtySrcFiles = execSync('git status --porcelain -- src/', {
    cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).split('\n').filter((l) => l.trim()).length;
} catch (err) {
  fail(`could not read git state: ${err.message}`);
}

/**
 * Newest mtime under src/. Deliberately a FILE mtime, so it is the same clock and the same
 * resolution as the bundle mtime it gets compared against — see the note on the STALE-BUNDLE leg.
 */
function newestSrcMtimeMs(dir) {
  let newest = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${e.name}`;
    if (e.isDirectory()) newest = Math.max(newest, newestSrcMtimeMs(full));
    else if (e.name.endsWith('.ts')) newest = Math.max(newest, statSync(full).mtimeMs);
  }
  return newest;
}

let newestMs;
try {
  newestMs = newestSrcMtimeMs(`${REPO}/src`);
} catch (err) {
  fail(`could not walk src/: ${err.message}`);
}
// A zero here would make EVERY bundle look current — failure in the reassuring direction, which is
// the one this whole check exists to refuse. Could-not-run rather than a silent pass.
if (!newestMs) fail('found no .ts files under src/ — wrong repo path?');

const input = {
  newestSrcMtime: new Date(newestMs),
  bundleMtime: statSync(BUNDLE).mtime,
  daemonUpSince: new Date(proc.pm2_env.pm_uptime),
  dirtySrcFiles,
};

console.log(`A newest src/ edit  ${input.newestSrcMtime.toISOString()}`);
console.log(`B dist bundle built ${input.bundleMtime.toISOString()}`);
console.log(`C daemon up_since   ${input.daemonUpSince.toISOString()} (pid ${proc.pid}, restarts ${proc.pm2_env.restart_time})`);

const { code, lines } = verdict(input);
lines.forEach((l) => console.log(l));
process.exit(code);
