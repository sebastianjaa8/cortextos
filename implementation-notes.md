# task_1785666339329 — bus/task.ts audit attribution + project/due parity (builder_1, 2026-09-27)

- 10:30Z — decision: narrowed the 7-week-old ticket after reading current source. Half was
  already fixed since filing (empty-desc refusal, from_assignee/to_assignee, claim-lock
  reassign-refusal, --desc-file). Full description before/after text explicitly excluded —
  that's a separately-owned, deferred decision (descFingerprint's own doc comment, seb_boss
  2026-08-03), not a gap this fix should silently reopen.
- 10:32Z — Codex plan review round 1: REQUEST-CHANGES, 5 real points (fallback exact-match for
  empty-string assignee, soften description-scope wording to deferred-not-rejected, due_date
  nullability, CLI-level tests required not just library-level, explicit statement on
  task-history formatting + the separate activity-feed logEvent call). All 5 addressed in
  PLAN.md REVISION 1. Round 2 confirmation review: GO, 5/5 confirmed.
- 10:50Z — change: `updateTask` gets an additive `callerAgent?: string` in its existing `opts`
  object (not a breaking positional param) — avoids touching ~35 existing direct-call test sites
  that pass opts positionally by shape. `completeTask` gets an additive optional 5th positional
  param (no opts object to extend there). Both fall back to `assignee || 'unknown'` exactly as
  before when omitted — every existing 3/4-arg call site is unaffected.
- 10:51Z — gotcha, caught by Codex round 1: `callerAgent ?? assignee ?? 'unknown'` is NOT the
  same as `callerAgent ?? (assignee || 'unknown')` when `assignee === ''` (empty string is a
  real, reachable value via the reassign path). Used the parenthesized OR form to preserve old
  behavior exactly.
- 10:53Z — change: `from_project`/`to_project` and `from_due`/`to_due` added to `TaskAuditEntry`,
  same conditional-inclusion pattern as the existing priority/assignee/title pairs. `due_date` is
  nullable on Task (`string | null`), so `from_due` is typed `string | null` and the FIRST
  deadline a task ever gets correctly records `from_due: null` (a real prior state) rather than
  omitting the field.
- 10:54Z — CLI wiring: both call sites in src/cli/bus.ts already had `env.agentName` resolved
  (via `resolveEnv()`) but never passed it to updateTask/completeTask — that's the actual
  production defect, not just a library-level gap. Threaded through as `callerAgent: env.agentName`
  / a 5th positional arg.
- 10:56Z — sabotage-checked all 3 mechanisms independently: (1) reverted both `agent:` audit
  lines back to `assignee || 'unknown'` — confirmed the 2 new attribution tests fail with the
  exact predicted wrong value, restored, re-verified green. (2) Removed the project/due
  conditional-inclusion blocks entirely — confirmed the 3 positive tests (project change,
  first-due-null, ordinary due change) fail, the 4 negative/no-op tests correctly cannot
  discriminate this mutation (expected — they prove absence-of-emission, not presence), restored.
  (3) Reverted ONLY the CLI call sites (bus.ts) back to omitting callerAgent, rebuilt dist/cli.js,
  confirmed the 2 new CLI-level integration tests fail — proving they exercise the actual CLI
  wiring, not just the library fallback (Codex's round-1 concern #4). Restored, rebuilt, re-verified.
- 10:57Z — gotcha: `resolvePaths()` (src/utils/paths.ts) resolves `ctxRoot` from `homedir()` +
  `CTX_INSTANCE_ID`, NOT from a `CTX_ROOT` env var — the existing sibling test
  (complete-task-graceful-error.test.ts) sets `CTX_ROOT` in its spawned env but that value is
  never actually read for path resolution; that test just happens to pass anyway because its
  assertions are all about a NONEXISTENT task's error message, which never needed real isolation.
  My new CLI-level test needed a REAL created task with a REAL audit log to read back, so used a
  unique `CTX_INSTANCE_ID` per test instead (which IS honored by `resolveEnv()`), and cleans up
  the real `~/.cortextos/<instanceId>` directory it creates in `afterEach`.
- 10:58Z — verified: tsc clean. tests/unit/bus/task.test.ts 92/92 (was 76 pre-existing + 16 new).
  Plus duplicate-detection.test.ts + lifecycle.test.ts + the new CLI integration test = 120/120
  combined. Full repo suite: 1 failed (the pre-existing, already-documented macOS /tmp symlink
  case in hooks.test.ts) / 3063 passed / 3 skipped — re-ran twice; a `cron-scheduler.test.ts`
  failure appeared on ONE run under full-parallel load but passed clean in isolation and on a
  second full run, matching this repo's own already-tracked flake (task_1786592962516,
  "vitest parallel-worker contention is the branch-consolidation flake") — not caused by this
  change, not chased further.
- could-be-better: `task-history`'s FORMATTED (human-readable) output does not render the new
  project/due audit pairs, only the JSON audit log carries them — deliberately out of scope per
  the plan (title/priority already have this gap partially, this doesn't widen or close it).
  Flagging in case a future pass wants full parity there.
