# Implementation Notes — cron-effectiveness-audit.py (overnight build G)

Spec: task_1781451630869_9938334 · built by builder_1 · 2026-06-30

- 01:53Z — decision: implemented in Python, not bash. Two JSONL sources + per-cron
  time-window streak logic. Matches the existing convention (the JSON-heavy
  watchdog scripts already shell out to python3; pure-bash ones stay simple).
- 01:53Z — change: spec said "scan crons.json per agent." There is NO crons.json
  on disk. Cron DEFINITIONS live in `orgs/<org>/agents/<agent>/config.json` (.crons[]);
  cron FIRE HISTORY lives in `<root>/.cortextOS/state/agents/<agent>/cron-execution.log`
  (clean JSONL: {ts,cron,status,attempt,duration_ms,error}). Used the execution log as
  the fire source — it carries the timestamps we actually need, and naturally enumerates
  the crons that really fired. Agents are discovered from the state/agents dir.
- 01:53Z — gotcha (the important one): events live in TWO streams.
  `<root>/analytics/events/<agent>/<date>.jsonl` carries passive
  `"[watchdog] <agent> alive"` liveness pokes injected by the daemon independent of any
  cron. `<root>/orgs/<org>/analytics/events/<agent>/<date>.jsonl` carries the REAL
  bus events (agent_heartbeat, task_created, session_start, inbox_ack...). First dry-run
  read both unfiltered → "61 crons CLEAN" — a false all-clear, because a watchdog poke
  almost always lands within 30min of any fire and masks every silent cron.
- 01:55Z — calibration knob: added EXCLUDE_WATCHDOG (default on) — skip events whose
  metadata.status contains "[watchdog]". A cron is "productive" only if it produced a
  GENUINE agent event in the 30min window. With the filter on, the audit surfaced a real
  gap: vault_keeper/obsidian-deadman — fires every 4h at :00, but vault_keeper's only real
  events are its 2h heartbeat at :52, so no deadman fire ever has an event in-window
  (verified: 7 consecutive fires 06-29 00:00 → 06-30 00:00, zero real events within 30min).
- 01:53Z — decision: judge only fires whose 30min window has fully elapsed
  (fire+30 <= now). Otherwise a just-fired cron always looks "silent" and over-flags.
- 01:53Z — decision: flag the TRAILING consecutive silent streak (ending at the most
  recent closed fire), not any historical run. A cron that was silent then recovered is
  not a current problem. Self-test covers the "recovered" case explicitly.
- 01:53Z — tradeoff: linear scan of event times per fire (O(fires*events)). N is tiny
  (tens of fires, hundreds of events / 48h) so no index. ponytail: upgrade to bisect if
  lookback ever grows to weeks.
- 01:53Z — tradeoff: a cron that does real work but logs to a file instead of the bus
  (e.g. obsidian-deadman may write its own log) is flagged as a "gap". That is correct
  per the spec's invariant ("no bus events"): the monitor's job is to surface it; seb_boss
  triages whether it's broken or just not bus-logging. Documented, not silently suppressed.
- 01:55Z — verification: `--self-test` (synthetic broken/healthy/recovered fixtures,
  deterministic now, bus off) passes; live dry-run (bus off, temp log) reproduces the
  vault_keeper finding.

- 01:58Z — change: spec said `bus log-event monitoring cron_effectiveness_gap`. "monitoring"
  is NOT a valid bus category (valid: action/error/metric/milestone/heartbeat/message/task/
  approval) and "warn" is not a valid severity (valid: info/warning/error/critical). Used
  category `metric` + severity `warning`, event name `cron_effectiveness_gap` unchanged.
- 01:57Z — gotcha (Windows): first real run failed two ways. (1) watchdog-log path was
  hardcoded `/c/Users/...` — an MSYS-only path that native CPython can't open; now derived
  from __file__. (2) `cortextos` is an npm .cmd shim; subprocess(list) via CreateProcess
  can't resolve it. Fixed with shell=True (Python uses cmd.exe on Windows even from Git Bash)
  + JSON quotes escaped as \" for cmd.exe. Verified the event lands in the org event stream.

## Wiring (NOT done by builder_1 — seb_boss to register; mutating seb_boss runtime is its call)
Either fold into the existing unified-watchdog routine (alongside boot-liveness-check.sh /
check-poke-unconfirmed.sh):
    python /c/Users/Sebas/cortextos/orgs/SEB_company/agents/seb_boss/scripts/cron-effectiveness-audit.py --quiet
or register a standalone cron (every 6h, offset off the :00 stampede):
    cortextos bus add-cron seb_boss cron-effectiveness "30 */6 * * *" \
      "Run scripts/cron-effectiveness-audit.py to flag crons firing without producing bus events."
The script writes its summary line to .watchdog.log and emits one
`bus log-event monitoring cron_effectiveness_gap` per flagged cron.

## 2026-07-01 extension — overdue / never-fired detection (Fable free-rein pass)

- Added `audit_overdue()`: reads every agent's crons.json directly; flags enabled crons whose last fire (or created_at if never fired) is >2x nominal period old. Emits `cron_overdue_gap` bus events + OVERDUE section in the .watchdog.log line.
- Why: the fire-based audit is structurally blind to crons that NEVER fire. Root cause found in daemon cron-scheduler.ts — never-fired interval crons ("7d"/"14d") recompute nextFireAt from *now* on every daemon restart, so any daemon restarting more often than the interval means the cron never fires. Real victims: vault_keeper/weekly-lint-gap-finder (7d, 0 fires since 05-28), brand_writer/nanoneuro-biweekly-update (14d, 0 fires since 05-14). Both converted to calendar-anchored cron exprs (immune to the reset).
- Period estimation for cron exprs is coarse by design: month-restricted → skip, DOM → 31d, DOW → 7d, else 1d. Sub-daily exprs collapse to 1d — only makes the 2x check more conservative.
- ponytail: no fix to cortextos src (community repo, no-modify rule) — detection here + config-level workaround instead.
- Self-test extended with 5 overdue fixtures (never-fired flag, stalled flag, fresh/disabled/seasonal clean).
