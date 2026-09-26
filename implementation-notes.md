# Fix: evaluate-experiment --score clobbering measured value

task_1790461063876 (root-cause fix for task_1790208385830, filed by vault_keeper 2026-09-23).

- 21:14Z — decision: root-cause the discriminator problem rather than gate the override on
  `experiment.metric_type`, because a fleet-wide survey (`find ... experiments/*.json`, 51 real
  records) showed metric_type is NEVER actually persisted on an individual Experiment record — it
  only exists on `ExperimentCycle` (config.json templates), and `findCycleDefaults()` doesn't even
  forward it. The reported experiment (exp_1789376458_padgm) had no cycle at all. Gating on a field
  that's structurally never populated would have "fixed" nothing.
- 21:14Z — decision: removed the score-override entirely rather than adding a flag/heuristic to
  distinguish "0 is real" from "0 is a placeholder" — no CLI-argument-only signal can make that
  distinction (the reported bug's real measured value WAS 0). Root cause is the confusing
  two-argument convention itself (`<id> 0 --score 7`), not a missing conditional.
- 21:14Z — change: `--score` is no longer a value substitute. It's folded into `learning` as
  `Score: N/10` and left alone otherwise. Callers reporting a qualitative score now pass it as the
  positional `<value>` directly (`evaluate-experiment <id> 7 --justification "..."`).
- 21:14Z — found while fixing: score was ALSO never surfaced in `learning` before this fix, even in
  the override path — a --score justification was recorded, but the numeric score itself was
  silently dropped once it had done its (destructive) job of overwriting result_value. Now preserved.
- 21:14Z — swept all 6 template/community copies of autoresearch's SKILL.md (templates/{agent,
  analyst,orchestrator}, templates/agent-{codex,opencode}/plugins/.../skills/autoresearch,
  community/skills/autoresearch) rather than just the one referenced in the bug report — same
  wording verified identical across all 6 before a scripted replace, per GUARDRAILS' "sweep the set
  the fact lives in." Individual agents' live `.claude/skills/autoresearch/SKILL.md` under `orgs/`
  are gitignored and NOT touched here — each agent picks up the template fix on its own SKILL.md sync.
- 21:14Z — added 2 regression tests to tests/sprint3-experiments.test.ts: one pinning the exact
  reported bug shape (real measured 0 + --score 9 must not clobber), one pinning that score becomes
  a learning annotation, not a value. 29/29 passing (27 pre-existing + 2 new). typecheck + build clean.
- 21:14Z — did NOT touch the historical exp_1789376458_padgm.json record itself (already completed,
  wrong baseline_value=9/result_value=9/decision=keep persisted under vault_keeper's own experiment
  history) -- per GUARDRAILS "never bulk-fix memory files or records", a record is what was believed
  at the time; fixing the code prevents recurrence, correcting old data (if wanted) is vault_keeper's
  call on its own experiment history, not mine to silently rewrite.
- could-be-better: no schema-level way currently exists to tag an individual Experiment as
  quantitative vs qualitative at all (only cycles have it). Not adding one now -- out of scope for a
  Tier-2 bug fix, and the removed-override design no longer needs it. Flagging in case a future
  qualitative-experiment feature wants it.
