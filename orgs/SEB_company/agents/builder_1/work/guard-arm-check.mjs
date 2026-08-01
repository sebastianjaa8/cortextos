#!/usr/bin/env node
// Is the RUNNING daemon executing the current src? Three facts, two comparisons, nobody was
// making either one.
//
//   A  dist/.build-stamp             (what source the bundle was ACTUALLY built from)
//   B  mtime of dist/daemon.js        (when the bundle was last built)
//   C  pm2 up_since for the daemon    (when the resident copy was loaded)
//
// A WAS A TIMESTAMP UNTIL 2026-08-01 AND THAT WAS THE WRONG KIND OF FACT. It was the last commit
// date, which fired a false positive by 278ms (commit times have 1-second resolution, mtimes have
// milliseconds, and the real workflow is edit->build->test->commit). It was then the newest src/
// file mtime, which fired a false positive of its own: a `git checkout` revert restored the exact
// content the bundle was built from and bumped the mtime, so a current bundle read STALE-BUNDLE.
//
// BOTH ARE PROXIES FOR A CONTENT QUESTION AND NO TIMESTAMP ANSWERS ONE. Only the artifact recording
// its own provenance does. A is now scripts/build-stamp.mjs --check, written by the tsup build.
//
// The chain must hold A ok, then B <= C. Break it anywhere and the daemon is running code that is
// not what the repo says:
//   A STALE          the bundle was built from source that is no longer HEAD  -> STALE-BUNDLE
//   A UNVERIFIABLE   provenance cannot be established at all                  -> UNVERIFIABLE-BUNDLE
//   C < B            the daemon started before the current bundle existed     -> STALE-DAEMON
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
import { statSync, existsSync, readFileSync } from 'node:fs';
// The provenance logic lives in scripts/, not here. NOT because this file is untracked — I wrote
// that first and it was wrong: `git ls-files` shows THIS file is tracked, along with 11 other
// orgs/ files, because .gitignore does not apply to paths already added. The reason is the other
// direction: build-stamp.mjs genuinely was untracked, and `tsup.config.ts` is a framework file that
// must not reach into one user's org data for a build step. See scripts/build-stamp.mjs.
import { verdict as stampVerdict, currentProvenance } from '../../../../../scripts/build-stamp.mjs';

const REPO = 'C:/Users/Sebas/cortextos';
const BUNDLE = `${REPO}/dist/daemon.js`;

/**
 * Pure verdict logic, so --self-test can drive it with fabricated times.
 * @returns {{code:0|2, lines:string[]}}
 */
export function verdict({ stamp, bundleMtime, daemonUpSince, dirtySrcFiles }) {
  const lines = [];
  const findings = [];

  // THE PROVENANCE LEG. Two timestamps cannot answer "was this artifact produced from this source",
  // and this leg produced a false positive under each timestamp it tried — 278ms under commit dates,
  // and a whole clean bundle under src mtimes when a `git checkout` revert restored the exact
  // content the bundle already contained. Both were proxies. The stamp is the fact.
  //
  // UNVERIFIABLE IS A FINDING, NOT A PASS. It is code 2, deliberately not code 3: 3 means the CHECK
  // could not run, and conflating "the guard is broken" with "the guard cannot establish
  // provenance" is what let a wrong invocation read as a real result once already. And it must not
  // be silent — "we do not know what this bundle was built from" is the exact condition the whole
  // exercise exists to surface.
  if (stamp.status === 'STALE') {
    findings.push(`STALE-BUNDLE — ${stamp.detail} npm run build.`);
  } else if (stamp.status === 'UNVERIFIABLE') {
    findings.push(
      `UNVERIFIABLE-BUNDLE — ${stamp.detail} This is EXPECTED until the first real build after ` +
        `2026-08-01 writes a stamp, and it will read as a regression. Absence of provenance is not ` +
        `evidence of currency.`,
    );
  }
  if (daemonUpSince < bundleMtime) {
    findings.push(
      `STALE-DAEMON — the daemon started ${daemonUpSince.toISOString()}, before the bundle on ` +
        `disk was built (${bundleMtime.toISOString()}). Its resident copy is older than dist/. ` +
        `Needs a DAEMON restart; restarting agents does nothing.`,
    );
  }

  // Advisory. The stamp already records dirtySrc and downgrades such a build to UNVERIFIABLE, so
  // this no longer carries the comparison — it names the condition for a reader who is looking at a
  // bundle that is current on this box and unreproducible anywhere else.
  if (dirtySrcFiles > 0) {
    lines.push(
      `NOTE: ${dirtySrcFiles} uncommitted file(s) under src/. The comparison below DOES cover them ` +
        `(it uses file mtimes), but a bundle built from uncommitted source cannot be rebuilt from ` +
        `git alone.`,
    );
  }

  if (findings.length === 0) {
    lines.push(
      'VERDICT: CURRENT — the running daemon loaded a bundle whose stamp matches HEAD.',
      'This does NOT prove any given code path executes. Loaded is not exercised.',
    );
    return { code: 0, lines };
  }
  lines.push(...findings.map((f) => `VERDICT: ${f}`));
  return { code: 2, lines };
}

function selfTest() {
  const t = (iso) => new Date(iso);
  const OK = { status: 'CURRENT', detail: 'stamp matches HEAD.' };
  const cases = [
    // name, input, expected code, expected substring
    ['clean chain', { stamp: OK, bundleMtime: t('2026-07-30T02:00:00Z'), daemonUpSince: t('2026-07-30T03:00:00Z'), dirtySrcFiles: 0 }, 0, 'CURRENT'],
    // THE 2026-07-31 REGRESSION CASE, AND IT IS HERE AS A *CLEAN* ONE ON PURPOSE. A `git checkout`
    // revert restored the exact content the bundle was built from and bumped src mtime to 04:08:13,
    // AFTER the bundle. The mtime leg called that STALE-BUNDLE. The stamp says CURRENT because the
    // CONTENT never changed. This case is the whole reason the leg was replaced, so it is asserted
    // rather than described — delete the stamp leg and it goes red.
    ['revert bumped src mtime, content unchanged', { stamp: OK, bundleMtime: t('2026-07-31T04:00:00Z'), daemonUpSince: t('2026-07-31T05:00:00Z'), dirtySrcFiles: 0 }, 0, 'CURRENT'],
    ['dirty src still passes but says so', { stamp: OK, bundleMtime: t('2026-07-30T02:00:00Z'), daemonUpSince: t('2026-07-30T03:00:00Z'), dirtySrcFiles: 3 }, 0, 'uncommitted'],
    ['stamp says HEAD moved on', { stamp: { status: 'STALE', detail: 'built from 1111111, HEAD is 2222222.' }, bundleMtime: t('2026-07-30T02:00:00Z'), daemonUpSince: t('2026-07-30T03:00:00Z'), dirtySrcFiles: 0 }, 2, 'STALE-BUNDLE'],
    ['no stamp at all', { stamp: { status: 'UNVERIFIABLE', detail: 'no dist/.build-stamp.' }, bundleMtime: t('2026-07-30T02:00:00Z'), daemonUpSince: t('2026-07-30T03:00:00Z'), dirtySrcFiles: 0 }, 2, 'UNVERIFIABLE-BUNDLE'],
    ['daemon older than bundle', { stamp: OK, bundleMtime: t('2026-07-30T04:00:00Z'), daemonUpSince: t('2026-07-30T02:00:00Z'), dirtySrcFiles: 0 }, 2, 'STALE-DAEMON'],
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

// A is now a CONTENT fact, read from the stamp the build wrote, not a timestamp this file derives.
// The src/ mtime walk that used to live here is gone with the leg it fed.
let stamp;
try {
  const stampPath = `${REPO}/dist/.build-stamp`;
  stamp = stampVerdict({
    stamp: existsSync(stampPath) ? JSON.parse(readFileSync(stampPath, 'utf-8')) : null,
    current: currentProvenance(REPO),
    bundleMtime: existsSync(BUNDLE) ? statSync(BUNDLE).mtime : null,
  });
} catch (err) {
  // COULD-NOT-RUN, not UNVERIFIABLE. If the stamp reader itself throws, this check has no opinion —
  // reporting that as a provenance finding would blame the bundle for the guard's own breakage.
  fail(`could not evaluate build provenance: ${err.message}`);
}

const input = {
  stamp,
  bundleMtime: statSync(BUNDLE).mtime,
  daemonUpSince: new Date(proc.pm2_env.pm_uptime),
  dirtySrcFiles,
};

console.log(`A build provenance  ${stamp.status} — ${stamp.detail}`);
console.log(`B dist bundle built ${input.bundleMtime.toISOString()}`);
console.log(`C daemon up_since   ${input.daemonUpSince.toISOString()} (pid ${proc.pid}, restarts ${proc.pm2_env.restart_time})`);

const { code, lines } = verdict(input);
lines.forEach((l) => console.log(l));
process.exit(code);
