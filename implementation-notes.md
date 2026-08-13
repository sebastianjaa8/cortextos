# task_1785766275354 — daemon catch-up re-anchor spread

- 20:4xZ — decision: fix at the catch-up clamp only (`nextFireAt <= now -> nextFireAt = now`), not
  in fallbackAnchorMs or advanceNextFireAt. That's the exact mechanism the task diagnosed (all overdue
  interval crons across all agents converge on the literal daemon-restart `now`), and it's the smallest
  surface that fixes it without touching the anchor semantics the 2026-08-01 never-fired-anchor fix
  already depends on.
- 20:4xZ — decision: deterministic hash-based offset (`agentName|cronName` -> mod CATCHUP_SPREAD_MS),
  not random. Random would jitter on every reload and break the existing "reload preserves nextFireAt
  for unchanged crons" contract the scheduler relies on. Hash gives the same offset every restart,
  forever, with no state to lose.
- 20:4xZ — decision: CATCHUP_SPREAD_MS = 5 minutes. Matches the observed real-world clustering window
  (:58-:03) from the 2026-08-01 incident closely enough to break it, stays well under 10% of the
  shortest fleet interval (2h heartbeat), so it reads as "prompt with jitter" not "delayed."
- 20:5xZ — gotcha: this offset legitimately changes catch-up timing, which broke 7 pre-existing tests
  that advanced fake timers by exactly TICK (30s) after seeding an overdue cron and expected an
  immediate fire. Not a false failure — the OLD assertion encoded "clamps to exactly now," which is
  precisely the behavior being removed. Fixed by advancing through CATCHUP_SPREAD_MS + TICK in each,
  with a comment pointing at this task. Exported CATCHUP_SPREAD_MS from the module so tests reference
  the real constant instead of a magic number that could drift from the implementation.
- 20:5xZ — verification method: wrote the must-fail case FIRST (two schedulers, different agentName,
  same overdue cron) and ran it against unmodified src/daemon/cron-scheduler.ts to confirm it actually
  went red (nextA === nextB, 1786582038740 === 1786582038740) before writing the fix. Per this fleet's
  own mutation-check discipline (GUARDRAILS.md #97-99) — a test that was never proven capable of
  failing is not evidence.
- 20:5xZ — discriminating pair included: a NOT-yet-due cron must be completely unaffected (exact grid,
  no offset) — proves the fix only touches the catch-up branch, not every nextFireAt computation.
- 20:5xZ — paired negative included per task spec ("must not delay a lone agent"): single cron/single
  agent catch-up still fires within the bound, not skipped a cycle.
- tradeoff: did NOT touch src/daemon/agent-manager.ts or cron-drift.ts even though they both import
  from this module — grepped both, neither reads nextFireAt/catch-up internals, only nextFireFromCron
  (unrelated, cron-expression-only, unaffected). Scope stayed to the one file the bug lives in.
- NOT DONE, and deliberately: no `npm run build`, no daemon restart. This is core src/daemon on the
  SHARED framework checkout — per TG9823's own sequencing warning, building alone without a
  coordinated restart converts one exit-2 into a different one (STALE-DAEMON), and a pm2 restart drops
  13 live sessions. That is Sebastian/seb_boss's call, same class as the TG9823 gate this task itself
  waited behind. Held on a branch (builder_1/daemon-catchup-spread) in an isolated worktree
  (../cortextos-worktrees/builder_1-daemon-catchup-spread, per GUARDRAIL 102 — never `git checkout -b`
  on the shared framework checkout) for seb_boss review before any build/merge/restart.
- could-be-better: the 5-minute spread is a flat bound, not scaled to fleet size. With 15 agents it
  spreads fine; if the fleet grows to 100+ agents sharing 2h heartbeats, 5 minutes might not be enough
  buckets to avoid re-collision at the 30s tick granularity. Not a problem at current scale — flagged
  for whoever revisits this if the fleet grows an order of magnitude.

- 21:1xZ — CHANGE, and a real one: ran the broader integration suite before calling this done
  (tests/unit/daemon + phase5-performance + phase5-* + multi-agent-crons + agent-bootstrap-crons).
  26 of 666 tests failed, ALL in tests/integration/phase5-performance.test.ts (Subtask 5.4's formal
  performance contract: P-2 fire-latency <60000ms, P-5 100-crons-one-agent <30s, SC-2 scaling-cliff
  baseline). All three failing specs are SOLO-agent/solo-scheduler scenarios — exactly the paired
  negative task_1785766275354 itself demanded ("the offset must not delay a lone agent"). A
  CronScheduler instance has no way to know whether it's alone or one of 15 — an identity hash can't
  distinguish those cases, so it necessarily delays the lone-agent case it's required not to.
- 21:1xZ — decision: did NOT shrink CATCHUP_SPREAD_MS to fit under the 60s P-2 threshold. A spread that
  narrow wouldn't meaningfully de-cluster the fleet (TICK_INTERVAL is 30s, so a 60s window is only ~2
  tick-slots) — weaker than the ~5min spread the fleet ALREADY has naturally from restart jitter, which
  was already not enough to prevent the RAM spike. Shrinking the number to pass the test would have
  shipped a fix that doesn't fix anything.
- 21:1xZ — decision: did NOT silently rewrite the phase5-performance.test.ts thresholds either. Read the
  file header: it's a formally labeled "Subtask 5.4" performance contract (P-1 through P-6, SC-1 through
  SC-4), not an incidental assertion — same class of thing as the 7 unit tests I DID update, except this
  one encodes a documented product guarantee, not an implementation-detail assumption. Changing it is a
  "what does this fleet promise" call, not mine to make solo — same discipline as never landing Tier-3
  work unilaterally.
- 21:1xZ — the real fix: grepped `new CronScheduler` and found exactly one call site,
  src/daemon/agent-manager.ts ~line 1394, inside one AgentManager class holding one
  `cronSchedulers: Map<string, CronScheduler>` for the whole daemon process. That map's size AT
  CONSTRUCTION TIME is a real, already-available, in-process sibling count — no new cross-process
  coordination needed to fix this properly. The offset should be INDEX-based (assigned by
  agent-manager.ts from cronSchedulers.size, evenly spaced across CATCHUP_SPREAD_MS), not
  identity-hash-based inside cron-scheduler.ts alone. A lone scheduler gets index 0 => offset 0 =>
  P-2/P-5/SC-2 stay exactly as documented; N schedulers in one boot get spread evenly.
- 21:1xZ — filed task_1786582693524 (assigned normal priority, unassigned pending a decision) with the
  full finding and recommendation, and set task_1785766275354 back to blocked on it — per GUARDRAIL 103
  (a correction/decision that needs to reach the next reader is a task, not just a memory entry). Did
  NOT mark task_1785766275354 complete: the code on this branch is real diagnostic + prototype value
  (root cause fully confirmed, must-fail proof, working single-file spread mechanism) but it is not
  mergeable as-is — it fails its own project's formal performance contract for the exact case the
  original task said not to break.
- gotcha caught while filing the task: passed the description via a plain double-quoted bash string
  containing a literal backtick (`cronSchedulers: Map`) — bash read it as command substitution, silently
  swallowed the clause to an empty string (`cronSchedulers:` isn't a command, errored to stderr, $()
  still substitutes ""). Re-verified by reading the task back before trusting it looked right (per this
  fleet's own "no verdict from uncertain reads" discipline), found the gap, refiled via `update-task
  ... --desc "$(cat <<'EOF' ... EOF)"` (heredoc, no backtick risk). Consistent with the fleet's own
  documented "QUOTING/ESCAPING LAYERS EAT MATCHERS" lesson (2026-08-01/02) — just hit on a create-task
  call instead of a grep.
