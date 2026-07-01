# Fable free-rein second-brain pass — 2026-07-01

Running implementation notes (decisions / changes / tradeoffs / gotchas).

- 20:05Z — scope: fleet agents dirs + state crons.json for all 15 agents dumped and reviewed.
- 20:06Z — finding: seb_boss `weekly-rating-prompt` schedule `0 0 * * 1` (midnight Mon local) contradicts its own prompt text "Sunday 8pm ET". Telegrams Sebastian at midnight. Fix candidate: reschedule.
- 20:06Z — finding: seb_boss `h8-weekly-review` fires `0 0 * * 1` (midnight Mon) and Telegrams Sebastian — violates night-hold (00:00-08:00 no Telegram). Fix candidate: move to Sunday evening.
- 20:06Z — finding: seb_boss `h9-weekly-grocery` (kitchen-assistant, Sun 10am) now duplicated by chef agent's `sunday-grocery` (Sun 8am, fridge.json) — Sebastian would get two grocery Telegrams every Sunday. chef created 2026-07-01 as the dedicated food agent. Fix candidate: disable h9.
- 20:06Z — finding: vault_keeper `obsidian-deadman` cron (every 4h) is fully redundant — the 2h heartbeat cron already runs `obsidian-deadman.sh --check` every fire. Each redundant fire = a full agent session of tokens. Fix candidate: remove the 4h cron.
- 20:07Z — finding: two interval crons appear NEVER to have fired: vault_keeper `weekly-lint-gap-finder` ("7d", created 2026-05-28, zero fire records) and brand_writer `nanoneuro-biweekly-update` ("14d", created 2026-05-14, zero fire records). Other interval crons (24h/2h/3d/7d catalog-browse) fire fine. Investigating daemon logic before fixing.
- 20:07Z — finding: seb_boss `zois-bridge-monitor` says "Review/expire after ~10 days" — created 2026-06-08, still enabled 23 days later. Client-adjacent → propose, don't act.
- 20:07Z — finding: builder_opus lacks CLAUDE.md (convention: CLAUDE.md = "@AGENTS.md") and GUARDRAILS.md — its bootstrap likely never loads in Claude Code sessions; the most powerful builder has no guardrails file. Fix candidate: create both.
- 20:07Z — finding: pm_bot has literal file `memory${TODAY}.md` (unexpanded shell var artifact). Inspect + clean.
- 20:07Z — noted, deliberately NOT touching: 3 disabled seb_boss crons (boot-liveness-check / liveness-poke-live / poke-unconfirmed-check) — consolidated into unified-watchdog 2026-06-25; kept disabled as rollback path, only a week old. Leave.
- 20:07Z — noted: builder_1 root has ~30 stray .png screenshots; email_triage root has scratch txt/json files. Cosmetic; low priority.

## Actions taken

- 20:15Z — ROOT CAUSE (dead interval crons): cortextos src/daemon/cron-scheduler.ts — for a never-fired cron, referenceMs falls back to `now`, so interval schedules ("7d","14d") restart their countdown on every daemon restart. Daemon restarts more often than the interval ⇒ cron never fires. Cron-EXPRESSION schedules are calendar-anchored and immune. cortextos src is no-modify (community repo rule) ⇒ fixed at config level.
- 20:20Z — change: `cortextos bus update-cron vault_keeper weekly-lint-gap-finder --interval "0 23 * * 0"` (was "7d", 0 fires since 05-28; Sunday 11pm matches the prompt's own stated time). Read-back verified.
- 20:21Z — change: brand_writer nanoneuro-biweekly-update → `0 10 * * 2` (weekly Tue 10am) + CADENCE GUARD prepended to prompt (reads Log.md last-sent date, exits silently if <13 days). Was "14d", 0 fires since 05-14 — a client-deliverable draft cron silently dead for 7 weeks. Draft-only + Sebastian-hand on send, so risk low. Read-back verified.
- 20:21Z — change: seb_boss weekly-rating-prompt `0 0 * * 1` → `15 20 * * 0` (prompt says "Sunday 8pm ET"; was Telegramming Sebastian at midnight; staggered :15 to avoid voice-weekly 20:00 collision).
- 20:21Z — change: seb_boss h8-weekly-review `0 0 * * 1` → `30 20 * * 0` (midnight-Monday Telegram violated the 00:00-08:00 night-hold).
- 20:21Z — change: seb_boss h9-weekly-grocery DISABLED (kitchen-assistant grocery Telegram duplicated by chef agent's sunday-grocery since chef's creation 2026-07-01 — Sebastian would get two Sunday grocery lists). Disabled not removed = one-command rollback.
- 20:22Z — change: vault_keeper obsidian-deadman cron DISABLED (its 2h heartbeat already runs obsidian-deadman.sh --check every fire; the 4h cron duplicated the same check at full agent-session token cost — ~6 wasted sessions/day). obsidian-preempt (different script) left alone.
- 20:24Z — change: builder_opus was missing CLAUDE.md, GUARDRAILS.md, SYSTEM.md, TOOLS.md, USER.md — all referenced by its own AGENTS.md bootstrap. Copied from builder_1 (verified byte-identical between builder_1 and builder_2 = generic templates). The Opus-model builder was running with no guardrails file.
- 20:24Z — change: pm_bot literal `memory${TODAY}.md` (unexpanded shell-var artifact holding real 06-11→06-17 session memory) → moved to pm_bot/memory/recovered-2026-06-11-and-17-unexpanded-var.md.
- 20:26Z — change: cron-effectiveness-audit.py extended with audit_overdue() — flags enabled crons >2x nominal period since last fire (or since creation if never fired); emits cron_overdue_gap bus events. Self-test extended (5 fixtures), passes. Live bus-off run flags exactly the two real dead crons (correct: they stay flagged until first fire on new schedules).
- 20:28Z — tradeoff: overdue flags will re-fire each 6h audit until the two crons first fire (Tue 10am / Sun 11pm). Accepted — they ARE overdue until then.
- 20:29Z — cleanup: builder_1/*.png → builder_1/work/screenshots/; email_triage scratch txt/json → email_triage/_scratch/. All untracked (orgs/ gitignored), filesystem-only.
- 20:30Z — gotcha: whole orgs/ tree is gitignored; only force-added files (audit script + NOTES) are tracked. Force-adding this pass-notes file for durability.

## Deliberately NOT touched

- 3 disabled seb_boss crons (boot-liveness-check / liveness-poke-live / poke-unconfirmed-check): rollback path for the 06-25 unified-watchdog consolidation, one week old. Leave.
- seb_boss zois-bridge-monitor: prompt says "review/expire after ~10 days", created 06-08 (23 days). Client-adjacent monitoring → PROPOSE to Sebastian, not auto-disable.
- test-agent leftover state dir (only cron-execution.log): harmless, outside audit lookback.
- cortextos src interval-cron bug: no-modify rule. Documented root cause here + in NOTES; worth an upstream issue if Sebastian wants.
- ~/.claude/CLAUDE.md stale claim ("morning-brief cron ... in config.json" — actually crons.json since migration): user-named-files-only rule → proposed in report, not edited.
- Sunday-evening cron pile-up (17:00→23:00 has 9+ crons across agents): known herd-delay issue already absorbed by analyst 45min grace; rebalancing all of them = churn without evidence of breakage.
