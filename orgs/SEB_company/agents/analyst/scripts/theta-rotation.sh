#!/usr/bin/env bash
# theta-rotation.sh — hub-and-spoke rotation for theta-wave-pulse (built 2026-07-23, task_1784827526727)
#
# Problem: theta-wave went fleet-wide 2026-07-08 (9 agents "registered": atlas, vault_keeper, chef,
# finance_tracker, brand_writer, email_triage, pm_bot, seb_boss, analyst) under a stated hub-and-spoke
# architecture -- analyst's daily pulse rotating across registered cycles, not per-agent cron sprawl.
# In practice the pulse never rotated: every ledger entry since 06-14 is analyst doing its OWN local
# work, and `cortextos bus list-experiments --agent <spoke>` returns [] for all 8 non-analyst spokes
# 2+ weeks later. Registration created the experiments/ folder scaffolding on each spoke but nothing
# ever dispatched to them -- the hub side of hub-and-spoke was never actually built.
#
# This script is the hub side, made real: a persisted rotation index advances one slot per fire and
# bus-messages the next spoke a concrete one-shot theta-wave nudge. On analyst's own rotation slot,
# it does nothing (the existing pulse prompt's local-improvement-increment logic already covers
# analyst's turn) -- this script only owns dispatching to the OTHER 8 spokes.
#
# ponytail: flat round-robin, no priority weighting / skip-if-already-running check on the spoke's
# side. Add weighting only if a spoke goes stale-silent across multiple nudges despite this -- that's
# a spoke-side adoption problem to observe first, not a hub-side scheduling problem to guess at now.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_FILE="${SCRIPT_DIR}/.theta-rotation-state.json"
LEDGER="${SCRIPT_DIR}/../reports/theta-wave-experiments.md"

SPOKES=(atlas vault_keeper chef finance_tracker brand_writer email_triage pm_bot seb_boss analyst)

NUDGE_PROMPT='THETA-WAVE nudge (hub-and-spoke rotation, analyst-dispatched). It is your turn in the fleet-wide rotation. Check `cortextos bus list-experiments --agent $CTX_AGENT_NAME`: if nothing running, pick ONE small, reversible, internal hypothesis about your own performance/behavior, `create-experiment` + `run-experiment` it, and log a one-line note to your own memory/ when you evaluate it (see TOOLS.md/autoresearch skill for the CLI). If one is already running, `evaluate-experiment` it if enough data has accumulated. Keep it small -- do not run a full review, this is a light increment. Escalate to seb_boss only if a finding is decision-worthy.'

run_rotation() {
  local state_file="$1"
  [ -f "$state_file" ] || echo '{"index":0}' > "$state_file"

  local target
  target=$(python3 - "$state_file" "${SPOKES[@]}" << 'PYEOF'
import json, sys
state_path = sys.argv[1]
spokes = sys.argv[2:]
with open(state_path, encoding='utf-8') as f:
    state = json.load(f)
idx = state.get('index', 0) % len(spokes)
target = spokes[idx]
state['index'] = (idx + 1) % len(spokes)
state['last_target'] = target
with open(state_path, 'w', encoding='utf-8') as f:
    json.dump(state, f, indent=2)
print(target)
PYEOF
)
  echo "$target"
}

if [ "${1:-}" = "--self-test" ]; then
  TMP_STATE="$(mktemp)"
  echo '{"index":0}' > "$TMP_STATE"
  seen=()
  for i in $(seq 1 9); do
    seen+=("$(run_rotation "$TMP_STATE")")
  done
  # assert: round-robin visits all 9 spokes in declared order, exactly once each
  ok=1
  for i in "${!SPOKES[@]}"; do
    if [ "${seen[$i]}" != "${SPOKES[$i]}" ]; then
      ok=0
      echo "SELF-TEST FAIL: slot $i expected ${SPOKES[$i]} got ${seen[$i]}"
    fi
  done
  # assert: wraps around correctly (10th call == 1st spoke again)
  wrap=$(run_rotation "$TMP_STATE")
  if [ "$wrap" != "${SPOKES[0]}" ]; then
    ok=0
    echo "SELF-TEST FAIL: wraparound expected ${SPOKES[0]} got $wrap"
  fi
  rm -f "$TMP_STATE"
  if [ "$ok" = "1" ]; then
    echo "SELF-TEST PASS: 9-slot round-robin + wraparound verified, no mocks."
    exit 0
  else
    exit 1
  fi
fi

TARGET=$(run_rotation "$STATE_FILE")
NOW_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)

if [ "$TARGET" = "analyst" ]; then
  echo "ROTATION: analyst's own slot this fire -- no spoke dispatch, continue local pulse work."
  {
    echo ""
    echo "- ${NOW_ISO} [theta-rotation] slot=analyst (local turn, no spoke dispatch)"
  } >> "$LEDGER"
else
  MSG_ID=$(cortextos bus send-message "$TARGET" normal "$NUDGE_PROMPT" 2>&1)
  echo "ROTATION: dispatched nudge to spoke=$TARGET ($MSG_ID)"
  {
    echo ""
    echo "- ${NOW_ISO} [theta-rotation] slot=$TARGET, nudge dispatched: $MSG_ID"
  } >> "$LEDGER"
fi
