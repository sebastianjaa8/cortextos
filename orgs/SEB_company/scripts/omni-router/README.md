# OmniRouter — Claude API fallback proxy

A zero-dependency Node.js HTTP proxy that sits between the cortextOS SEB_company
fleet and the Anthropic API. When the primary API key starts getting rate
limited / overloaded / 5xx'd, OmniRouter transparently fails over to a fallback
API key, then probes the primary and recovers automatically.

Agents keep hitting `localhost:20128` and never notice the switch.

```
agent (Claude Code CLI)
  ANTHROPIC_BASE_URL=http://localhost:20128
        |
        v
  OmniRouter proxy  ──(DIRECT: primary key)────────────►  api.anthropic.com
   :20128            ──(FALLBACK: fallback key)─────────►  api.anthropic.com
                     ──(RECOVERING: serve on fallback,
                        probe primary out-of-band)──────►  api.anthropic.com
```

## State machine

| State        | Behavior                                                                                          |
|--------------|---------------------------------------------------------------------------------------------------|
| `DIRECT`     | Default. Forwards all requests using the **primary** key. Watches response codes.                 |
| `FALLBACK`   | Entered after `FAILURES_TO_TRIP` consecutive trigger codes (429/529/5xx). Uses the **fallback** key. Logs the transition. Holds for `FALLBACK_HOLD_MS`. |
| `RECOVERING` | Entered after the hold window. Keeps serving live traffic on the fallback key, while probing the primary every `RECOVERY_PROBE_INTERVAL_MS`. When a probe returns a healthy (non-trigger) code, transitions back to `DIRECT`. |

Every transition is logged with an ISO-8601 timestamp and a reason. The last 5
transitions are also exposed on the health endpoint.

## Setup

### 1. Populate `.env` from Infisical

The fallback key lives in Infisical under the secret name
**`Claude_Daemon_Fallback_APIKEY`**. This process does **not** call Infisical at
runtime — the operator pulls the value and pastes it into `.env`:

```bash
cd /c/Users/Sebas/cortextos/orgs/SEB_company/scripts/omni-router
cp .env.example .env
# Edit .env:
#   ANTHROPIC_API_KEY  = the fleet's normal primary key
#   FALLBACK_API_KEY   = value of Infisical's Claude_Daemon_Fallback_APIKEY
```

`.env` is gitignored (`cortextos/.gitignore` lines: `.env`, `!.env.example`).
Never commit real keys.

### 2. Start under PM2

```bash
cd /c/Users/Sebas/cortextos/orgs/SEB_company/scripts/omni-router
pm2 start ecosystem.config.js
pm2 logs omni-router          # watch state transitions
pm2 save                      # persist across reboots
```

Verify it's up:

```bash
curl http://localhost:20128/health
# {"state":"DIRECT","uptime":12,...}
```

### 3. Point agents at the proxy

Source the env override before launching any SEB_company agent so its Claude
Code CLI session uses `ANTHROPIC_BASE_URL=http://localhost:20128`:

```bash
source /c/Users/Sebas/cortextos/orgs/SEB_company/scripts/omni-router/agent-env-override.sh
cortextos daemon start        # or however the agent/daemon is launched
```

For persistent application across all fleet launches, add that `source` line to
the daemon launcher or the agent supervisor's startup script. See the comments
in `agent-env-override.sh` for the PM2-managed-agent variant.

> The agent still needs a valid `ANTHROPIC_API_KEY` in its own environment so
> the SDK will make the request — but the proxy **overwrites** the `x-api-key`
> header with its own primary/fallback key, so the agent's value is replaced.

## Health endpoint

`GET /health` (alias `/healthz`) → `200` JSON:

```json
{
  "state": "DIRECT",
  "uptime": 1234,
  "inStateMs": 1234,
  "consecutiveFailures": 0,
  "upstream": "api.anthropic.com:443",
  "primaryKeyConfigured": true,
  "fallbackKeyConfigured": true,
  "recentTransitions": [ { "from": "...", "to": "...", "reason": "...", "ts": "..." } ]
}
```

## Configuration

All knobs live in `.env` (see `.env.example` for the annotated template):

| Var                          | Default                       | Meaning                                            |
|------------------------------|-------------------------------|----------------------------------------------------|
| `ANTHROPIC_API_KEY`          | —                             | Primary key (DIRECT state)                         |
| `FALLBACK_API_KEY`           | —                             | Fallback key (FALLBACK/RECOVERING) — from Infisical|
| `FALLBACK_TRIGGER_CODES`     | `429,529,500,502,503,504`     | Status codes that count as failures                |
| `FAILURES_TO_TRIP`           | `2`                           | Consecutive failures before flipping to FALLBACK   |
| `FALLBACK_HOLD_MS`           | `60000`                       | Time in FALLBACK before RECOVERING                 |
| `RECOVERY_PROBE_INTERVAL_MS` | `15000`                       | Probe cadence while RECOVERING                     |
| `RECOVERY_PROBE_TIMEOUT_MS`  | `10000`                       | Per-probe timeout                                  |
| `OMNIROUTER_PORT`            | `20128`                       | Listen port                                        |
| `OMNIROUTER_HOST`            | `127.0.0.1`                   | Listen host                                        |
| `UPSTREAM_HOST`              | `api.anthropic.com`           | Anthropic upstream host                            |
| `UPSTREAM_PORT`              | `443`                         | Anthropic upstream port                            |

`process.env` overrides `.env` file values, so PM2 / shell exports win.

## Tests

```bash
node test.js
```

No test framework. Spins up a mock upstream, redirects the proxy at it, and
asserts: startup, health endpoint, DIRECT key injection, DIRECT→FALLBACK trip,
key switch, FALLBACK→RECOVERING→DIRECT recovery, transition logging, and
graceful shutdown. All upstream calls are local — no real Anthropic traffic.

## Operations

```bash
pm2 restart omni-router       # after editing .env
pm2 stop omni-router
pm2 logs omni-router --lines 100
```

Graceful shutdown: the proxy handles `SIGTERM`/`SIGINT`, stops accepting
connections, drains, and exits within a 5s grace period (PM2 `kill_timeout` is
set to 6s to allow this).
