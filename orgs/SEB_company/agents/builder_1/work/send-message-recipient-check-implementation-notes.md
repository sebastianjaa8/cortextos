# task_1785720898226 — send-message rejects unknown recipients

- 22:4xZ — decision: fix belongs inside cli/bus.ts's two command handlers (send-message,
  send-message-file), not inside src/bus/message.ts's sendMessage(). sendMessage() only receives
  BusPaths (ctxRoot-scoped runtime state), not the project/framework root the agent-registry check
  needs (orgs/*/agents/<name> lives under a DIFFERENT root, CTX_FRAMEWORK_ROOT, than ctxRoot).
  Extending BusPaths to carry frameworkRoot would touch every BusPaths construction site fleet-wide
  for one check used by exactly two callers — stayed at the smaller, correct scope.
- 22:4xZ — found and reused `agentExistsInFramework()` (src/cli/bus.ts, already existed, already
  used by add-cron to reject an unknown agent with exit 1) instead of writing a new checker. The
  `send-message` command had its OWN separate 20-line inline duplicate of the identical directory
  walk, just to print a warning and continue instead of rejecting — deleted the duplicate, called
  the shared function, matched add-cron's existing exit-1 pattern exactly.
- 22:4xZ — decision: `send-message-file` had ZERO check at all (not even the warn-and-continue the
  plain command had). Same fix applied there too — one check, two call sites, matching the task's
  own "fix upstream, not at each call site" instruction as closely as two independent CLI action
  handlers allow (message.ts itself was the "more upstream" option and was ruled out above).
- 22:5xZ — GUARDRAIL 104 applied immediately (written earlier this same session): grepped for
  existing formal test coverage of both commands BEFORE writing anything. Found
  tests/unit/cli/send-message-file.test.ts already pins 3 specific failure-ordering behaviors
  (missing-file / empty-file / bad-priority, each with a message that must NOT contain the other
  cases' substrings). Read it fully before placing the new check, so the check landed AFTER those
  three (right before the sendMessage() call) instead of before — same recipient name ('someagent')
  those tests already use, so if I'd checked agent-existence first, all three would have broken by
  masking their real assertion behind an unrelated "agent not found" error.
- 22:5xZ — mutation-check: wrote the 4 new tests first, ran them against the code AS FOUND
  (git stash), confirmed exactly the 2 must-fail cases went red (unknown recipient — expected
  nonzero exit did not happen) while the 2 paired-negative cases (real recipient) stayed green
  either way — the correct signature. Restored the fix, all 4 green.
- 22:5xZ — must-fail case adopted seb_boss's STRONGER version from the task text: not just "exits
  nonzero" but "inbox/<name> MUST NOT EXIST afterward" — a directory that gets created even on a
  rejected send is self-healing in the wrong direction (a typo's second attempt finds the dir
  already there and looks legitimate). Both new tests assert `existsSync(paths.inbox) === false`
  after a rejected send, not just the exit code.
- 22:5xZ — env-leak gotcha while writing the tests: the test process inherits THIS LIVE SESSION's
  real CTX_AGENT_DIR (builder_1's actual agent dir). Overriding only CTX_FRAMEWORK_ROOT to a scratch
  dir tripped resolveEnv()'s own sandbox/live-leak guard ("Resolved CTX_AGENT_DIR ... is not under
  CTX_FRAMEWORK_ROOT ... Refusing to proceed") — a real safety check firing correctly, not a bug.
  Fixed by explicitly clearing CTX_AGENT_DIR + CTX_PROJECT_ROOT for the test's duration, restored in
  afterEach.
- 22:5xZ — ran tests/unit/cli (132/132) and the full tests/unit (1617/1625, 8 failures across 3
  unrelated files — process-ownership.test.ts / lock.test.ts / status-ownership.test.ts, PID/process-
  spawn timing tests). Applied the stash-test-isolate pattern before trusting "unrelated": ran those
  3 files in isolation against clean HEAD (23/23 pass) and again with the fix applied (23/23 pass) —
  same load-dependent flakiness either way, confirmed not caused by this diff. Consistent with this
  session's earlier finding (RAM pressure / fork failures, analyst's open root-cause task) — not
  chased further, not my lane tonight.
- gotcha: mid-session process error — I initially edited src/cli/bus.ts directly in the SHARED
  framework checkout (C:/Users/Sebas/cortextos) instead of a worktree, violating GUARDRAIL 102 from
  earlier the same session (git checkout -b on a shared checkout moves everyone's HEAD; this was the
  same-shaped hazard one layer down — a DIRTY shared src/ tree, exactly what guard-arm-check's
  UNVERIFIABLE-BUNDLE / dirtySrc leg watches for). Caught it via `git status` before any commit, no
  daemon build ran on the dirty tree in between (CLI reads dist/, not src/, so nothing live was
  affected), captured the diff to a patch file, restored the shared checkout to clean, replayed the
  patch inside a proper worktree. No damage, but worth a durable note: I have my own established
  worktree discipline and skipped it once under the pace of picking up a second task mid-heartbeat.
- NOT DONE, deliberately: not merging to main, not touching dist/. This is core src/cli code shared
  fleet-wide (`send-message` is how every agent reports to every other agent, including me to
  seb_boss all night). Held on branch builder_1/send-message-recipient-check (worktree
  ../cortextos-worktrees/builder_1-send-message-recipient-check) for seb_boss review before landing,
  same discipline as the daemon fix earlier this session — lower blast radius than that one (CLI-only,
  no daemon restart needed, a fresh `cortextos bus send-message` picks up a rebuild immediately once
  merged and built) but still a fleet-wide comms path, not a unilateral land.
