// run-selftests — run every self-test in scripts/ that nothing else schedules.
//
// WHY THIS EXISTS. Several scripts carry good self-tests that NOTHING INVOKES. A self-test that
// nothing schedules is an instrument for whoever edits the file, and an unedited file never runs its
// tests at all. builder_1 was hand-running them each cycle and labelled that a BRIDGE, NOT A FIX:
// it can be skipped and nothing notices, which is attention rather than arrangement.
//
// DISCOVERY, NOT A HARDCODED LIST, AND THAT IS THE WHOLE DESIGN. A list of scripts is itself a
// preference — someone has to remember to add the next one, and the day they forget is silent. This
// scans for files that ADVERTISE a --self-test flag, so a new script is covered the moment it is
// written and nobody has to remember anything.
//
// This file is the thing a cron calls. It does NOT schedule itself — adding the cron is a separate,
// deliberate act. IT IS NOW SCHEDULED: seb_boss cron `selftest-runner`, "7 13 * * *", added 12:35Z
// on 2026-08-03 and first fired at 13:07Z. ONE OWNER, seb_boss — builder_1 briefly registered a
// second daily sweep of this same script and REMOVED IT, because two owners for one check is how a
// check ends up with nobody responsible the day it starts failing.
//
// HOW THIS CAVEAT WAS FOUND, AND THE WAY IT WAS FOUND IS THE LESSON: builder_1 grepped all nine
// tools for caveats that had outlived their defect, hit this one, and CHECKED WHETHER IT WAS STILL
// TRUE — via `list-crons builder_1`, WHICH IS ONE LANE AND NOT THE FLEET. It read "nothing runs
// these on a schedule" from a single-agent query, five and a half hours after seb_boss scheduled it.
// THE SINGLE-LANE BLIND SPOT ARRIVING INSIDE THE CHECK FOR IT, exactly as check-brief-health had.
//
// The rule survives the miss and is worth keeping: A TRUE CAVEAT IS A FILED BUG THAT NOBODY FILED.
// A stale caveat misleads a reader; a TRUE one sits there being correct forever while the gap it
// names stays open, because nobody re-reads a caveat that was right. This one was true when written
// and went stale at 12:35Z — so it was a stale caveat after all, caught with the right instrument
// pointed at the wrong lane.
//
// EXIT 0 all passed · EXIT 2 at least one failed · EXIT 3 could not run.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, extname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const IS_MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

// SELF-EXCLUSION IS LOAD-BEARING, NOT TIDINESS. This file contains the literal '--self-test' in order
// to search for it, so discovery finds ITSELF and the runner spawns the runner, forever. Caught on the
// first run. The exclusion is by resolved path rather than by name so a copy under another name cannot
// reintroduce it.
const SELF = join(HERE, basename(fileURLToPath(import.meta.url)));

export function discover(dir = HERE) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (full === SELF) continue;
    const ext = extname(name);
    if (!['.mjs', '.js', '.py'].includes(ext)) continue;
    let body = '';
    try { body = readFileSync(full, 'utf8'); } catch { continue; }
    if (!body.includes('--self-test')) continue;
    out.push(full);
  }
  return out.sort();
}

export function runnerFor(path) {
  return extname(path) === '.py' ? 'python' : 'node';
}

// PARSES THE COUNT WHEN THE SCRIPT PRINTS ONE, AND TOLERATES ITS ABSENCE. A missing count is not a
// failure — pathform.py prints a BOUNDARY line and no ratio. Exit code is the verdict; the count is
// for the liveness line, which needs numbers to distinguish "ran and passed" from "ran and stopped
// measuring" (task_1785672685330_40401679).
export function parseCount(stdout) {
  const m = /self-test:\s*(\d+)\s*\/\s*(\d+)/i.exec(String(stdout || ''));
  return m ? { passed: Number(m[1]), total: Number(m[2]) } : null;
}

export function runOne(path, exec = spawnSync) {
  const r = exec(runnerFor(path), [path, '--self-test'], { encoding: 'utf8', timeout: 120000 });
  const stdout = String(r.stdout || '') + String(r.stderr || '');
  return { path, code: r.status === null ? 3 : r.status, count: parseCount(stdout), stdout };
}

if (process.argv.includes('--self-test') && IS_MAIN) {
  const cases = [
    // THE TRAP THAT BIT ON THE FIRST RUN. This file contains '--self-test' so that it can search for
    // it, so discovery finds itself and spawns itself forever.
    ['discovery EXCLUDES this runner', () => !discover().includes(SELF)],
    ['discovery finds the known unwired scripts', () => {
      const found = discover().map((p) => basename(p));
      return found.includes('pathform.mjs') && found.includes('check-brief-health.mjs');
    }],
    ['python files get python, js files get node', () =>
      runnerFor('/x/a.py') === 'python' && runnerFor('/x/a.mjs') === 'node'],
    ['a ratio is parsed when present', () => {
      const c = parseCount('foo\ncheck-brief-health --self-test: 11/11\nbar');
      return c && c.passed === 11 && c.total === 11;
    }],
    // NOT A FAILURE. pathform.py prints a BOUNDARY and no ratio; treating that as broken would flag a
    // healthy script every run and get the runner muted inside a week.
    ['absence of a ratio is null, not a failure', () => parseCount('BOUNDARY: proves both forms') === null],
    // MUST-FAIL, WITH A FAKE EXEC SO IT IS A TEST RATHER THAN PROSE. A runner that only ever reports
    // success has reproduced the defect it exists to remove.
    ['a FAILING script is reported as failing', () => {
      const fake = () => ({ status: 2, stdout: 'FAIL something\nx --self-test: 3/4', stderr: '' });
      const r = runOne('/x/broken.mjs', fake);
      return r.code === 2 && r.count.passed === 3 && r.count.total === 4;
    }],
    // PAIRED NEGATIVE: a passing script must not be reported as failing.
    ['a PASSING script is not reported as failing', () => {
      const fake = () => ({ status: 0, stdout: 'x --self-test: 4/4', stderr: '' });
      return runOne('/x/ok.mjs', fake).code === 0;
    }],
    // A KILLED CHILD IS COULD-NOT-RUN, NOT A FAILURE. spawnSync returns status null on timeout/signal,
    // and Number(null) is 0 — so the obvious coercion would report a killed test as PASSING. That is
    // the same shape as the caller-timeout kill that left no receipt at 05:59Z tonight.
    ['a KILLED child is 3, not 0', () => {
      const fake = () => ({ status: null, stdout: '', stderr: 'timeout' });
      return runOne('/x/killed.mjs', fake).code === 3;
    }],
  ];
  let failed = 0;
  for (const [name, fn] of cases) {
    let ok = false;
    try { ok = fn() === true; } catch { ok = false; }
    if (!ok) failed += 1;
    console.log((ok ? 'ok   ' : 'FAIL ') + name);
  }
  console.log('');
  console.log(`run-selftests --self-test: ${cases.length - failed}/${cases.length}`);
  console.log('BOUNDARY: this proves discovery, dispatch and verdict mapping with a FAKE exec. It does');
  console.log('not prove the real children pass — that is what a live run reports, and a live run is');
  console.log('the only thing that can. NOTHING SCHEDULES THIS FILE EITHER: until a cron calls it, the');
  console.log('gap is COVERED-WHEN-RUN, not fixed.');
  process.exit(failed === 0 ? 0 : 2);
}

if (IS_MAIN && !process.argv.includes('--self-test')) {
  const targets = discover();
  if (!targets.length) { console.log('VERDICT: COULD-NOT-RUN — discovered no self-testable scripts'); process.exit(3); }
  const results = targets.map((t) => runOne(t));
  const failedRuns = results.filter((r) => r.code !== 0);

  // FAILURES ONLY, PLUS A LIVENESS LINE CARRYING THE NUMBERS. A liveness line without counts cannot
  // distinguish "ran and passed" from "ran and stopped measuring".
  for (const r of failedRuns) {
    console.log(`FAIL ${basename(r.path)}  exit ${r.code}${r.count ? `  ${r.count.passed}/${r.count.total}` : ''}`);
    for (const line of r.stdout.split(/\r?\n/).filter((l) => /^FAIL|Error|Traceback|AssertionError/.test(l)).slice(0, 6)) {
      console.log(`     ${line}`);
    }
  }
  const summary = results.map((r) => `${basename(r.path)} ${r.count ? `${r.count.passed}/${r.count.total}` : (r.code === 0 ? 'ok' : `exit ${r.code}`)}`).join(' · ');
  // THE SCOPE IS PART OF THE NUMBER. "9 script(s)" reads as EVERY self-testing tool and is in fact
  // every self-testing tool IN scripts/ — the same denominator defect fixed in step10-gap-check
  // twenty minutes earlier, in the sweep built to catch that class, found by listing every file in
  // the repo that advertises --self-test instead of trusting the sweep's own count.
  console.log(`LIVENESS ${new Date().toISOString().slice(0, 16)}Z — ${results.length} script(s) in ${HERE.replace(/\\/g, '/').split('/').slice(-1)[0]}/: ${summary}`);
  // NOT SWEPT, AND NAMED RATHER THAN SILENTLY ABSENT. work/ holds real self-testing tools
  // (step10-gap-check 11/11, detector-falsifiability, cron-shrink-check, cron-injection-trace,
  // cron-execution-audit) ALONGSIDE scratch files and STALE-DO-NOT-RESTORE sabotage copies kept
  // deliberately for restore-verification. Sweeping that directory would EXECUTE the stale copies,
  // so the scope is correct and only the silence about it was not.
  console.log('NOT SWEPT: work/ — real tools live there (step10-gap-check 11/11) next to STALE-DO-NOT-RESTORE');
  console.log('sabotage copies that must never be executed. Run those by hand; this line exists so a');
  console.log('green sweep cannot read as "every self-testing tool passed".');
  // A SCOPE STATEMENT IS NOT A FINDING, AND SAYING SO IS PART OF THE STATEMENT. seb_boss caught this
  // on the cron side: without the disclaimer his next fire would report work/ as an anomaly — A CHECK
  // MANUFACTURING A FINDING OUT OF ITS OWN HONESTY. The line that admits a limit must also say the
  // limit is not the alarm, or adding honesty to a checker makes it noisier and gets it ignored.
  console.log('THIS IS A SCOPE STATEMENT, NOT A FINDING. It does not affect the exit code and is printed');
  console.log('on every run, including clean ones.');
  process.exit(failedRuns.length ? 2 : 0);
}
