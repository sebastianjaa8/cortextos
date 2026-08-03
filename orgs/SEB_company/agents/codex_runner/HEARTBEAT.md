# Heartbeat Checklist

## Night Mode

If local time is 00:00-08:00 America/New_York, use a silent heartbeat: touch file, no Telegram, no active execution unless seb_boss explicitly overrides.

## Cap Discipline

Cap discipline: check Codex CLI weekly cap usage; surface to seb_boss via bus at 70% / 85% / 95% thresholds; halt new dispatches at 95%.

The local cap gauge is passive session telemetry and is expected to become stale while this agent is parked. Do not refresh it on a schedule. When a new dispatch is being considered after a stale reading, make one minimal real Codex API probe first, then re-parse. It authorizes a decision only when `codex_rate_limits_captured_at` is newer than the pre-probe value **and** `rate_limits` is present. Any other result is `UNKNOWN`: do not start the dispatch, do not retry, and escalate to seb_boss. This deliberate, metered probe is a cold-start workaround, not a repair; replace it if an authenticated on-demand Codex usage source becomes available.

Runs every 4h. Execute ALL steps in order — skipping = broken system, dashboard tracks compliance.

## Step 0: Tier 3 context gate (NEW 2026-05-25)

Before any other heartbeat work, check context plus task/inbox state:
```bash
PCT=$(jq -r .used_percentage < "$CTX_ROOT/state/$CTX_AGENT_NAME/context_status.json" 2>/dev/null | cut -d. -f1)
IN_PROGRESS_TASK_EXISTS=$(cortextos bus list-tasks --agent $CTX_AGENT_NAME --status in_progress --format json 2>/dev/null | jq -r 'if length > 0 then "true" else "false" end')
NEW_DISPATCH_ARRIVED=$(cortextos bus check-inbox 2>/dev/null | jq -r 'if length > 0 then "true" else "false" end')
CAPPED=$([ "${PCT:-0}" -ge 95 ] && echo true || echo false)
```
Self-restart ONLY IF one of these is true:
- `PCT >= 70` AND `IN_PROGRESS_TASK_EXISTS=true`
- `CAPPED=true` AND `NEW_DISPATCH_ARRIVED=true`

```bash
cortextos bus hard-restart --reason "Tier 3 restart: context $PCT%, in_progress=$IN_PROGRESS_TASK_EXISTS, capped=$CAPPED, new_dispatch=$NEW_DISPATCH_ARRIVED"
```
Skip the rest of heartbeat — fresh session will run its own.

Otherwise HOLD parked-at-100% state. Do not restart. Do not Telegram. Continue heartbeat via bus-only updates.

## Step 1: update-heartbeat FIRST
```bash
cortextos bus update-heartbeat "<1-sentence summary of current work>"
```
Dashboard status field. If fails → fix before anything else.

## Step 2: Sweep inbox + ACK
Ref: `plugins/cortextos-agent-skills/skills/comms/SKILL.md`
```bash
cortextos bus check-inbox
# For each msg: cortextos bus ack-inbox "<message_id>"
```
Un-ACK'd msgs re-deliver after 5min. Telegram-shape msgs (`=== TELEGRAM from`) should have been replied at arrival — if not, reply NOW.

## Step 3: Task queue + stale detection
Ref: `plugins/cortextos-agent-skills/skills/tasks/SKILL.md`
```bash
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status pending
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status in_progress
```
- Pending → before starting, confirm it is not completed work lacking closure; if completed, close it with durable evidence, otherwise pick highest priority
- in_progress >2h → complete OR update with note
- No tasks → check GOALS.md → message orchestrator

## Step 4: log-event heartbeat
```bash
cortextos bus log-event heartbeat agent_heartbeat info --meta '{"agent":"'$CTX_AGENT_NAME'"}'
```
NOT same as Step 1 — this appends to activity feed (JSONL). Both required.

## Step 5: Daily memory
Ref: `plugins/cortextos-agent-skills/skills/memory/SKILL.md`
```bash
TODAY=$(date -u +%Y-%m-%d); LOCAL=$(date +'%-I:%M %p %Z' 2>/dev/null || date)
cat >> "memory/$TODAY.md" << MEMORY

## Heartbeat $(date -u +'%H:%MZ') / $LOCAL
- WORKING ON: <task_id or "none">
- Status: <healthy/working/blocked>
- Inbox: <N processed>
- Next: <next action>
MEMORY
```

## Step 6: GOALS.md check
- Stale >24h → request refresh from orchestrator
- No goals → message orchestrator (don't idle)

## Step 7: Resume work
Highest-priority task → trace to current goals.
```bash
cortextos bus update-task "<id>" in_progress
# when done:
cortextos bus complete-task "<id>" --result "<summary>"
```
Blocked? See `plugins/cortextos-agent-skills/skills/human-tasks/SKILL.md`.

## Step 8: Guardrail self-check
Did I skip a procedure? Rationalize not doing something?
```bash
cortextos bus log-event action guardrail_triggered info --meta '{"guardrail":"<which>","context":"<what>"}'
```
New pattern worth a guardrail? Add to GUARDRAILS.md.

## Step 9: MEMORY.md update (if applicable)
Patterns / user preferences / system behaviors learned this cycle → append.

## Step 10: KB re-ingest
```bash
FT_KB_SKIP_UNCHANGED=1 \
  node C:/Users/Sebas/cortextos/scripts/kb-ingest-receipt.mjs \
  --agent $CTX_AGENT_NAME --org $CTX_ORG ./MEMORY.md \
  --optional ./memory/$(date -u +%Y-%m-%d).md
```

**Wrapped 2026-08-01 (builder_1, task_1785615335534_46337286, authorised by seb_boss, announced on the
bus before landing). This step used to call `cortextos bus kb-ingest` directly. Three things changed,
each because the raw form could not tell you it had failed.**

1. **The daily file is now `--optional`.** It used to be REQUIRED — and `cortextos bus kb-ingest`
   EXITS 0 ON A PATH THAT DOES NOT EXIST while reporting 0 chunks. Your daily memory file does not
   exist until something writes memory that day, so on every cycle before that, this step ingested
   LESS THAN IT CLAIMED and reported success. Verified, not theorised. Absent optional paths are now
   SKIPPED AND NAMED in the verdict rather than silently dropped.
2. **Every run writes a receipt** to `${CTX_ROOT}/state/$CTX_AGENT_NAME/.kb-ingest-receipts.jsonl`
   with the embedding-token count and the paths ACTUALLY SENT, on failure as well as success. A
   receipt written only on success cannot distinguish "failed" from "never ran", which is the pair
   that hid this. Before today this step had no receipt at all.
3. **Give it a generous timeout, 600000ms.** The usual harness default is 120000ms. A ~350KB ingest
   takes ~204s and is killed at 120s with exit 143 (128+15, SIGTERM), which reads exactly like the
   ingest failing when it is the ingest being STOPPED. Opposite problems, same transcript.

**Read the VERDICT line, not the exit code alone.** `INGESTED` (0) means real embedding tokens were
spent — a success.
- `UNCHANGED` (exit 0) — your inputs are byte-identical (sha256) to what the last receipt recorded,
  so nothing was re-embedded. ALSO A SUCCESS. The previous receipt still describes what is indexed.
  Added 2026-08-01 (commit a96490dc): the wrapper hardcoded `--force` and re-embedded unchanged files
  on every fire — 96,466 tokens and 199s per cycle for builder_1, 12 cycles a day. We did NOT simply
  drop the flag: without it kb-ingest prints "Ingested 0 new chunk(s) / Tokens: 0" for an
  already-indexed file, which this wrapper correctly calls ZERO-TOKENS, a FINDING — so dropping it
  would have turned every quiet cycle red on all 15 agents. It skips the CALL instead of weakening
  the check. ACTIVE SINCE 2026-08-02 on all 15 agents: the step-10 line sets FT_KB_SKIP_UNCHANGED=1,
  so an unchanged file is skipped and the wrapper renders UNCHANGED with zero embedding tokens.
  UNCHANGED IS A SUCCESS VERDICT, NOT A FINDING. The builder_1 canary passed both real cycles before
  the fleet rollout; if you see INGESTED for a file you did not edit, that is the finding.

`ZERO-TOKENS` / `NO-TOKEN-LINE` / `PATH-MISSING` (2) are real findings —
report the VERDICT line to seb_boss. `COULD-NOT-RUN` (3) means the wrapper is broken, not your memory.


> There is no `--collection` flag. This file previously documented
> `--collection memory-$CTX_AGENT_NAME`, which the CLI rejects outright with
> `error: unknown option '--collection'` — so the step failed rather than
> ingesting anything. The collection name is derived, not passed: private
> scope lands in `agent-<name>`, not `memory-<name>`, so the documented name
> was wrong too. Verified against `kb-ingest --help` and `kb-collections`
> on 2026-07-28.
Skip if GEMINI_API_KEY unset.

---

Target: ≥2 events + ≥1 memory update per cycle. Invisible work = wasted work.
