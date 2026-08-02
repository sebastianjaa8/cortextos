---
status: resolved
trigger: "CortexOS is down again after the 2026-07-24 daemon self-restart recovery"
created: 2026-08-01T13:51:14.7919737-04:00
updated: 2026-08-01T14:49:00-04:00
---

## Current Focus

hypothesis: the dedicated PM2 ownership fence detects an orphan within approximately six seconds and stale actionable guidance now points to the safe restart path
test: after incompatible stop-exit-code remnants are removed by the primary investigator, rerun focused tests and perform a live safe daemon restart to prove PM2 pid, daemon.pid, lock owner, and 13-agent health remain aligned
expecting: the canonical daemon restarts once, ownership remains aligned, and all 13 enabled agents return healthy without a competitor loop
next_action: primary investigator removes policy-blocked stop-exit-code remnants in src/daemon/index.ts, src/cli/ecosystem.ts, and the focused test, then performs live verification

## Symptoms

expected: canonical PM2 daemon online, 13 enabled agents healthy, scheduled persistence able to recover outages
actual: user reports CortexOS is down again
errors: not yet inspected; derive from current PM2, scheduled task, lock, runtime, daemon logs, and repository state
reproduction: unknown; inspect timestamps and recovery mechanisms before attempting restart
started: reported 2026-08-01 America/New_York; system was previously healthy after commit 9afa5c1 on 2026-07-24

## Eliminated

## Evidence

- timestamp: 2026-08-01T13:54:00-04:00
  checked: repository instructions, prior debug knowledge, and git state
  found: no debug knowledge base exists; branch main tracks restore/main and is ahead 382/behind 364; pre-existing changes include dev/finance-tracker-codex, scripts/.surface-poll-state.json, .planning/, and state/
  implication: this incident has no known-pattern shortcut and all unrelated working-tree changes must be preserved

- timestamp: 2026-08-01T14:01:00-04:00
  checked: default PM2 daemon without setting PM2_HOME
  found: the shell has no PM2_HOME override and PM2 resolves C:\Users\Sebas\.pm2; it currently reports cortextos-daemon-default online as pid 28724 alongside pm2-logrotate
  implication: the current outage is not simply an empty PM2 process list; exact uptime, agent health, locks, and recovery timestamps must be checked before any restart

- timestamp: 2026-08-01T14:08:00-04:00
  checked: scripts/cortextos-health.ps1 against the live canonical instance
  found: health is UNHEALTHY with 17 failures; PM2 is waiting restart with 1163 restarts, daemon.pid and fresh fenced lock belong to live pid 27016, the current PM2 pid differs, and all 13 enabled agents are absent from the daemon registry
  implication: PM2 is supervising competitors while an untracked but responsive daemon owns the instance; the first PM2 listing was a transient online window inside the 15-second crash loop

- timestamp: 2026-08-01T14:08:00-04:00
  checked: daemon error and PM2 logs
  found: competitors exit every approximately 15 seconds with Another cortextOS daemon is already running for instance default; PM2 repeatedly marks the app online, observes exit code 1, and schedules another restart
  implication: restarting PM2 again without removing the ownership divergence would reproduce the loop and is not a fix

- timestamp: 2026-08-01T14:08:00-04:00
  checked: initial Windows scheduled-task name filter and system boot time
  found: the host last booted 2026-07-24 22:50 local; the name filter found only cortextos-surface-poll and missed the separately named PM2 Resurrect task
  implication: the initial conclusion that logon persistence was absent was invalid and requires direct inspection of PM2 Resurrect

- timestamp: 2026-08-01T14:14:00-04:00
  checked: builder_1 stdout and PM2 log around 2026-08-01 08:50 local
  found: builder_1 ran npx pm2 restart cortextos-daemon-default to load commit 198dfd77; PM2 stopped pid 15332, force-killed its tree at 08:50:30, spawned replacement pid 27016, then processed the old generation exit callback in the same second and marked the new generation exited
  implication: pid 27016 was a PM2-spawned replacement orphaned by a supervisor bookkeeping race, not an independently launched duplicate

- timestamp: 2026-08-01T14:14:00-04:00
  checked: daemon stdout lines 2059 through 2128
  found: a later cortextos stop --all request drained all 13 agents from orphan pid 27016 but intentionally left the daemon alive
  implication: the orphan retained IPC and the fenced lock with an empty registry, producing the reported complete service outage while blocking every PM2 replacement

- timestamp: 2026-08-01T14:14:00-04:00
  checked: controlled recovery performed by the primary investigator
  found: at 13:58 local the PM2 loop was stopped, pid 27016 identity and lock ownership were revalidated, its descendants and process were terminated, then the default instance was started canonically and the PM2 manifest saved
  implication: runtime availability has been recovered separately; remaining work is the exact-class recurrence guard and verification

- timestamp: 2026-08-01T14:20:00-04:00
  checked: installed PM2 ForkMode.js and current PM2 source documentation
  found: PM2 copies scalar pm2_env fields into the forked child environment, including pm_pid_path, and writes the spawned child pid to that exact path; fork mode is detached and therefore permits a child to survive supervisor bookkeeping loss
  implication: the daemon can detect this exact orphan state locally by comparing process.pid with the pid published at process.env.pm_pid_path; direct non-PM2 launches have no path and must remain unaffected

- timestamp: 2026-08-01T14:24:00-04:00
  checked: new focused daemon supervisor-ownership regression test before implementation
  found: vitest failed exactly because pm2SupervisorOwnsCurrentProcess is undefined; the pre-existing instance-lock test still passed
  implication: the new test reproduces the missing recurrence guard rather than an unrelated failure

- timestamp: 2026-08-01T14:28:00-04:00
  checked: focused daemon supervisor-ownership regression test after implementation
  found: both tests pass; the helper accepts a matching PM2 pid, rejects mismatched, malformed, and missing PM2 pid metadata, and leaves non-PM2 launches unclassified
  implication: the daemon can now terminate an orphaned PM2 generation on the existing 30-second fenced-lock heartbeat without blocking supported direct launches

- timestamp: 2026-08-01T14:40:00-04:00
  checked: exact Windows scheduled task named PM2 Resurrect
  found: task is Ready with an interactive logon trigger, ran successfully at 2026-07-24 22:50:39 local with result 0, and invokes scripts/pm2-resurrect-sanitized.ps1
  implication: canonical logon persistence is installed and healthy; it was not involved because the host did not reboot during this incident

- timestamp: 2026-08-01T14:40:00-04:00
  checked: supervisor-fence timing revision
  found: ownership checks now run on a dedicated 2-second unref timer, require three consecutive failed reads, reset on a valid owner, and clear during exit cleanup
  implication: a true PM2 orphan is bounded to approximately six seconds while transient PID-file publication is tolerated

- timestamp: 2026-08-01T14:40:00-04:00
  checked: canonical templates, active codex_runner skills, and builder_1 long-term memory
  found: actionable direct PM2 daemon restart guidance now uses cortextos restart --daemon --instance default and explicitly forbids direct PM2 restart on Windows
  implication: the same unsafe operator action is no longer taught by the active and generated guidance placed in scope

- timestamp: 2026-08-01T14:48:00-04:00
  checked: targeted regression and adjacent daemon tests, TypeScript typecheck, production build, and scoped unsafe-guidance scan
  found: 18 tests pass, typecheck is clean, build succeeds, and no actionable unsafe restart command remains in the scoped templates, active codex_runner skills, or builder memory
  implication: the self-fence and guidance edits are internally verified; live PM2 restart validation remains with the primary investigator

- timestamp: 2026-08-01T14:48:00-04:00
  checked: integration with a concurrent PM2 stop-exit-code circuit-breaker change
  found: stop_exit_codes was removed from ecosystem.config.js, but incompatible DAEMON_EXIT_LOCK_CONFLICT logic remains in src/daemon/index.ts, src/cli/ecosystem.ts, and its focused test; an escalated removal attempt was policy-rejected
  implication: the primary investigator must remove those remnants before live verification because stopping PM2 on the first competitor can strand the service after the orphan self-fences

- timestamp: 2026-08-01T14:43:35-04:00
  checked: repeated live PM2 PID-file ownership sabotage after the bounded-exit correction
  found: old daemon pid 29736 self-fenced in 6229ms, PM2 published replacement pid 18704 at 24308ms, all 13 enabled agents returned with PID-safe ownership, saved/live manifests matched, and canonical health was HEALTHY
  implication: the exact orphan-ownership state now self-recovers automatically without a manual daemon kill

- timestamp: 2026-08-01T14:48:10-04:00
  checked: final validation on commits 8806dbf8 and a9f05769
  found: typecheck and production build pass; an earlier full suite passed 2346 tests, the final full rerun passed 2345 tests with one unrelated concurrent-cron timeout, and that timed-out test passed alone in 6.33s
  implication: no reproducible regression remains and the live recovery evidence directly exercises the new failure path
## Resolution

root_cause: PM2 restart bookkeeping raced its forced termination callback, orphaning the newly spawned daemon pid 27016 while PM2 believed that generation had exited; the orphan retained the fresh fenced instance lock and IPC, later had all 13 agents drained by stop --all, and blocked more than 1100 PM2 respawns as duplicates
fix: added a dedicated 2-second PM2 pid-file ownership fence with a 3-failure threshold; supervisor-loss exits now record crash evidence, skip unbounded synchronous PTY teardown, release control-plane ownership promptly, and rely on the replacement daemon's PID-safe startup reconciliation; all active and template guidance now requires cortextos restart --daemon --instance default instead of direct PM2 restart
verification: direct PM2 restart converged without orphaning; repeated PID-file sabotage forced the old daemon out in 6229ms and produced a healthy replacement at 24308ms; all 13 agents healthy; PM2 saved/live manifests aligned; PM2 Resurrect ready; typecheck/build clean; full suite passed once and the sole load-timeout on final rerun passed in isolation
files_changed: [src/daemon/index.ts, tests/unit/daemon/daemon-instance-lock.test.ts, templates/agent/.claude/skills/agent-management/SKILL.md, templates/agent/.claude/skills/env-management/SKILL.md, templates/analyst/.claude/skills/agent-management/SKILL.md, templates/analyst/.claude/skills/env-management/SKILL.md, templates/orchestrator/.claude/skills/agent-management/SKILL.md, templates/orchestrator/.claude/skills/env-management/SKILL.md, templates/agent-codex/plugins/cortextos-agent-skills/skills/agent-management/SKILL.md, templates/agent-codex/plugins/cortextos-agent-skills/skills/env-management/SKILL.md, templates/agent-opencode/plugins/cortextos-agent-skills/skills/agent-management/SKILL.md, templates/agent-opencode/plugins/cortextos-agent-skills/skills/env-management/SKILL.md, orgs/SEB_company/agents/codex_runner/plugins/cortextos-agent-skills/skills/agent-management/SKILL.md, orgs/SEB_company/agents/codex_runner/plugins/cortextos-agent-skills/skills/env-management/SKILL.md, orgs/SEB_company/agents/builder_1/MEMORY.md]
