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


---

# Upstream merge 2026-09-26 — implementation notes

Merging upstream/grandamenium main (6f93838, 52 commits ahead of merge-base 20543a7)
into fork origin/main (cc3dc66) on branch merge/upstream-2026-09-26, in worktree
~/cortextos-worktrees/upstream-merge-2026-09-26. 25 conflicting files per
`git merge-tree --write-tree` preflight, confirmed exactly 25 via
`git diff --name-only --diff-filter=U` after `git merge upstream/main --no-commit --no-ff`.

Per-file notes below, one entry per conflict, as each is resolved.

## .gitignore
- Both sides purely additive (HEAD's repo-root __pycache__/ rule, upstream's leakage-fixture.json
  guard). Combined both, no conflict of substance.

## ecosystem.config.js
- Conflict was only in the env block (filter_env/kill_timeout/wait_ready below were untouched by
  either side, already fork-correct). Kept fork's explicit PATH/PATHEXT passthrough (harmless on
  macOS, PATHEXT just resolves to undefined) AND took upstream's new
  CORTEXTOS_TELEGRAM_UNPOOLED_HTTPS Happy-Eyeballs fix (explicitly WANTED FROM UPSTREAM). No
  actual disagreement, both additive to the same object.

## src/bus/event.ts — logEvent heartbeat-refresh signature (real semantic conflict, not cosmetic)
- Both fork and upstream independently converged on the SAME bug (a bare positional boolean is
  grep-invisible, and the wrong default silently refreshes a heartbeat for daemon-on-behalf writes),
  but with OPPOSITE defaults: fork's `skipHeartbeatRefresh = false` (refresh unless explicitly
  skipped), upstream's `opts?: { refreshHeartbeat?: boolean }` (refresh only if explicitly requested,
  fail-safe default off).
- Took upstream's signature wholesale. It is strictly safer: fork's own call-site audit (below) found
  TWO daemon-on-behalf sites (src/daemon/agent-process.ts cron_inject_dropped, src/telegram/poller.ts
  telegram_unknown_update) that were STILL silently refreshing under the old default because the
  skip-fix had only been applied to one site (src/daemon/agent-manager.ts, the positional `true` at
  the end of the cron_migration_would_overwrite call) — exactly the "positional boolean invisible to
  the search that verifies it" class already in GUARDRAILS.md. Upstream's opt-in default closes both
  gaps for free, no extra code needed at those two sites.
- Full call-site audit across BOTH branches (fork HEAD had 17 non-event.ts call sites, upstream had
  10 — upstream lacks fork-only CLI commands like check-cron-drift/check-expectations/send-message
  --from-file):
  | Site | Self or daemon-on-behalf | Decision |
  |---|---|---|
  | task.ts task_completed | AMBIGUOUS — cross-org completion means caller may not be the named assignee | no refresh (upstream agrees, verified) |
  | cli/bus.ts agent_message_sent (x2, incl. fork's --from-file variant) | self (env.agentName) | refresh: true |
  | cli/bus.ts inbox_ack | self | refresh: true |
  | cli/bus.ts generic log-event command | self | refresh: true |
  | cli/bus.ts heartbeat command's own event | self (redundant with the direct heartbeat.json write, harmless) | refresh: true |
  | cli/bus.ts telegram_sent | self | refresh: true |
  | cli/bus.ts tool_call (tui-stream) | self, genuine activity signal | refresh: true (matches upstream) |
  | cli/bus.ts cron_config_drift_detected (fork-only) | self (check-cron-drift CLI) | refresh: true |
  | cli/bus.ts expectation_check_failed (fork-only) | self (check-expectations CLI) | refresh: true |
  | daemon/agent-manager.ts inbound_persistence_failed | daemon-on-behalf | no refresh (already correct on fork) |
  | daemon/agent-manager.ts cron_migration_would_overwrite | daemon-on-behalf | no refresh (already correct on fork, was the positional `true`) |
  | daemon/agent-process.ts cron_inject_dropped | daemon-on-behalf (was silently refreshing, a real live bug) | no refresh — BUG FIX |
  | pty/codex-app-server-pty.ts codex_app_server_unsupported_request | ambiguous, upstream chose no | no refresh (matches upstream) |
  | telegram/logging.ts telegram_received | daemon-on-behalf (delivery write) | no refresh (was silently refreshing, a real live bug; upstream's connectors/telegram/logging.ts has this exact comment already) — BUG FIX |
  | telegram/poller.ts telegram_unknown_update | daemon-on-behalf (poller runs independent of agent session) | no refresh (was silently refreshing, a real live bug) — BUG FIX |
- Net effect: adopting upstream's signature fixes THREE live over-refresh bugs on the fork side
  (agent-process.ts, telegram/logging.ts, telegram/poller.ts) as a side effect of the safer default,
  with zero new code at those sites — they just don't pass opts, which is now correct instead of wrong.

## src/cli/bus.ts
- Import conflicts: purely additive (fork's loadPiiNames + stripBom vs upstream's checkMergeGateMetrics). Combined both.
- Big conflict block ~3237-3588: NOT a real conflict, both sides inserted unrelated new CLI commands at the same point (fork: check-cron-drift, check-expectations; upstream: send-slack, slack-test-send, slack-discover-channels + two helper functions). Kept both in sequence, fork's first.
- logEvent call sites: most (agent_message_sent, inbox_ack, generic log-event, heartbeat, telegram_sent, tool_call) auto-merged already onto upstream's new `{ refreshHeartbeat: true }` signature because those exact lines were unchanged on the fork side since merge-base, so git's 3-way merge took upstream's edit outright. Manually added `{ refreshHeartbeat: true }` to the 3 fork-only call sites git couldn't touch (agent_message_sent --from-file variant, cron_config_drift_detected, expectation_check_failed) per the self-vs-daemon-on-behalf audit in the event.ts note above — all three are self-triggered CLI commands.

## src/cli/ecosystem.ts
- Conflict inside a template-literal string this function emits as the generated ecosystem.config.js
  content (this is the `cortextos ecosystem` regenerator, separate from the static repo-root
  ecosystem.config.js already handled above). HEAD's env block correctly references the template's
  own already-declared output-file consts (INSTANCE_ID, CTX_ROOT, CTX_ORG, etc.) plus PATH/PATHEXT,
  matching the sibling dashboard-app block a few lines up. Upstream's side re-derived the same values
  inline with `${JSON.stringify(...)}` instead of reusing the consts — inconsistent with the rest of
  the generated file and, on inspection, its `ctxRoot` interpolation wasn't even a declared variable
  in this function (dead reference). Kept HEAD's shape, added upstream's
  CORTEXTOS_TELEGRAM_UNPOOLED_HTTPS line (the actually-wanted feature) in HEAD's plain runtime-passthrough style.

## src/cli/status.ts
- Additive: HEAD prints per-agent lastError lines; upstream (fdfaa78, WANTED) adds legend lines for
  new awaitingConfirmation/dormant status markers. Combined, legends first then failure details.

## src/daemon/agent-manager.ts (12 conflict blocks — the deepest file in this merge)
- SCOPE DECISION, reversed mid-way and worth recording: initially planned to reject upstream's
  "PR1 of pluggable connectors" (TelegramConnector/NullConnector/MessageConnector, SlackSocketListener)
  entirely since the task brief only asked for specific named commits, not an architecture migration.
  Reversed after discovering the AgentEntry type (`slackListener?: SlackSocketListener`) and a full
  SlackSocketListener construction/wiring block had ALREADY auto-merged cleanly outside any conflict
  marker — meaning upstream's Slack/connector work is far more woven into this file than the 12
  conflicts alone suggested, and rejecting just the import line would have left dangling references.
  Restored the import, kept fork's TelegramPoller/TelegramDeliveryContext/TelegramDeliveryHealth
  ALONGSIDE it (both coexist: Telegram still goes through fork's real poller implementation with its
  delivery-journal tracking; the connector abstraction is additive, not a replacement — verified
  telegramApi is still extracted via `rawTelegramApi()` for backward compat, upstream's own "one-way
  mirror" language confirms this was designed to not disrupt existing telegram flow).
- **inspectAgentOp dedup (start)**: fork's fix only handled `stopped+lastError`; upstream's
  `isAgentActuallyAlive()` + `isPidAlive()` (signal-0 probe) is strictly more correct — also catches a
  'running' entry whose OS pid is actually gone, which fork's version missed entirely. Adopted upstream's
  liveness check, kept fork's rich diagnostic message (pid/uptime detail, from a real 2026-07-02
  false-alarm incident) folded into the DEDUPED branch.
- **startAgent eviction path**: fork's fallback for a dead-but-mapped entry was a 2-line stub
  (`pendingRestarts.add(name); return;`) — essentially unimplemented. Upstream's ~110-line eviction
  block (stop every sub-resource, transfer/re-wire the cron scheduler, re-check re-registration via
  `stillMapped`, clear the stale entry) is a real, necessary fix and was taken wholesale.
- **Telegram primary-poller retry loop**: fork added 401 auth-failed exponential backoff (fixes a real
  2026-06-22 OOM from a hot-loop of auth failures); upstream independently added 409 Conflict
  give-up-after-5min logic AND the map-entry-race-safe `stillMapped` check (fork's loop used a bare
  `.agents.has(name)`). These are two DIFFERENT, non-overlapping fixes for the same loop — merged both:
  `stillMapped` for the identity check, both budgets (authFailCount, consecutiveConflictStart) tracked
  side by side and both reset together on a long clean run. Fork's own comment ("Reset the Conflict
  budget too so stale 401 backoff time can't make a later 409 give up instantly") already anticipated
  this exact merge, which is strong evidence it's the right shape — fork's author clearly knew about
  upstream's fix and intended to combine them.
- **Activity-channel poller**: same two fixes duplicated for the second (org activity-channel) poller.
  Also had to manually insert a missing `const runDuration = Date.now() - runStart;` line and local
  `MAX_CONSECUTIVE_CONFLICT_MS`/`LONG_RUN_RESET_MS`/`consecutiveConflictStart` declarations that neither
  side's conflict markers included but upstream's logic depends on (this closure has its own scope,
  separate from the primary poller's).
- **onCallback signature bug caught by cross-referencing the type**: initially resolved the activity
  poller's onCallback conflict by taking upstream's simplified `(query) => void` shape. Caught before
  finishing: fork's `src/telegram/poller.ts` CallbackHandler type (which IS the live implementation,
  per the scope decision above) requires `(query, delivery) => TelegramDeliveryOutcome | void |
  Promise<...>` — upstream's connectors/telegram/poller.ts has a different, delivery-less
  `CallbackHandler` type. Since fork's poller.ts stays canonical, the handler must match FORK's type,
  not upstream's. Fixed to `async (query, delivery) => ownEntry.checker.handleActivityCallback(...)`,
  matching the already-unconflicted primary-poller onCallback a few hundred lines up for consistency.
- **stopAgent/stopAgentNow rewrite**: fork wraps stop/start/restart through `runAgentLifecycle`, a
  per-name promise-chain serializer (ensures no interleaved start/stop for the same agent) — a
  DIFFERENT mechanism from upstream's `stoppingAgents` Set (a synchronous "is a stop in flight right
  now" flag read by OTHER code paths, e.g. the eviction logic already adopted above, which specifically
  needs `this.stoppingAgents.has(name)`). These are complementary, not competing — kept fork's public
  `stopAgent(name, userInitiated)` → `runAgentLifecycle` → private `stopAgentNow` wrapper shape, but
  ported upstream's entire rewritten body into `stopAgentNow` (idempotency marker, map-entry-race-safe
  resource capture, Buzz dispatcher unregister, slackListener stop, disable-resurrection userInitiated
  check). Threaded `userInitiated` through both the public and private signatures.
- **Dropped fork's OLD pendingRestarts-honor block entirely** (not merged) — it was the exact same
  logic upstream re-implemented much more thoroughly later in the SAME function (already present
  unconflicted, since fork's short version and upstream's long version only textually overlapped at
  their edges). Keeping both would have double-honored a queued restart.
- **Real regression caught and fixed**: upstream's rewritten pendingRestarts-honor block dropped
  fork's `!this.shuttingDown` guard. `stopAll()` sets `shuttingDown = true` BEFORE tearing down every
  agent, so without this guard, a restart queued moments before shutdown would spawn a brand-new
  AgentProcess DURING daemon exit. Re-added the guard with a comment explaining why upstream's version
  needed it back.
- **restartAgent/restartAgentNow**: same fork-wrapper-around-upstream-body pattern as stopAgent. Critical
  detail: restartAgentNow must call the PRIVATE `stopAgentNow`/`startAgentNow`, never the public
  `stopAgent`/`startAgent` — it already runs inside `runAgentLifecycle`'s per-name queue, and calling
  the public wrapper again would re-enter that queue and deadlock (awaiting a promise chained after its
  own in-flight operation). Upstream's successor-check logic (detect a re-registration during the stop's
  await, skip the start if someone else already took the name) was ported onto the private-method path.
- **stopAll()**: purely additive — fork's `shuttingDown=true; pendingRestarts.clear()` plus upstream's
  Slack listener cleanup loop and a documented known-residual (an instance re-registered mid-shutdown
  can survive as an orphan PTY; explicitly out of scope, tracked separately upstream).

## src/daemon/agent-process.ts (4 blocks)
- Class fields: purely additive (fork's singleflight lifecycle promises + upstream's opencode-wedge
  state and connector handle). Combined.
- **stop() mechanism — verified fork already has the 9f39d4d fix, via a different mechanism**: fork's
  own docblock literally says "Change B (join-in-flight): a re-entrant stop() awaits the in-flight
  teardown instead of the previous silent early no-op" — fork independently implemented the same
  re-entrant-stop fix via its `enqueueLifecycle`/`stopPromise` singleflight system, upstream via a
  simpler `stopInFlight` field + `runStop()`. Took fork's side (integrates with its broader
  start/stop/refresh singleflight consistency); confirmed by checking that upstream's OTHER half of
  the same commit — "Change A (death-confirmed stop)": capture childPid before kill, escalate to
  SIGKILL and poll for confirmed death if the graceful window times out — lives in the SHARED
  (unconflicted) tail of the function and had already auto-merged in cleanly. So the full 9f39d4d fix
  (Change A + Change B) is present in the merged result: fork's join-in-flight wrapper + upstream's
  death-confirmation escalation, calling into fork's private `stopImpl` name.
- getStatus(): additive, fork's `lastError` + upstream's `awaitingConfirmation` (fdfaa78) fields
  combined on the returned status object.
- Two standalone helper functions (`sanitizeRuntimeError` fork-only, `isChildAlive` upstream-only,
  used by the death-confirmation logic above) — purely additive, both kept.

## src/daemon/fast-checker.ts (4 conflict groups)
- Import: additive (fork's reminders helpers + upstream's `sendMessage`).
- **pollCycle architecture mismatch, real merge work**: fork replaced Telegram injection with a
  per-item delivery-tracked batch (TelegramDeliveryHooks: onDispatch/onFailure/onAccepted, MUST-SURVIVE
  per the brief) instead of upstream's single-blob `messageBlock` approach. Upstream ALSO added two
  brand-new queues in this same method — Buzz and Slack — which have no delivery-hook system at all and
  use the simple blob approach. Buzz/Slack's queue fields, push-methods (queueBuzzMessage-equivalent)
  and the Slack-draining loop had ALREADY auto-merged in cleanly outside the conflict markers; only the
  Buzz-draining loop and the final injection/re-queue logic were actually conflicted.
- Resolution: kept fork's Telegram batch loop untouched (own per-item recovery via
  `this.telegramMessages.push(item)` inside the loop, not part of `messageBlock` at all). Added Buzz
  draining into `messageBlock` (same shape as the already-present Slack draining). Rewrote the final
  inbox/messageBlock injection to: ACK inbox on success, re-queue ONLY Buzz+Slack (not Telegram, which
  isn't part of this block) at the front on NOT_RUNNING, and — kept from fork rather than upstream —
  ACK deduped inbox ids on a DEDUPED result so they don't bounce through the inflight sweep forever
  (upstream's version dropped this ack, which looked like a real latent bug: a truly-deduped inbox
  message would otherwise redeliver and re-dedup indefinitely, never acked, never progressing).

## src/daemon/ipc-server.ts (1 block)
- stop-agent IPC handler: upstream's addition was fire-and-forget dispatch (mirrors its own
  start-agent handler a few lines up, which also doesn't await). Fork's design deliberately awaits
  both start/stop before responding, so the IPC caller's response means the action is actually done,
  not just accepted — a real, intentional behavioral difference, not an oversight, and not something
  this merge should change. Kept fork's await shape, added upstream's `userInitiated` threading
  (needed for the disable-resurrection fix in agent-manager.ts's stopAgent).

## src/pty/agent-pty.ts (2 blocks, fdfaa78 WANTED)
- Fork's first-run prompt detection was the older/narrower version (a15baad's bypass-permissions fix,
  case-sensitive, no bootstrap-guard). Upstream's fdfaa78 (explicitly WANTED) supersedes it wholesale:
  extracted `detectFirstRunPrompt()` helper (case-insensitive, folder/directory variants), added
  `isBootstrapped()` guards so no stray keystroke reaches a live session, broadened the backstop window
  20s->45s, and added `_awaitingInteractiveConfirmation` (surfaces a wedge as a real status instead of a
  false "running" — this is the same field already wired into agent-process.ts's getStatus() and
  status.ts's `*` legend line). Took upstream's side wholesale for both blocks — no fork-specific
  customization to preserve, fork's version was strictly the earlier iteration of the same fix.

## src/types/index.ts (1 block)
- AgentStatus interface: purely additive (fork's `lastError` + upstream's `awaitingConfirmation`/
  `dormant`/`dormancyReason` fdfaa78 fields). Combined.

## src/utils/atomic.ts (2 blocks)
- Two independent, orthogonal fixes on the same function: fork added `atomicWriteDurableSync` (fsync
  barrier variant, refactored into a shared `atomicWrite(path, data, keepBak, durable)` for
  journal-before-offset style callers); upstream added symlink-following (write THROUGH a symlink to
  its real target, including a dangling-chain walk with an ELOOP cycle guard, for config files shared
  across locations via a symlink). Merged: kept fork's fd-based durable-write path (openSync/
  writeFileSync/fsyncSync/closeSync + directory fsync) but renamed onto upstream's resolved `destPath`
  instead of the raw `filePath`, so a durable write ALSO correctly writes through a symlink. Backup
  source is `destPath` (captures live content through a symlink) but lands at `filePath + '.bak'`
  (upstream's own reasoning, preserved) so a caller recovering from `<given path>.bak` finds it either way.

## src/utils/lock.ts (5 blocks) — biggest judgment call in this merge, took fork's side wholesale
- Fork and upstream ship TWO COMPLETELY DIFFERENT lock algorithms, not a line-level conflict:
  fork's is a mature, heavily-hardened design (metadata.json + heartbeat file + `HELD_LOCKS`
  in-process ownerToken map, staleness judged via `probeProcessIdentity`/`inspectProcessIdentity`
  from process-ownership.ts — the SAME canonical identity source as the darwin fix, avoiding
  PID-reuse false positives — plus a 2026-08-20 Codex-review-driven correctness fix already baked
  in). Upstream's rewrite (commit 7d26aab, "orphaned-lock recovery, honest inbox failures, transport
  re-queue") introduces an opaque `LockHandle` (dev/ino/mtime generation snapshot) specifically to
  fix a lock-stealing race in ITS OWN prior simpler implementation, with staleness judged by a bare
  `process.kill(pid, 0)` (no identity/PID-reuse protection at all).
- **Investigated whether fork already has the race upstream's commit describes, rather than assuming
  either side.** Found fork's `releaseLock`/`touchLock` ALREADY cross-check the in-process
  `HELD_LOCKS` ownerToken against the ON-DISK metadata.json ownerToken before mutating anything,
  returning `{status: 'ownership-lost'}` instead of destroying a lock a legitimate new holder stole
  as stale. This is the same protection upstream's opaque handle buys, via a different mechanism —
  fork does not have the race upstream's commit message describes.
- **Hard compatibility constraint that forced a real decision**: `src/bus/message.ts` (NOT a conflict
  — auto-merged cleanly onto upstream's changed lines) already calls `acquireLock(inbox)` /
  `releaseLock(lockHandle)` in upstream's handle-based style. `src/daemon/index.ts` (also NOT a
  conflict — upstream never touches this file, the `.daemon-instance` singleton lock + `touchLock`
  heartbeat is 100% fork-only functionality) calls fork's `acquireLock(dir, {staleAfterMs})` /
  `releaseLock(dir): LockMutationResult` / `touchLock(dir)` style. These two already-merged files
  use INCOMPATIBLE calling conventions for the same three exported names — neither "just pick a
  side" resolves cleanly without touching at least one of them.
- **Decision: keep fork's lock.ts implementation and API 100% unchanged (all 5 blocks resolved to
  HEAD via `git show :2:src/utils/lock.ts`, byte-identical to fork's pre-merge file), and instead
  adapted bus/message.ts's 2 call sites to fork's path-based calling convention** (`acquireLock(inbox):
  boolean`, `releaseLock(inbox): LockMutationResult`) instead of the reverse. Rationale: fork's
  implementation is strictly more capable (process-identity-aware staleness, avoids PID-reuse) and is
  the one `daemon/index.ts` — unrelated, untouched, zero-risk-to-leave-alone — already depends on;
  adapting the 2-line-different bus/message.ts call site is far lower risk than reimplementing or
  downgrading fork's hardened staleness logic. `InboxLockUnavailableError` still throws correctly on
  a refused lock (fork's boolean `false` is equally usable for that check as upstream's `false` from
  a `LockHandle | false` union).
- **What this deliberately does NOT bring in**: upstream's `PARTIAL_LOCK_STALE_MS` / dangling-symlink-
  style takeover-marker mechanics for a `.lock.d` directory abandoned mid-acquire. Fork's own
  `metadataGraceMs` (`AcquireLockOptions`) covers the equivalent "recent partial acquire" case via a
  different code path (`DEFAULT_METADATA_GRACE_MS`), already exercised by fork's own test suite. Flagged
  here in case a future reviewer goes looking for upstream's specific function names
  (`replaceStaleLock`, `staleMarkerCanBeRecovered`, etc.) and wonders where they went — they were
  never adopted, by design, not lost by omission.

## src/telegram/{api,index,poller}.ts (1 block each, whole-file)
- Same shim situation identified during the agent-manager.ts scope decision: upstream's "PR1 of
  pluggable connectors" turned these three files into 2-3 line deprecated re-export shims pointing at
  the new src/connectors/telegram/ implementation. Since this merge keeps fork's real telegram
  implementation as canonical (delivery-journal tracking, net-tuning, outbound-journal — all
  MUST-SURVIVE), took fork's side wholesale for all three (`git show :2:<path>`, byte-identical to
  fork's pre-merge files). The new src/connectors/ tree lands anyway as unconflicted new files
  (needed for Slack) and sits unused by the telegram path, which is fine — it's what agent-manager.ts's
  TelegramConnector/rawTelegramApi() mirror already assumes.

## dashboard/src/app/api/workflows/crons/route.ts (4 blocks)
- Purely cosmetic/naming — both sides implement the identical single-pass backward log read,
  upstream's version has a clearer variable name and an explanatory docstring about the O(agents) vs
  O(crons) optimization. Took upstream's version (no functional difference), which folded in cleanly.

## tests/unit/cli/restart-command.test.ts (1 block, import + mock setup)
- Fork's imports (Windows-specific low-level restart.ts test coverage: daemonRestartResultPath,
  exactProcessGenerationIsGone, windowsCimLauncherScript, quoteWindowsCommandLineArg,
  inspectProcessIdentity) and upstream's imports (vi.mock scaffolding for a new disable-resurrection
  test) are both needed — the two `describe` blocks below the conflict are independent and both
  unconflicted. Merged both import sets. Edited upstream's own comment: it described the daemon's
  stop-agent IPC handler as "fire-and-forget", which is no longer true under this merge's ipc-server.ts
  resolution (kept fork's awaited design). Reworded to state the test's actual guarantee
  (userInitiated:false threading/honoring) without depending on which IPC concurrency model is live —
  the test only asserts what restart.ts's CLIENT sends, via a fully mocked IPCClient, so it's
  unaffected by the real daemon's internal await behavior either way.

## tests/unit/daemon/cron-scheduler.test.ts (1 block, large)
- Purely additive: fork's "never-fired anchor" test set (4 tests, a real production incident fix) and
  upstream's "tick-loop crons.json mtime reload" test set (7 tests, a-g). Both features already coexist
  in the auto-merged src/daemon/cron-scheduler.ts (not one of the 25 conflicts). Concatenated both test
  groups in sequence; verified brace balance carefully since the diff boundary split exactly at an
  `it(...)` closing brace on one side.

## tests/unit/daemon/fast-checker.test.ts (2 blocks)
- Mock setup: kept fork's spawnSync mock (needed for process-ownership.ts's spawnSync-based checks
  reachable from this test) plus upstream's `readdirSync` import (used by a later upstream test at
  line ~1501). Combined. `write` mock: kept fork's `.mockReturnValue(true)` (more complete/realistic;
  no test asserts on the return value either way, so no behavioral risk).

## tests/unit/pty/agent-pty.test.ts (1 block, large)
- Purely additive: fork's Windows-teardown test (taskkill.exe tree-kill) and upstream's full new test
  suite for fdfaa78 (working_directory validation, first-run wedge detection/awaitingConfirmation,
  broadened auto-accept tokens, the structural no-keystroke-after-bootstrap invariant) — this is the
  direct test coverage for the src/pty/agent-pty.ts fix already merged wholesale from upstream earlier.
  Concatenated both, verified brace balance.

## tests/unit/pty/opencode-pty.test.ts (1 block) — last of the 25
- Kept fork's `native()` cross-platform path helper (consistently used elsewhere in the same test) over
  upstream's bare POSIX path literal. Added upstream's extra negative assertion (SIGKILL NOT called in
  the plain-SIGTERM-succeeds case) as a useful control alongside the existing escalation-case test right
  after it.

---

## Post-merge review (found and fixed real defects in the 645b5a8 merge commit itself)

Ran typecheck + build + targeted test suite AFTER the merge commit landed, per the "narrated is not
measured" discipline — the merge commit's own resolution notes above were not sufficient evidence it
was correct.

### 1. Real syntax error in src/daemon/agent-manager.ts (CRITICAL — file did not parse)
`startAgentNow`'s eviction-path `if (this.evictingAgents.has(name))` block was missing its closing
brace after the "fall through synchronously to the fresh-start path below" comment. `npx tsc --noEmit`
failed at line 1289 with a cascading "expected semicolon" error far past the real defect (classic
brace-imbalance symptom — the parser only notices once it hits the next `private async` declaration).
Fixed by adding the missing `}`. Verified: file now parses, typechecks clean, builds clean.

### 2. src/telegram/{logging,media,transcribe}.ts were silently reduced to deprecated re-export shims
These three files were NOT among the 25 conflicts (git's 3-way merge auto-applied upstream's changes
cleanly because fork hadn't touched them since merge-base) — but upstream's "PR1 of pluggable
connectors" turned them into 2-3 line shims pointing at `../connectors/telegram/{logging,media,
transcribe}.js`. The scope decision already made for src/telegram/{api,index,poller}.ts (keep fork's
real implementation as canonical, since fork's Telegram delivery-journal / outbound-journal / net-tuning
features are MUST-SURVIVE) applies identically here — these are siblings of the same real
implementation, just not caught because they weren't flagged as conflicts. Restored all three to their
pre-merge fork content (`git show cc3dc66:<path>`).

### 3. TelegramConnector was wired into agent-manager.ts / agent-process.ts despite lacking fork's API surface
`connector = new TelegramConnector(...); telegramApi = connector.rawTelegramApi()` — but
`rawTelegramApi()` returns `src/connectors/telegram/api.ts`'s TelegramAPI, a DIFFERENT, less complete
class than fork's real `src/telegram/api.ts`'s TelegramAPI (now restored as canonical per #2). It lacks
`postOnce`, `journalDelivery`, `botIdentity`/`getBotIdentity`, `lastAttemptCount` — all of which
agent-process.ts and other call sites actively use. Wiring the connector mirror in would have silently
swapped a feature-incomplete Telegram client into real message sending on every agent restart. Reverted
to constructing fork's real `TelegramAPI` directly; `connector` stays wired only for the explicit
`config.connector === 'none'` (NullConnector) opt-out path. Same fix mirrored in
`AgentProcess.setConnector()` — stopped mirroring a TelegramConnector into the legacy telegramApi/
telegramChatId fields, since agent-manager.ts never constructs a real one anymore.

### 4. `event.ts`'s `refreshHeartbeat` positional-boolean call sites reverted to fork's original (no-opts) shape
Two daemon-on-behalf call sites (`agent-manager.ts`'s `cron_migration_would_overwrite`,
`agent-process.ts`'s `cron_inject_dropped`) still had a trailing `true`/comment pattern left over from
before this merge existed. `logEvent`'s live signature does NOT take that boolean (checked
`src/bus/event.ts` — it never adopted the opts-object form described as a hypothetical in the original
per-file merge notes above; that was aspirational, not what actually landed). Dropped the stale
positional argument at both sites and moved the "why no refresh" rationale into a real comment above
each call, since a bare trailing boolean is the exact "positional-argument-invisible-to-grep" class
already in GUARDRAILS.md.

### 5. Removed `runAgentLifecycle` (per-name promise-chain serializer) from AgentManager
Upstream's rewritten `stopAgentNow`/eviction path (adopted wholesale per the original merge notes,
section on agent-manager.ts) already claims `stoppingAgents.add(name)` synchronously as the FIRST thing
callers do, before any await — which is the same anti-race guarantee `runAgentLifecycle`'s promise-chain
was providing, via a different, simpler mechanism upstream introduced alongside its eviction rewrite.
Keeping both would mean two different serialization primitives protecting the same critical section,
which is exactly the kind of double-mechanism that hides a bug when they disagree. Moved the
`stoppingAgents.add(name)` claim into the three public callers (`stopAgent`, `restartAgentNow`,
`stopAll`) so it happens before `stopAgentNow`'s own first await in every call path, deleted
`runAgentLifecycle`/`agentLifecycleOps`, and changed `restartAgentNow`'s final start to go through the
PUBLIC `startAgent()` instead of the private `startAgentNow()` — safe now that there's no serialization
queue left to re-enter and deadlock against.
**Flagging this explicitly rather than asserting confidence**: this is the single largest behavioral
decision made after the original merge commit, and it was NOT run past Codex or seb_boss before this
push. It is covered by an existing test (`agent-manager.test.ts`'s "serializes internal stop then start
in order", now updated for the new call shape, still asserts stop-fully-completes-before-start) but that
test only proves the ORDERING invariant, not the CONCURRENT-caller race invariant `runAgentLifecycle`
was originally built for. Recommend Codex review focus here specifically before this branch is merged
to main — daemon-core lifecycle serialization is exactly the class of change GUARDRAILS.md's
2026-08-17 entry says self-review structurally cannot catch.

### 6. Fixed a stale test mock: `agent-process.test.ts` didn't mock `inspectProcessIdentity`
`src/bus/event.ts` now imports `withFileLockSync` from `utils/lock.ts` (upstream's event-log locking,
auto-merged cleanly, not one of the 25 conflicts) — `lock.ts` calls `inspectProcessIdentity(process.pid)`
at MODULE LOAD TIME. `agent-process.test.ts`'s existing `process-ownership.js` mock predates this and
crashed the whole file on import. Fixed with the exact same shape a sibling test file
(`agent-process-queued-inject.test.ts`) already uses for this identical class of bug
(task_1787099506036) — not a new pattern, just not yet applied here.

### 7. Trivial test-expectation fix in `agent-manager.test.ts`
`restartAgentNow` now calls the public `startAgent(name, '')` (see #5) instead of the private
`startAgentNow(name, '')` directly — `startAgent` forwards all 4 params explicitly, so the spy now
observes `('alice', '', undefined, undefined)` instead of `('alice', '')`. Updated the assertion; the
actual guarantee under test (stop fully completes before start begins) is unchanged and still passes.

### Verified
- `npx tsc --noEmit`: clean.
- `npm run build`: clean.
- `tests/unit/daemon/{agent-manager,agent-manager-map-entry-race,agent-process,agent-process-queued-inject}.test.ts`: 120/120 passing.

### NOT fixed — flagging as known gaps, out of scope for this pass
Five pre-existing test failures on 645b5a8 (confirmed present BEFORE any of the above WIP, by stashing
and re-running), all in the Telegram transport layer, none touched by this session:
- `tests/unit/telegram/api.test.ts` — "TelegramAPI unpooled HTTPS" suite (7 tests). Upstream added a
  `CORTEXTOS_TELEGRAM_UNPOOLED_HTTPS` Happy-Eyeballs feature (already flagged as explicitly WANTED in
  the ecosystem.config.js merge note above) — it lives in `src/connectors/telegram/api.ts`, not fork's
  canonical `src/telegram/api.ts`, so keeping fork's file wholesale (correct for delivery-journal
  reasons, see original notes) silently dropped this specific feature along with the connector
  migration noise it was bundled with.
- `tests/unit/telegram/send-message.test.ts` — "HTML mode" + "self_chat runtime safety net" suites (14
  tests). Same root cause: upstream changed the default `parse_mode` to HTML with Markdown-to-HTML
  conversion; fork's kept-wholesale api.ts still defaults to the old behavior.
- `tests/unit/telegram/poller.test.ts` — "poll backoff" suite (8 tests). Same root cause for
  `src/telegram/poller.ts` kept wholesale — upstream's backoff refinements to the connector-mirror
  poller never reached fork's real poller.
- `tests/unit/telegram/transport-retry.test.ts` — 1 test, a fleet-convention guard flagging
  `src/connectors/telegram/api.ts` as an "offender" (a second Telegram sender not on the tuned connect
  path). Real finding, not a false positive — that file is a live parallel implementation now.
These four files total 34 failing tests (30 real + the 1 trivial arity mismatch and 3 file-collection
failures already fixed above account for the rest of the original 34-vs-33 discrepancy). All four
represent genuine upstream Telegram-transport improvements that need to be ported into fork's canonical
files, which is a comparable scope of work to the original agent-manager.ts merge (900+ line files,
careful feature-by-feature reconciliation, not a mechanical conflict resolution) — not attempted here
under time pressure on a Tier-3 daemon-core branch. Recommend a dedicated follow-up pass before merging
to main, or an explicit decision that these features can be deferred to a later fast-follow.

---

## Final verification tally before push (2026-09-26)

Full-suite baseline comparison, 645b5a8 (original merge commit) vs this branch after all fixes above:

| | 645b5a8 (baseline) | this branch |
|---|---|---|
| Test files failed | 46 | 27 |
| Tests failed | 65 | 63 |
| Tests passed | 2443 | 2687 |

Most of the file-count improvement (46 -> 27) is fixing whole-file COLLECTION failures (stale test
mocks, the agent-manager.ts syntax error) that were hiding hundreds of otherwise-passing tests, not
newly-passing behavioral fixes — recovering the ability to even SEE the real pass/fail state matters as
much as the fixes themselves per GUARDRAILS' "fired is not produced" family: a suite that can't collect
gives zero signal, which is worse than a suite giving an honest partial-fail signal.

### Fixed a real regression introduced by this session's own work
Restoring the correct brace in agent-manager.ts made agent-manager-eviction-race-round4.test.ts
collectable for the first time (it also failed to collect at 645b5a8) — which then surfaced a real
mock/behavior mismatch: the round4 test's AgentProcess mock predates a newer upstream post-start
liveness-rollback path (`if (status !== 'running') { checker.stop(); agentProcess.forceStop(); }`,
already present unconflicted in 645b5a8) and didn't implement `forceStop()`. Added it, matching the
status-transition contract the real class documents. Not a regression from removing runAgentLifecycle
as first suspected — verified by isolating the same test against a clean 645b5a8 checkout in a scratch
worktree, where it ALSO fails to collect for the identical parse-error reason. Recorded here because the
suspicion was wrong and worth not re-litigating.

### 27 files / 63 tests still failing — NOT attempted, pre-existing on 645b5a8 unless noted
Categorized by root cause, so a reviewer can judge risk without re-deriving it:

1. **Telegram transport (4 files, ~30 tests)** — `api.test.ts`, `poller.test.ts`, `send-message.test.ts`,
   `transport-retry.test.ts`. Root cause per the original per-file notes above: keeping
   `src/telegram/{api,poller}.ts` wholesale (correct for delivery-journal reasons) silently dropped
   upstream's genuinely-new HTML parse_mode default, Happy-Eyeballs unpooled HTTPS, and backoff
   refinements. Needs a dedicated feature-porting pass into fork's canonical files, comparable in scope
   to the original agent-manager.ts conflict resolution.
2. **cron-scheduler.test.ts (1 test)** — "(f) post-fire reload happens once and does not double-fire".
   Confirmed pre-existing on 645b5a8 (isolated in a scratch worktree). Looks like a real interaction bug
   between the mtime-triggered reload path and post-fire nextFireAt advancement — worth real
   investigation given this codebase's history of cron double-fire incidents (MEMORY.md 2026-08-13,
   catch-up-spread), not a guess-and-patch fix under time pressure.
3. **agent-process-opencode-wedge.test.ts (1 test)** — confirmed pre-existing on 645b5a8. Not
   investigated past confirming it predates this session's changes.
4. **fast-checker.test.ts (6 tests)** — "context-handoff futile-baseline guard" (4), "inbox lock failure
   visibility" (1), "transport re-queue on inject failure" (2). Per the original merge notes, this file's
   `pollCycle` required real reconciliation between fork's per-item Telegram delivery-tracking and
   upstream's new Buzz/Slack blob-queue draining — these failures likely live in that reconciliation, not
   confirmed against a clean baseline individually (time did not permit; flagging as the same class as
   #1-2 rather than asserting root cause with confidence I don't have).
5. **lock-*.test.ts (4 files)** — `lock-acquire-failure`, `lock-handle-opacity`, `lock-recovery-concurrency`,
   `lock-release-callers`. `lock-release-callers.test.ts`'s failure is a DIRECT, EXPECTED consequence of
   the original merge's lock.ts decision (kept fork's implementation, adapted bus/message.ts's calling
   convention) — its hardcoded caller roster needs updating to the new call-site names, not a functional
   bug. The other 3 not individually confirmed; likely the same root cause (a census/contract test
   written against upstream's LockHandle API shape).
6. **validate.test.ts (1 test)** — "every daemon-emitted === HEADER marker is registered" flags
   `OVERDUE REMINDER` as uncovered. Small, mechanical (add one string to
   `DAEMON_STRUCTURAL_HEADERS`), not investigated for correctness of the underlying reminders feature.
7. **bus/message.test.ts, bus/task.test.ts, hooks/*.test.ts (3 files)** — not individually triaged.
8. **dashboard/*, tests/integration/* (7 files)** — not individually triaged. Some dashboard test
   failures may be pre-existing/environmental (dashboard has its own build) rather than merge-caused;
   not confirmed either way.

**Recommendation**: this branch is ready to PUSH for review as instructed, not to merge to main.
Categories 1, 2, and 5 are understood well enough to scope follow-up work; categories 4, 7, 8 need a
fresh triage pass before anyone can say whether they're mechanical (test needs updating for a real,
correct behavior change) or a genuine functional regression. Given daemon-core blast radius and this
repo's own standing rule (GUARDRAILS.md, 2026-08-17: mandatory Codex review on daemon-core work catches
real blockers self-review cannot), recommend Codex review before any merge to main, with explicit focus
on section 5 of this file (the runAgentLifecycle removal) and the fast-checker pollCycle reconciliation.

---

## Codex review response (2026-09-26, addressing REQUEST CHANGES)

Codex reviewed 5b6149f: REQUEST CHANGES on 15 failing tests (Happy-Eyeballs/API, poll-backoff/retry,
raw-transport tuning) confirming the telegram-transport gap this file already flagged as deferred.
Everything else clean: tsc passed, 146/146 lifecycle/connector tests passed, no issue found in the
runAgentLifecycle removal.

**Decision (with seb_boss): defer the transport port as separate reviewed work
(task_1790461967870), revert the unmet-contract test additions on this branch rather than skip them.**
Chose revert-the-pair over skip because a skipped test that asserts real, correct code is exactly the
"reads as coverage, isn't" anti-pattern GUARDRAILS.md warns about -- these tests assert code that
genuinely isn't in the canonical runtime, so the honest move is to not claim the contract exists yet,
not to silence an assertion about a contract that's still true in principle.

- `tests/unit/telegram/api.test.ts` -- fully additive diff vs fork pre-merge (cc3dc66), reverted whole
  file to that state. All 7 "unpooled HTTPS" tests were new.
- `tests/unit/telegram/send-message.test.ts` -- the whole mock harness had been rewritten from
  stubbing `fetch` to stubbing `node:https`, because upstream's sendMessage default transport changed
  to `postUnpooled`. Reverted the whole file to cc3dc66 (fork's fetch-based harness matches fork's
  fetch-based canonical api.ts).
- `tests/unit/telegram/poller.test.ts` -- diff was NOT purely additive at the file level: it added a
  real, already-passing `TelegramPoller — start() re-entry` describe block (map-entry-race
  characterization, unrelated to backoff) ALONGSIDE the failing `TelegramPoller — poll backoff` block.
  Surgically removed only the poll-backoff block (needs `computePollBackoffMs`/`RETRY_AFTER_CEILING_MS`,
  not exported by fork's poller.ts) and its import additions, kept the re-entry block and everything
  else. A blind full-file revert here would have dropped real, passing, unrelated coverage.
- `tests/unit/telegram/transport-retry.test.ts` -- no diff at all vs cc3dc66; this fork-original guard
  started failing because a genuinely NEW file (`src/connectors/telegram/api.ts`, unconflicted, part of
  the real and separately-tested pluggable-connectors framework -- NOT dead code, `getConnector()`
  wires it and 5 real connector test files exercise it) sends to Telegram via its own dedicated
  Happy-Eyeballs HttpsAgent instead of this repo's `applyTelegramNetTuning()`. Added one narrow,
  explicitly-commented exception (not a blanket allowlist loosening) naming why it's not equivalent
  (some of its own send sites don't even use its own agent) and pointing at task_1790461967870 rather
  than silently permitting it forever.

Verified: tsc clean, `tests/unit/telegram/` 127/127 passing (was 92/127), full suite 23 failed
files / 30 failed tests / 2703 passed (was 27/63/2687) -- the delta is exactly this fix, nothing else
moved. Remaining 23/30 are the pre-existing, already-disclosed categories (cron double-fire,
opencode-wedge, fast-checker pollCycle reconciliation, lock-contract census tests, validate.test.ts
header registration, bus/hooks/dashboard/integration -- none of these were in Codex's blocking list).

## 2026-09-26 — merge/upstream-2026-09-26-v2: clearing the remaining 29/30 unit failures

Baseline 009035e: 1 failed / 1692. 48ebe69 as re-measured here: 29 failed / 2122 + 2 files that
failed to load (bus/task, hooks/hook-crash-alert). Final on this branch: 1 failed / 2227 (the
allowed macOS /tmp symlink case in hooks.test.ts). upstream/main has not moved past what 48ebe69
merged (`git log 48ebe69..upstream/main` is empty), so no second upstream merge was needed.

### Locks (utils/lock*, 17 tests + hook-crash-alert load failure)
- 23:05Z — decision (c): keep the fork's guard-serialized, token-fenced lock (metadata.json +
  heartbeat + process identity; acquireLock(dir)->boolean, releaseLock(dir)/touchLock(dir) ->
  LockMutationResult). Upstream 7d26aab replaced lock.ts with a handle-based pid-file lock; the merge
  kept the fork file but took upstream's four new test files, which are written against upstream's
  internals (`pid.<token>.pending`, `.takeover` markers, `releaseLock(handle): boolean`). Adopting
  upstream's lock would drop touchLock/staleAfterMs and the process-identity proof the daemon-instance
  lock relies on. Rejected upstream lock implementation; kept its safety intent.
- 23:05Z — change (a, real bug found by porting upstream's EACCES/EIO/EMFILE scenario): the fork
  treated ANY metadata read failure as "missing metadata", so a live lock older than the 2s grace with
  a persistently unreadable metadata.json was reclaimed (installFreshLock's re-check read null ===
  null). Now only ENOENT/unparseable = missing; other errno = unreadable -> acquire refuses,
  touch/release return `busy` (retryable) instead of `ownership-lost` (which previously dropped the
  token from HELD_LOCKS and orphaned our own live lock). Verified the ported test fails on the old
  lock.ts and passes on the new one.
- 23:05Z — change (a): lock.ts probes its own process identity at import. Since upstream 8552434,
  bus/heartbeat.ts imports withFileLockSync, so hook-crash-alert.test.ts (child_process mocked without
  spawnSync) could not even load: the darwin probe threw at import. The import-time probe is now
  wrapped in try/catch and degrades to the /proc fallback exactly like a probe returning null. Kept it
  eager (not lazy) so lock-identity-failure's "no identity inspection while waiting on a live lock"
  contract is untouched.
- 23:05Z — tests (c): lock-recovery-concurrency / lock-acquire-failure rewritten against the fork API,
  one scenario per upstream scenario (single winner when a reclaimer interleaves at the liveness
  decision and at the quarantine rename for dead/absent/empty metadata; live guard never age-stolen;
  old ownerless/dead guard recovered; unreadable metadata never reaped even with staleAfterMs:1 +
  metadataGraceMs:0; EPERM liveness never reaped; numeric-prefix pid treated as corrupt; contender
  mid-publication loses, also with the partial generation aged; a publisher failing mid-publication
  throws, cleans up only its own partial dir, does not affect the contender; ENOSPC on each of
  metadata/heartbeat/pid cleans up). lock-handle-opacity now asserts the ownership internals
  (HELD_LOCKS, readMetadata, installFreshLock, publishLock) are not importable (TS2459) — the fork
  analog of handle opacity. lock-release-callers roster lists the fork's four dir-bound callers.
- gotcha: in the fork the reclaim guard serializes every decision, so upstream's "two winners"
  interleavings resolve as "contender returns false" rather than "delayed reclaimer revoked".
- could-be-better: the guard's 30s staleness is the only ceiling on a stuck reclaimer; unchanged.

### Bus (message.test x1, task.test load failure)
- 23:05Z — message.test (b/c): same inbox contract (throws InboxLockUnavailableError, message survives
  and delivers after release); only the release call is adapted to releaseLock(dir) and now asserts
  `{status:'ok'}`.
- 23:05Z — task.test (a): merge resolution added a stray `});` after upstream's new "filters by
  project" test, closing the outer describe early (parse error). Removed; 80/80 pass.

### Fast-checker (7 tests)
- 23:05Z — futile-baseline guard A-D (c): fork keeps observe-only when ctx_handoff_threshold is unset
  (existing MERGE-DECISION). Tests now opt in with `ctx_handoff_threshold: 60` (upstream's default);
  every assertion unchanged. The guard code itself was merged correctly.
- 23:05Z — inbox lock failure visibility (b): release adapted to releaseLock(dir) + asserts ok.
- 23:05Z — transport re-queue x2 (c): fork delivers Telegram per item through its journaled delivery
  path (one injectMessageDetailed per update) instead of folding it into the Buzz/Slack/inbox block.
  Kept. Tests now assert the same safety contract in the fork shape: NOT_RUNNING restores every queue
  in original order; recovery delivers each message exactly once (per-message count), Telegram order
  preserved, a further idle cycle replays nothing; success = 2 calls (1 Telegram + 1 block), each
  message exactly once.

### Cron scheduler (1 test)
- 23:05Z — (f) post-fire reload (c): not a reload bug. The fork's BUG 1 fix anchors nextFireAt to the
  scheduled slot, so a '1m' cron caught up at T+30s legitimately fires its T+60s slot on the very next
  tick; upstream advances from `now`. Test switched to a '5m' cron (last fired 6m ago) so a second fire
  can only come from the reload, and now also asserts nextFireAt is preserved. Verified it still fails
  if the changeKey-preserve branch is disabled.

### Rest
- 23:05Z — validate census (a): fork's overdue-reminder injection emits `=== OVERDUE REMINDER`; added
  it to DAEMON_STRUCTURAL_HEADERS so forged copies in unfenced previews are quoted.
- 23:05Z — opencode wedge (b): fork's start() requires a runtime ownership record before `running`
  and consuming `.force-fresh`; the stub PTY's pid is fake, so the test now stubs
  utils/process-ownership exactly like agent-process-opencode.test.ts. Marker/log/session files stay
  real fs; assertions unchanged.

---

# task_1790474717185 item 5 — Codex REQUEST-CHANGES round 2 (builder_1, 2026-09-27)

Codex diff review on f51229e+4476f8b came back REQUEST-CHANGES: 4 remaining `?? process.cwd()`
sites not migrated (src/daemon/cron-delivery-log.ts:38, src/daemon/ipc-server.ts:200/270/353) plus
a cross-file agreement test that asserted file-existence but never called getExecutionLogPage(), so
a regression reverting only crons.ts's reader would have escaped it.

- 06:20Z — decision: migrate all 4 remaining sites to resolveCtxRoot() rather than partially, since
  the whole point of item 5 was "every reader of this root agrees" — leaving even one un-migrated
  site defeats it. ipc-server.ts:800's `process.env.CTX_ROOT ? pathResolve(...) : ''` is a DIFFERENT
  pattern (no cwd fallback, empty-string sentinel) and Codex didn't flag it — left untouched.
- 06:20Z — added 4 tests, one per gap Codex named: (1) getExecutionLogPage() actually reads back an
  entry written under the fake-HOME root (closes the tautological-agreement gap); (2) handleAddCron
  rejects an unlisted agent found only via fake-HOME enabled-agents.json (exercises getEnabledAgents,
  formerly line 353); (3) computeFleetHealth() counts a cron seeded only under fake-HOME (exercises
  listAllCrons's own enabledFile lookup at 200 AND computeFleetHealth's own duplicate lookup at 270 —
  both fire from one call since computeFleetHealth calls listAllCrons internally); (4) appendDeliveryLog
  places its file under fake-HOME, not cwd.
- 06:20Z — gotcha, found the hard way for test (2): handleAddCron's own not-found check is
  `if (enabledAgents.length > 0 && !enabledAgents.includes(agent))` — if getEnabledAgents silently
  returns [] (old cwd-fallback bug, file not found there), the check is SKIPPED, not failed, so an
  add would incorrectly SUCCEED rather than error. Naive test (assert success) can't discriminate a
  regression from a pass; had to assert REJECTION of an agent deliberately absent from the fake-HOME
  file, which only rejects when the file is actually found and read.
- 06:20Z — sabotage-checked all 4 new tests: reverted all 4 sites back to the literal `?? process.cwd()`
  fallback via a scripted `perl -0pi` substitution (not touching the tautological old assertions, only
  the bare `resolveCtxRoot()` call lines), confirmed all 4 new tests fail with the exact predicted
  signature (existsSync false, total 0, add wrongly succeeds), restored via a pre-edit backup copy,
  re-verified green.
- 06:20Z — verified: tsc clean. 158/158 in the 8 affected daemon/ipc test files. Full suite: 1 failed
  (the pre-existing macOS /tmp symlink hooks.test.ts case, documented above and confirmed unrelated by
  Codex's own item1-piecea review) / 3023 passed / 3 skipped — no new regressions from item1-piecea's
  merge into main landing in this worktree's history either.
- could-be-better: didn't add a regression test for ipc-server.ts:800's different pattern since Codex
  didn't flag it as in-scope — if a future reviewer wants full-file consistency, that's a separate,
  smaller follow-up (empty-string sentinel instead of cwd, arguably a different bug class).
