import { wipeConditionArmed } from '../daemon/cron-drift.js';

/**
 * Warn — loudly, at the moment of enabling or starting an agent — if that agent's next boot will
 * silently wipe its runtime-added crons.
 *
 * WHY IT LIVES HERE AND NOT ONLY IN THE DRIFT REPORT. `check-cron-drift` excludes disabled agents
 * from scope, which is correct (a disabled agent does not boot, so nothing it declares can fire).
 * But that exclusion makes RE-ENABLING silent: the agent returns to scope, and the wipe condition
 * arms, and the only thing that would have said so is a 6-hourly report the person flipping the
 * switch is not reading. Twice in two hours on 2026-07-30 something on this box was re-enabled
 * after a long disabled period — codex_runner's status ruling, and a surface-poll task restored to
 * Ready after ten weeks — and nothing in either decision path consulted this condition.
 *
 * CALLED FROM EVERY TRANSITION INTO RUNNING, not just the one where the bug was noticed. A
 * mechanism applied to one call site while an identical site stays unguarded is a fix plus a
 * survivor. The sites are: `cortextos start <agent>` (which sends start-agent over IPC even for an
 * agent already in the roster, so the roster write is NOT the trigger — the boot is) and
 * `cortextos enable-agent`.
 *
 * WARNS, NEVER BLOCKS. Refusing to start an agent over a cron-state warning would be a worse
 * failure than the wipe: the operator wants the agent running, and a gate here gets worked around
 * by editing the roster by hand, which skips this check entirely.
 */
export function warnIfWipeArmed(agentName: string, ctxRoot: string): void {
  let armed: string[] | null;
  try {
    armed = wipeConditionArmed(agentName, ctxRoot);
  } catch {
    // Never let a diagnostic break an enable. Silence here is safe in the direction that matters:
    // the operator still gets their agent, and the drift report still covers the agent once it is
    // enabled and back in scope.
    return;
  }
  if (!armed) return;

  console.error(
    `\nWARNING: ${agentName} has NO .crons-migrated marker but crons.json holds ${armed.length} ` +
      `cron(s). Its next boot will OVERWRITE crons.json from config.json, silently losing every ` +
      `cron added at runtime:\n` +
      armed.map((n) => `    - ${n}`).join('\n') +
      `\n  These exist only in crons.json; config.json does not know about them.\n` +
      `  Back them up before it boots, or write the marker if the migration has already happened:\n` +
      `    ${ctxRoot}/.cortextOS/state/agents/${agentName}/.crons-migrated\n` +
      `  Not blocking the start — this is a warning.\n`,
  );
}
