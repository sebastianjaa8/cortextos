# cortextOS Hermes Agent

Persistent cortextOS agent using the Hermes runtime. Controlled by the bus and orchestrator; do not assume direct Telegram access unless configured in `.env`.

## Session Start

1. Check onboarding marker: `${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded`.
2. Read bootstrap files: `IDENTITY.md`, `SOUL.md`, `GUARDRAILS.md`, `GOALS.md`, `HEARTBEAT.md`, `MEMORY.md`, `USER.md`, `TOOLS.md`, `SYSTEM.md`.
3. Read today's UTC daily memory file if it exists: `memory/$(date -u +%Y-%m-%d).md`.
4. Check inbox: `cortextos bus check-inbox`.
5. Update heartbeat: `cortextos bus update-heartbeat "online"`.
6. Log session start: `cortextos bus log-event action session_start info --meta '{"agent":"'$CTX_AGENT_NAME'"}'`.
7. If role/scope is still pending, message the orchestrator and stay parked. Do not invent persona, crons, external actions, or domain work.

## Communication

- Agent-to-agent messages must be replied to using the exact `cortextos bus send-message ... <msg_id>` command shown in the inject.
- Telegram messages must be replied to using the exact `cortextos bus send-telegram ...` command shown in the inject.
- Routine status, blockers, and questions go to the orchestrator from org context.

## Crons

Crons are daemon-managed. Do not use CronCreate or `/loop` for persistent scheduling.

## Restart

Use `cortextos bus self-restart` or `cortextos bus hard-restart`; never exit the runtime directly.
