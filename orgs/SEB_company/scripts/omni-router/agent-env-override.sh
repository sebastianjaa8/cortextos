#!/usr/bin/env bash
# OmniRouter agent env override.
#
# Source this BEFORE launching any cortextOS SEB_company Claude agent so the
# agent's Claude Code CLI session routes through the local OmniRouter proxy
# instead of hitting api.anthropic.com directly.
#
# The Claude Code CLI / Anthropic SDK honor ANTHROPIC_BASE_URL. Pointing it at
# the proxy lets OmniRouter transparently fail over to the fallback API key.
#
# ── How to use ──────────────────────────────────────────────────────────────
#
# 1. One-shot (current shell only):
#        source /c/Users/Sebas/cortextos/orgs/SEB_company/scripts/omni-router/agent-env-override.sh
#        cortextos daemon start          # or however the agent is launched
#
# 2. Persistent for all fleet launches — add this line to the daemon launcher
#    or to ~/.bashrc / the agent supervisor's startup script:
#        source /c/Users/Sebas/cortextos/orgs/SEB_company/scripts/omni-router/agent-env-override.sh
#
# 3. PM2-managed agents — reference this in the agent's ecosystem env, or export
#    ANTHROPIC_BASE_URL in the PM2 process env directly.
#
# Note: the agents still need a valid ANTHROPIC_API_KEY in their own env. The
# proxy OVERWRITES the x-api-key header with its own primary/fallback key, so
# the value the agent sends is replaced — but the SDK still requires the var to
# be set to make the request at all. Keep the existing key export in place.

OMNIROUTER_HOST="${OMNIROUTER_HOST:-127.0.0.1}"
OMNIROUTER_PORT="${OMNIROUTER_PORT:-20128}"

export ANTHROPIC_BASE_URL="http://${OMNIROUTER_HOST}:${OMNIROUTER_PORT}"

echo "[omni-router] ANTHROPIC_BASE_URL set to ${ANTHROPIC_BASE_URL} for this shell" >&2

# Optional sanity check: warn if the proxy is not up.
if command -v curl >/dev/null 2>&1; then
  if ! curl -sf "http://${OMNIROUTER_HOST}:${OMNIROUTER_PORT}/health" >/dev/null 2>&1; then
    echo "[omni-router] WARNING: proxy not reachable at ${ANTHROPIC_BASE_URL}/health — start it with 'pm2 start ecosystem.config.js'" >&2
  fi
fi
