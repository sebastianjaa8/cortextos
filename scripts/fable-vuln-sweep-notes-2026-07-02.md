# Fable vuln sweep — implementation notes (2026-07-02)

Scope: bus/daemon/cli internals, PTY injection pathway, cron dispatch reliability, secrets hygiene.
Branch: build/cron-effectiveness-audit. Sebastian ask: "find the other vulnerabilities... don't miss any messages."

## Findings + decisions (timestamped as worked)

- 05:0xZ — survey: src/pty/inject.ts, bus/message.ts, utils/lock.ts, utils/atomic.ts,
  daemon/cron-scheduler.ts, daemon/agent-process.ts, daemon/agent-manager.ts,
  daemon/fast-checker.ts, telegram/poller.ts, pty/output-buffer.ts, pty/redact.ts,
  utils/env.ts, bus/crons.ts. Codebase is heavily iterated (BUG-011/032/040/043/048,
  iter 7-12 cron fixes) — most classic races already closed.

- FINDING 1 (fixed): fast-checker pollCycle DROPS queued Telegram messages when
  injection fails. shift() removes them from this.telegramMessages, builds messageBlock,
  and if agent.injectMessage() returns false (NOT_RUNNING during sessionRefresh /
  crash-recovery window, or DEDUPED) the batch is gone forever. Inbox messages survive
  (inflight recovery after 5 min) but Telegram messages have no recovery path.
  Trigger: any Telegram message arriving during a session refresh (~10-25s window,
  fires on every session-time-cap rollover + context handoff) — fast-checker keeps
  polling during sessionRefresh because only stopAgent() stops the checker.
  Fix: requeue batch at queue front on NOT_RUNNING; drop only on DEDUPED (already
  injected once). Unbounded requeue accepted — messages are precious, memory cost tiny.

- FINDING 2 (fixed): MessageDedup poisoning = permanent message loss after a failed
  submit. injectMessageDetailed records the dedup hash BEFORE the async Enter lands.
  If Enter verifiably fails (PTY torn down mid-delay, or verify loop exhausts retries
  with 0 output — the exact 2026-07-01/02 Enter-swallow class), the content hash stays
  in the dedup window, so a RE-SEND of the identical message is silently DEDUPED.
  Fix: InjectVerify.onFailed callback + MessageDedup.forget(content); agent-process
  wires onFailed → dedup.forget. Tradeoff: at-least-once over at-most-once — if the
  wide retry window false-negatives (turn started but output lagged), a re-send could
  double-deliver. Duplicate delivery is benign vs silent loss.

- FINDING 3 (fixed): BOM-unsafe .env token readers — the KNOWN 2026-05-16 incident
  class (BOM breaks /^BOT_TOKEN=/m for line-1 keys), fixed in agent-manager:335 but
  NOT in 7 sibling sites. seb_boss/.env IS BOM'd with BOT_TOKEN on line 1 today, so:
  - daemon/index.ts getOperatorChatCreds (crash-loop operator alert from 9c9c4b3,
    LAST NIGHT's fix) skips seb_boss and falls through to whichever non-BOM agent
    .env it finds first (atlas/chef bots) — alert lands on the wrong bot or nowhere.
  - agent-manager.ts:828 activity-token collision check silently misses BOM'd .envs.
  - cli/bus.ts x5 (send-telegram / hard-restart fallback token reads) — masked today
    only because process.env.BOT_TOKEN is set inside agent PTYs (parseEnvFile strips
    BOM); any operator-shell invocation without env inheritance hits the bug.
  Fix: stripBom() at all 7 sites. Root cause fixed where all callers route through?
  No single chokepoint exists (sites do raw readFileSync); wrapping each is the
  minimal correct diff without refactoring call signatures.

- FINDING 4 (fixed + flagged): 7 .env backup files with live-format bot tokens
  (orgs/SEB_company/agents/*/.env.pre-blank-bak, codex_runner/.env.bak-cdx-20260515)
  are NOT covered by .gitignore (`.env` matches only exact name). One `git add -A`
  from committing 7 bot tokens to the repo (repo has a GitHub remote).
  Fix: .gitignore now ignores .env.* (keeps !.env.example / !.env.local.example /
  !.env.*.example). FLAGGED for Sebastian: the blanked tokens in the backups were
  never revoked via BotFather — file deletion is approval-required per vault rules,
  so I did not delete them. Revoke or delete at your call.

- FINDING 5 (fixed): pty/redact.ts only redacts JWTs. Telegram bot tokens
  (14-agent fleet, tokens in .env files agents routinely cat) and Anthropic/OpenAI
  sk- keys pass to stdout.log verbatim — same leak class the JWT fix was built for
  (gitleaks audit origin). Fix: added bot-token + sk-key patterns.

## Flagged for review (NOT auto-fixed)

- SENDER SPOOFING (tonight's scare): bus send-message derives `from` from
  CTX_AGENT_NAME (env var, settable by ANY local process — a parallel Sebastian
  session, a stray script). The HMAC (H10) key is a single shared file every agent
  can read, so the signature proves integrity, NOT sender identity. A forged-from
  message is indistinguishable from a real one. Real fix = per-agent keys or
  OS-level inbox ACLs — design change touching message delivery guarantees → review.
  Cheap partial: daemon-side sends could stamp verified sender, but CLI sends run
  in the agent's own process where env is authoritative anyway.
- cron parser: dom+dow both restricted uses AND; standard cron semantics = OR.
  No current cron in the fleet sets both. Changing behavior could shift existing
  schedules → left alone, documented here.
- checkInbox returns [] silently when the inbox lock is contended — fine (1s poll
  retries), but a permanently wedged lock (PID-reused holder on Windows) would look
  like "no messages" with zero logging. Low likelihood; watch item.
- inflight recovery is 5 min — agent-to-agent messages delayed up to 5 min if
  injection fails mid-restart. By design; requeue-fix (Finding 1) doesn't apply
  because inbox files already have a recovery path.

## Verification

- npm run build: clean after every commit.
- Targeted suites all green: inject.test.ts 15/15, output-buffer.test.ts 8/8,
  fast-checker requeue tests 2/2, bus-crons 28/28 (clean env).
- Full suite: 51 failures WITH my changes vs identical failure set at baseline
  commit 44ec50a (verified via worktree + node_modules junction): agent-process 3,
  fast-checker heartbeat-watchdog 2, agent-manager-inspect-op 1, codex-app-server 1,
  catalog/sprint4/enable-agent/dashboard etc. — all pre-existing on this machine,
  none touch the sweep diff. Zero new failures introduced.
- GOTCHA: running the suite from inside a live agent session inherits CTX_AGENT_DIR/
  CTX_ROOT/etc. and trips resolveEnv's #313 sandbox-leak guard → 84 spurious failures.
  Must clear CTX_* env vars when running tests from an agent shell.

## Commits

- 68cb25e fix(pty): un-poison MessageDedup when a verified submit fails
- 2d2dfbe fix(daemon): fast-checker requeues Telegram messages when injection fails
- 4d7dcac fix: BOM-safe BOT_TOKEN reads at 7 sibling sites of the 2026-05-16 bug
- 2afe515 chore(security): gitignore .env backup files carrying live bot tokens
- cca52a6 feat(pty): redact Telegram bot tokens and sk- API keys from PTY capture

Note: fixes land in src/; the live daemon runs dist/ — takes effect on next
daemon restart/rebuild (npm run build already done locally; deploy is Sebastian's
call since it touches the running fleet).

## Gotchas hit

- Fingerprinting .env BOT_TOKENs with grep ^BOT_TOKEN missed BOM'd files (seb_boss
  showed "blank") — the same bug I was auditing bit the audit. Verified with sed.
- pm_bot ".env 3 conflicting model vars" from the task brief: NOT reproduced —
  pm_bot/.env has exactly one active model var (ANTHROPIC_MODEL) + one commented
  CLAUDE_CODE_DISABLE_1M_CONTEXT. Duplicate-key scan across all 13 agent .envs
  found zero duplicates. Treating that brief item as stale.
- seb_boss workdir has ~140 top-level files (scratch) — org content, out of the
  cortextos-repo scope for code fixes; left for a vault_keeper/organizer pass.
