// suppress-gate — decide whether a check should suppress, and WRITE THE EVIDENCE ITSELF.
//
// WHY THIS EXISTS. guard-arm-check was given a suppress-while-blocked rule with three conditions:
// (1) name the blocking task id inline, (2) every suppressed fire still writes ONE log line, and
// (3) a time bound that reports regardless after N days. Condition 1 is TEXT and holds by itself.
// CONDITIONS 2 AND 3 WERE INSTRUCTIONS TO AN AGENT, and seb_boss named the fault the moment it
// landed:
//
//   THE SUPPRESSION IS SELF-ENFORCING AND THE SAFEGUARDS ARE NOT. Not reporting requires no action.
//   Writing the line, computing the age, and reporting past the bound all require action. So the
//   failure mode is silent by construction and the correct behaviour is the one that costs
//   something — the worst possible arrangement of the two.
//
// GENERAL FORM, AND IT IS WHY CONDITIONS DID NOT FIX IT: WHEN THE SAFE BEHAVIOUR COSTS MORE THAN THE
// UNSAFE ONE, THE ARRANGEMENT IS INVERTED NO MATTER HOW MANY CONDITIONS ARE ATTACHED. Conditions do
// not change the cost gradient. Only moving the work off the agent does.
//
// So this reads the blocker's ACTUAL STATUS, computes the age itself, and appends the log line as a
// side effect of being run. The caller cannot suppress without the evidence, because the same call
// produces both.
//
//   node scripts/suppress-gate.mjs <task-id> [--max-days=14] [--check=<name>] [--log=<path>]
//
// EXIT 0 = SUPPRESS (blocker still open, inside the bound). EXIT 2 = REPORT. EXIT 3 = could not run.
import { readFileSync, existsSync, readdirSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const IS_MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const ROOT = process.env.CTX_ROOT || join(homedir(), '.cortextos', 'default');
const ORG = process.env.CTX_ORG || 'SEB_company';

// A blocker that is completed or archived no longer blocks. Anything else still does.
const OPEN = new Set(['pending', 'in_progress', 'blocked']);

export function findTask(id, tasksDir) {
  for (const dir of [tasksDir, join(tasksDir, 'archive')]) {
    if (!existsSync(dir)) continue;
    const hit = readdirSync(dir).filter((f) => f.startsWith(id) && f.endsWith('.json'));
    if (hit.length) {
      try { return { ...JSON.parse(readFileSync(join(dir, hit[0]), 'utf8')), _where: dir === tasksDir ? 'live' : 'archive' }; }
      catch { return null; }
    }
  }
  return null;
}

// THE VERDICT IS A PURE FUNCTION SO THE SELF-TEST CAN DRIVE EVERY BRANCH. Ordering matters:
// a MISSING blocker must report rather than suppress — an id that does not resolve is the
// symptom-back-reference failure, and suppressing on it would hide a check behind a phantom.
export function decide({ task, ageDays, maxDays, ageKnown = true, alreadyReportedClear = false }) {
  if (!task) {
    return { code: 2, state: 'REPORT', reason: 'blocker id does not resolve to any task — a suppression pointing at a phantom is worse than none' };
  }
  // AN UNKNOWN AGE MUST NOT SUPPRESS. Found 2026-08-03T16:4xZ by taking seb_boss's "task records are
  // uniform TODAY" seriously: if a task carries no parseable updated_at or created_at, the caller
  // computes ageDays = 0, zero never reaches the bound, AND THE SUPPRESSION RUNS FOREVER. That is
  // precisely the muted-until-someone-remembers state the time bound exists to make impossible, and
  // it would arrive through the bound's own arithmetic. Ordered above the status check for the same
  // reason as the phantom case: an unbypassable refusal has to come before the thing it overrides.
  if (!ageKnown) {
    return { code: 2, state: 'REPORT-AGE-UNKNOWN', reason: 'blocker has no parseable date, so the time bound can never fire — suppressing on an unmeasurable age is silence with no expiry' };
  }
  if (!OPEN.has(String(task.status))) {
    // A completed/archived blocker stays completed forever, so this branch fires on EVERY
    // subsequent call with no state of its own — found 2026-08-13 via guard-arm-check reporting
    // "first fire after it cleared" three times, 6h apart, for the same already-cleared blocker.
    // Report ONCE per clearing event, then go quiet: the fact does not change on later fires, so
    // repeating it is the exact noise this gate exists to stop, just on the clear side instead of
    // the still-blocked side.
    if (alreadyReportedClear) {
      return { code: 0, state: 'SUPPRESS-ALREADY-REPORTED', reason: `blocker is ${task.status} — already reported as cleared, not re-reporting the same fact` };
    }
    return { code: 2, state: 'REPORT', reason: `blocker is ${task.status} — first fire after it cleared` };
  }
  if (ageDays >= maxDays) {
    return { code: 2, state: 'REPORT-BOUND-EXCEEDED', reason: `suppressed ${ageDays.toFixed(1)}d on a ${maxDays}d bound — verify the blocker is still real` };
  }
  return { code: 0, state: 'SUPPRESS', reason: `blocker open (${task.status}), ${ageDays.toFixed(1)}d of ${maxDays}d` };
}

if (process.argv.includes('--self-test') && IS_MAIN) {
  const T = (status) => ({ status, id: 'task_x', title: 't' });
  const cases = [
    ['open blocker inside the bound SUPPRESSES', () => decide({ task: T('blocked'), ageDays: 3, maxDays: 14 }).code === 0],
    ['a COMPLETED blocker reports', () => decide({ task: T('completed'), ageDays: 3, maxDays: 14 }).code === 2],
    // MUST-FAIL CASE (task_1786624343102): found live 2026-08-13, guard-arm-check reported "first
    // fire after it cleared" three consecutive fires, 6h apart, for the SAME already-cleared
    // blocker — the branch has no memory of its own, so it re-fires every time. The second
    // consecutive REPORT against an already-completed blocker must NOT repeat the first-fire
    // reason string, and must suppress rather than report the same already-acknowledged fact again.
    ['a SECOND fire against an already-reported cleared blocker suppresses, does not repeat "first fire"', () => {
      const v = decide({ task: T('completed'), ageDays: 3, maxDays: 14, alreadyReportedClear: true });
      return v.code === 0 && v.state === 'SUPPRESS-ALREADY-REPORTED' && !v.reason.includes('first fire');
    }],
    // PAIRED NEGATIVE: alreadyReportedClear must only change the completed/archived branch. An
    // OPEN blocker ignores the flag entirely — it was never eligible for a "cleared" report.
    ['alreadyReportedClear has no effect on an open blocker', () =>
      decide({ task: T('blocked'), ageDays: 3, maxDays: 14, alreadyReportedClear: true }).code === 0],
    ['past the bound reports even though the blocker is open', () => {
      const v = decide({ task: T('blocked'), ageDays: 14.2, maxDays: 14 });
      return v.code === 2 && v.state === 'REPORT-BOUND-EXCEEDED';
    }],
    // THE BOUND IS THE POINT: a 0-day bound must report immediately despite an open blocker.
    // seb_boss's third case, and it tests the BOUND rather than the suppression.
    ['a 0-day bound reports immediately', () => decide({ task: T('blocked'), ageDays: 0, maxDays: 0 }).code === 2],
    // A phantom id must never suppress. Pointing a mute at a task that does not exist is the
    // symptom-back-reference failure: it looks like a chain and terminates in itself.
    ['an UNRESOLVABLE blocker id reports, never suppresses', () => decide({ task: null, ageDays: 1, maxDays: 14 }).code === 2],
    // AN UNMEASURABLE AGE MUST NOT SUPPRESS. A task with no parseable date gives ageDays 0, and zero
    // never reaches the bound — so without this the suppression runs forever, through the arithmetic
    // of the very bound that exists to stop that.
    ['an UNKNOWN age reports, never suppresses', () => {
      const v = decide({ task: T('blocked'), ageDays: 0, maxDays: 14, ageKnown: false });
      return v.code === 2 && v.state === 'REPORT-AGE-UNKNOWN';
    }],
    // PAIRED NEGATIVE: a KNOWN age of zero — a blocker updated seconds ago — must still suppress.
    ['a KNOWN age of zero still suppresses', () =>
      decide({ task: T('blocked'), ageDays: 0, maxDays: 14, ageKnown: true }).code === 0],
    // PAIRED NEGATIVE for the whole gate: without this, "always report" passes everything above.
    ['the ONLY suppressing case is open-and-inside-bound', () => {
      const all = [
        decide({ task: T('blocked'), ageDays: 1, maxDays: 14 }),
        decide({ task: T('pending'), ageDays: 1, maxDays: 14 }),
        decide({ task: T('in_progress'), ageDays: 1, maxDays: 14 }),
      ];
      return all.every((v) => v.code === 0);
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
  console.log(`suppress-gate --self-test: ${cases.length - failed}/${cases.length}`);
  console.log('BOUNDARY: this drives the DECISION with synthetic tasks. It does not prove the log line');
  console.log('is actually appended, which is the whole reason the tool exists — that is only observable');
  console.log('by running it for real and reading the log afterwards.');
  process.exit(failed === 0 ? 0 : 2);
}

if (IS_MAIN && !process.argv.includes('--self-test')) {
  const id = process.argv.find((a) => a.startsWith('task_'));
  if (!id) { console.log('VERDICT: COULD-NOT-RUN — no task id given'); process.exit(3); }
  const maxDays = Number((process.argv.find((a) => a.startsWith('--max-days=')) || '--max-days=14').split('=')[1]);
  const check = (process.argv.find((a) => a.startsWith('--check=')) || '--check=unnamed').split('=')[1];
  const tasksDir = join(ROOT, 'orgs', ORG, 'tasks');
  if (!existsSync(tasksDir)) { console.log(`VERDICT: COULD-NOT-RUN — no task store at ${tasksDir}`); process.exit(3); }

  const task = findTask(id, tasksDir);
  const since = task ? Date.parse(task.updated_at || task.created_at || '') : NaN;
  const ageKnown = Number.isFinite(since);
  const ageDays = ageKnown ? (Date.now() - since) / 86400000 : 0;

  // THE LOG LINE IS WRITTEN BY THE SAME CALL THAT PRODUCES THE VERDICT. That coupling is the entire
  // design: a caller cannot obtain a SUPPRESS without also leaving the record of it, so a suppressed
  // fire and a fire that never happened stop being indistinguishable.
  const logPath = (process.argv.find((a) => a.startsWith('--log=')) || '').split('=')[1]
    || join(ROOT, 'state', process.env.CTX_AGENT_NAME || 'builder_1', '.suppression-log.jsonl');

  // HAS THIS SPECIFIC CLEARING ALREADY BEEN REPORTED? The log itself is the state store — no new
  // file needed. Scan prior lines (written by earlier runs, before this one appends its own) for a
  // REPORT against this same blocker id while its status was already non-open. If one exists, the
  // "first fire after it cleared" fact has already reached a reader; reporting it again is the
  // repeat-noise bug this fix closes.
  let alreadyReportedClear = false;
  if (existsSync(logPath)) {
    try {
      for (const line of readFileSync(logPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line);
        if (entry.blocker === id && entry.state === 'REPORT' && !OPEN.has(String(entry.blocker_status))) {
          alreadyReportedClear = true;
          break;
        }
      }
    } catch {
      // A CORRUPT OR UNREADABLE LOG MUST NOT SUPPRESS AN EXISTING REPORT. Falling back to false
      // (never reported) at worst re-reports once — the safe side, matching every other refusal in
      // this file — rather than risk swallowing a report the caller never actually saw.
    }
  }

  const v = decide({ task, ageDays, maxDays, ageKnown, alreadyReportedClear });

  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, JSON.stringify({
      ts: new Date().toISOString(), check, blocker: id,
      blocker_status: task ? task.status : 'NOT-FOUND',
      age_days: Number(ageDays.toFixed(2)), max_days: maxDays, state: v.state,
    }) + '\n', 'utf8');
  } catch (e) {
    // A LOG FAILURE MUST NOT PRODUCE A SILENT SUPPRESS. If the evidence cannot be written, the
    // suppression loses its justification, so fall through to REPORT.
    console.log(`VERDICT: REPORT — could not write the suppression log (${e.message}), so suppression is not justified`);
    process.exit(2);
  }
  console.log(`${v.state}: ${v.reason}`);
  console.log(`  blocker ${id} (${task ? task.status : 'NOT-FOUND'}) · logged to ${logPath}`);
  process.exit(v.code);
}
