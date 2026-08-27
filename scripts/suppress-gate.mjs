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
//   node scripts/suppress-gate.mjs <task-id> [--max-days=14] [--check=<name>] [--log=<path>] [--fingerprint=<val>]
//
// EXIT 0 = SUPPRESS (blocker still open, inside the bound). EXIT 2 = REPORT. EXIT 3 = could not run.
//
// RE-ARM ON A CHANGED FINGERPRINT (task_1787207549324, 2026-08-26). A completed blocker suppresses
// forever once its clearing has been reported once (SUPPRESS-ALREADY-REPORTED) — correct for the
// blocker itself, wrong for a check whose underlying condition can RECUR after the blocker clears.
// guard-arm-check's blocker was "npm build + pm2 restart" — completed once, permanently — but
// STALE-DAEMON is structural: any future build without a matching restart reproduces it, and once
// the old blocker is reported cleared there is no new task to key a new suppression window on. An
// optional caller-supplied --fingerprint (e.g. the live daemon up_since) is carried in the log
// alongside each REPORT. If the fingerprint at a later already-cleared fire differs from the one
// recorded at the last REPORT, that is a NEW instance of the condition, not a repeat of the old
// one, and the gate reports again (REPORT-NEW-FINGERPRINT) instead of suppressing. Omitting
// --fingerprint reproduces the exact pre-existing behaviour — this is additive, not a replacement.
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
export function decide({ task, ageDays, maxDays, ageKnown = true, alreadyReportedClear = false, fingerprint, lastReportedFingerprint }) {
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
      // A CHANGED FINGERPRINT MEANS THIS IS NOT THE SAME FACT. Both sides must be present and
      // differ — an undefined fingerprint on either side means the caller never opted into this
      // (or no prior report carried one), and that must reproduce the pre-existing behaviour
      // exactly: suppress, unconditionally, on the blocker's status alone. Checked FIRST — the
      // faster of the two triggers, since a fingerprint change is detectable the moment it happens
      // rather than waiting on the age bound below.
      if (fingerprint !== undefined && lastReportedFingerprint !== undefined && fingerprint !== lastReportedFingerprint) {
        return {
          code: 2,
          state: 'REPORT-NEW-FINGERPRINT',
          reason: `blocker is ${task.status} but the fingerprint changed since the last report (${lastReportedFingerprint} -> ${fingerprint}) — a new instance of the underlying condition, not a repeat of the one already reported`,
        };
      }
      // AGE-BOUND BACKSTOP (found live 2026-08-27, TG9823 crossed 14.18d suppressed with no
      // report). The bound below (for the still-OPEN branch) never reached a completed blocker —
      // this branch returned SUPPRESS-ALREADY-REPORTED unconditionally, so a completed blocker
      // with no fingerprint change could suppress FOREVER, exactly the "muted-until-someone-
      // remembers" state the bound exists to make impossible. seb_boss's ruling: the bound is a
      // universal backstop, not conditional on which branch — fingerprint is the earlier/faster
      // trigger, the age bound is what fires regardless if fingerprint never does.
      if (ageDays >= maxDays) {
        return { code: 2, state: 'REPORT-BOUND-EXCEEDED', reason: `suppressed ${ageDays.toFixed(1)}d on a ${maxDays}d bound (blocker ${task.status}, already reported cleared) — verify the underlying condition is still worth muting rather than assumed` };
      }
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
    // RE-ARM ON FINGERPRINT CHANGE (task_1787207549324): an already-cleared blocker whose caller
    // supplies a fingerprint that DIFFERS from the one recorded at the last report is a NEW
    // instance of the underlying condition (e.g. the daemon restarted, then went stale again) —
    // this must REPORT, not repeat SUPPRESS-ALREADY-REPORTED forever on a permanently-completed
    // blocker.
    ['alreadyReportedClear + CHANGED fingerprint re-arms and reports', () => {
      const v = decide({ task: T('completed'), ageDays: 20, maxDays: 14, alreadyReportedClear: true, fingerprint: 'F2', lastReportedFingerprint: 'F1' });
      return v.code === 2 && v.state === 'REPORT-NEW-FINGERPRINT';
    }],
    // PAIRED NEGATIVE: the SAME fingerprint on both sides must still suppress — nothing new
    // happened, so this is not a case for double-reporting. ageDays kept BELOW maxDays
    // deliberately — this tests the fingerprint-unchanged path in isolation, not the age-bound
    // backstop (that has its own cases below now that the backstop applies here too).
    ['alreadyReportedClear + UNCHANGED fingerprint still suppresses (inside the age bound)', () =>
      decide({ task: T('completed'), ageDays: 3, maxDays: 14, alreadyReportedClear: true, fingerprint: 'F1', lastReportedFingerprint: 'F1' }).code === 0],
    // AGE-BOUND BACKSTOP APPLIES TO THE COMPLETED BRANCH TOO (found live 2026-08-27, TG9823
    // crossed 14.18d suppressed with no report — the bound used to only live in the still-OPEN
    // branch, so a completed blocker with no fingerprint change could suppress FOREVER). This is
    // the must-fail case: past the bound, even with a fingerprint that never changed, must REPORT.
    ['alreadyReportedClear + UNCHANGED fingerprint PAST the age bound still reports (backstop)', () => {
      const v = decide({ task: T('completed'), ageDays: 14.5, maxDays: 14, alreadyReportedClear: true, fingerprint: 'F1', lastReportedFingerprint: 'F1' });
      return v.code === 2 && v.state === 'REPORT-BOUND-EXCEEDED';
    }],
    // SAME BACKSTOP, NO FINGERPRINT AT ALL — this is the exact shape of the live bug: TG9823 was
    // never passed a fingerprint until the day this fix landed, so every prior fire took this path.
    ['alreadyReportedClear + NO fingerprint PAST the age bound still reports (backstop)', () => {
      const v = decide({ task: T('completed'), ageDays: 14.5, maxDays: 14, alreadyReportedClear: true });
      return v.code === 2 && v.state === 'REPORT-BOUND-EXCEEDED';
    }],
    // ORDERING: a CHANGED fingerprint past the bound reports as REPORT-NEW-FINGERPRINT, not
    // REPORT-BOUND-EXCEEDED — the fingerprint is the faster/earlier trigger and must win when both
    // conditions are true, since it carries more specific information (what changed, not just that
    // time passed).
    ['CHANGED fingerprint past the age bound reports as NEW-FINGERPRINT, not bound-exceeded', () => {
      const v = decide({ task: T('completed'), ageDays: 14.5, maxDays: 14, alreadyReportedClear: true, fingerprint: 'F2', lastReportedFingerprint: 'F1' });
      return v.code === 2 && v.state === 'REPORT-NEW-FINGERPRINT';
    }],
    // BACKWARD COMPATIBILITY: a caller that never opts into fingerprints (both sides undefined)
    // must reproduce the exact pre-existing behaviour — suppress on status alone. Without this,
    // adding the feature would be a silent behaviour change for the one caller that does not pass
    // --fingerprint yet.
    ['no fingerprint supplied at all reproduces prior behaviour (suppresses)', () =>
      decide({ task: T('completed'), ageDays: 3, maxDays: 14, alreadyReportedClear: true }).code === 0],
    // PAIRED NEGATIVE: an OPEN blocker ignores fingerprint entirely, same as it ignores
    // alreadyReportedClear — fingerprint comparison only applies inside the completed/archived
    // branch, never to a still-open blocker.
    ['fingerprint has no effect on an open blocker', () =>
      decide({ task: T('blocked'), ageDays: 3, maxDays: 14, alreadyReportedClear: true, fingerprint: 'F2', lastReportedFingerprint: 'F1' }).code === 0],
    // A first-fire-after-clear (alreadyReportedClear still false) is REPORT regardless of any
    // fingerprint value — there is no "last reported" to differ from yet, so this must stay the
    // plain first-fire state, not REPORT-NEW-FINGERPRINT.
    ['first fire after clear stays plain REPORT even if a fingerprint is supplied', () => {
      const v = decide({ task: T('completed'), ageDays: 3, maxDays: 14, alreadyReportedClear: false, fingerprint: 'F1' });
      return v.code === 2 && v.state === 'REPORT';
    }],
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
  // OPTIONAL. Absent entirely (not even the empty string) reproduces the exact pre-existing
  // behaviour — see decide()'s backward-compatibility case.
  const fingerprintArg = process.argv.find((a) => a.startsWith('--fingerprint='));
  const fingerprint = fingerprintArg ? fingerprintArg.slice('--fingerprint='.length) : undefined;
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
  // THE FINGERPRINT RECORDED AT THE LAST REPORT-WHILE-CLEARED FIRE, if any. Not break-on-first:
  // the log is append-only chronological, so the LATEST matching line has to win, and only
  // scanning to the end (not stopping at the first match) gets that — a re-armed REPORT-NEW-
  // FINGERPRINT fire is itself a later match this loop must see, or the very next fire would
  // re-arm again against the stale F1 instead of the F2 it just reported.
  let lastReportedFingerprint;
  if (existsSync(logPath)) {
    try {
      for (const line of readFileSync(logPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line);
        // 'REPORT' (first fire after clearing) or 'REPORT-NEW-FINGERPRINT' (a re-arm) both count
        // as "clearing has been reported" — deliberately NOT startsWith('REPORT'), which would
        // also swallow 'REPORT-AGE-UNKNOWN' (a different fact: the age couldn't be measured, not
        // that the blocker cleared) if it ever co-occurred with a non-open status.
        if (entry.blocker === id && (entry.state === 'REPORT' || entry.state === 'REPORT-NEW-FINGERPRINT') && !OPEN.has(String(entry.blocker_status))) {
          alreadyReportedClear = true;
          lastReportedFingerprint = entry.fingerprint;
        }
      }
    } catch {
      // A CORRUPT OR UNREADABLE LOG MUST NOT SUPPRESS AN EXISTING REPORT. Falling back to false
      // (never reported) at worst re-reports once — the safe side, matching every other refusal in
      // this file — rather than risk swallowing a report the caller never actually saw.
      alreadyReportedClear = false;
      lastReportedFingerprint = undefined;
    }
  }

  const v = decide({ task, ageDays, maxDays, ageKnown, alreadyReportedClear, fingerprint, lastReportedFingerprint });

  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, JSON.stringify({
      ts: new Date().toISOString(), check, blocker: id,
      blocker_status: task ? task.status : 'NOT-FOUND',
      age_days: Number(ageDays.toFixed(2)), max_days: maxDays, state: v.state,
      // Only present when the caller opts in — an absent key (not a null) keeps old log lines and
      // non-fingerprint callers indistinguishable from "never supplied one" on the next scan.
      ...(fingerprint !== undefined ? { fingerprint } : {}),
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
