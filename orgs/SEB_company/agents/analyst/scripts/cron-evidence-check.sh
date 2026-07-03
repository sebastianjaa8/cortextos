#!/usr/bin/env bash
# cron-evidence-check.sh — fired-vs-evidence cross-check (undetected_dead_crons, target 0).
# theta-wave CYCLE-2 core deliverable. seb_boss-greenlit 2026-06-27.
#
# THE GAP IT CLOSES (lived failure): a cron fires on schedule but its downstream WORK silently dies.
# surface-poll fired-but-dead 10d; decision-save crons dead 3d -> LOST Sebastian decisions. The fleet
# treated "cron fired" as "work done." wedge-detect.sh already catches the SESSION-DEAD case (cron
# fired + stdout frozen). This catches the COMPLEMENT: session ALIVE (stdout moving, other work
# happening) but a SPECIFIC cron produced NO artifact = its handler silently no-op'd / errored / was
# skipped. That is the decision-cron class wedge-detect is structurally blind to.
#
# SUBSTRATE NOTE (verified 2026-06-27, the hard way): `cortextos bus log-event` does NOT persist
# queryably — 0 cron_completed rows in both the per-agent events JSONL (watchdog heartbeats only) and
# the dashboard SQLite events table. So evidence canNOT be an event query. It MUST be an on-disk
# artifact the cron's handler deterministically writes. Hence the artifact map below.
#
# SCOPE v1: analyst crons that ALWAYS write a deterministic artifact when their work runs. Crons whose
# only reliable evidence is "session processed the prompt" (heartbeat, wedge-detect, check-upstream,
# catalog-browse) are OWNED by wedge-detect.sh (Signal B/C) — not duplicated here. Fleet-wide map = v2.
#
# Detection-only: prints OK/STALE-DISABLED/FLAG + verdict. Exit 0 = all evidenced, 2 = >=1 fired-no-evidence.
# Usage: bash scripts/cron-evidence-check.sh [--selftest]
set -uo pipefail

HOME_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # analyst agent home (absolute)
REPO_DIR="/c/Users/Sebas/cortextos"                          # for auto-commit git evidence
NOW=$(date -u +%s)
GRACE_MIN=${CRON_EV_GRACE_MIN:-45}   # LLM-cron handler needs minutes; 45min absorbs herd serial-delay
# (raised 30->45 2026-06-28: theta-wave-pulse self-flagged when co-fired crons serialized its own
# ledger-write past 30min. Evidence is analyst-self-written, so a busy session legitimately lags.
# 45min still catches a genuinely-dead daily/3d cron within the hour. Tune via CRON_EV_GRACE_MIN.)

epoch() { [[ -z "${1:-}" ]] && { echo 0; return; }; date -u -d "$1" +%s 2>/dev/null || echo 0; }
mtime() { [[ -f "$1" ]] && stat -c '%Y' "$1" 2>/dev/null || echo 0; }

# cron-name -> evidence artifact (absolute path). The artifact mtime MUST advance past last_fire when
# the cron's work runs. ":" separates name:artifact. Interval (for the stale-disabled window) in mins.
#   name | artifact-path | interval_min (skip flag if last_fire older than 1.5x this = cron stale/off)
MAP="
autoresearch-pulse|${HOME_DIR}/experiments/learnings.md|4320
theta-wave-pulse|${HOME_DIR}/reports/theta-wave-experiments.md|1440
theta-wave|${HOME_DIR}/reports/theta-wave-experiments.md|10080
"

# last_fire for a named cron from list-crons (reuse wedge-detect parsing; retry-on-empty).
cron_lastfire() {
  local name="$1" out=""
  for t in 1 2 3; do
    out=$(cortextos bus list-crons analyst 2>/dev/null | grep -iE "^\s*${name}\s" \
          | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2} UTC' | head -1 | sed 's/ UTC//')
    [[ -n "$out" ]] && break
    sleep 1
  done
  echo "$out"
}

check_one() {  # name artifact interval_min  -> echoes a result line, returns 1 if FLAG
  local name="$1" art="$2" ivl="$3"
  local lf; lf=$(cron_lastfire "$name")
  local lf_e=0; [[ -n "$lf" ]] && lf_e=$(epoch "$lf")
  if [[ "$lf_e" -le 0 ]]; then echo "  SKIP ${name} (no last_fire / not scheduled)"; return 0; fi
  local since=$(( (NOW - lf_e)/60 ))
  # stale-disabled guard: if last fire is older than 1.5x interval, the cron is off/stale, not "fired" — skip
  if (( since > ivl*3/2 )); then echo "  STALE-DISABLED ${name} (last_fire ${since}min ago > 1.5x interval ${ivl}min — not recently fired)"; return 0; fi
  # too-soon guard: handler may still be running
  if (( NOW - lf_e <= GRACE_MIN*60 )); then echo "  PENDING ${name} (fired ${since}min ago, within ${GRACE_MIN}min grace — work may be in flight)"; return 0; fi
  local art_e; art_e=$(mtime "$art")
  if (( art_e >= lf_e )); then
    echo "  OK ${name} (fired ${since}min ago; evidence $(basename "$art") mtime $(( (NOW-art_e)/60 ))min ago, after fire)"
    return 0
  else
    echo "  FLAG ${name} fired ${since}min ago (>${GRACE_MIN}min grace) but evidence $(basename "$art") NOT written since (mtime $(( (NOW-art_e)/60 ))min ago, predates fire) = fired-but-no-downstream-work"
    return 1
  fi
}

selftest() {  # synthesize a known dead-cron + a known-good and assert detection
  local tmp; tmp=$(mktemp -d)
  local fresh="${tmp}/fresh.md" old="${tmp}/old.md"
  : > "$fresh"; : > "$old"
  touch -d '60 minutes ago' "$old"     # artifact older than a 40-min-ago fire = should FLAG
  # fake last_fire 40min ago via a stub: test the core mtime comparison directly
  local lf_e=$(( NOW - 40*60 )) pass=0 fail=0
  # case dead: artifact (60min old) < fire (40min ago) -> FLAG expected
  local ae; ae=$(mtime "$old"); if (( ae < lf_e )); then echo "selftest dead: FLAG correctly (art ${ae} < fire ${lf_e})"; pass=$((pass+1)); else echo "selftest dead: MISSED"; fail=$((fail+1)); fi
  # case alive: artifact fresh (now) > fire -> OK expected
  ae=$(mtime "$fresh"); if (( ae >= lf_e )); then echo "selftest alive: OK correctly (art ${ae} >= fire ${lf_e})"; pass=$((pass+1)); else echo "selftest alive: FALSE-FLAG"; fail=$((fail+1)); fi
  rm -rf "$tmp"
  echo "selftest: ${pass} pass, ${fail} fail"; [[ "$fail" -eq 0 ]]
}

if [[ "${1:-}" == "--selftest" ]]; then selftest; exit $?; fi

fails=0
echo "CRON-EVIDENCE $(date -u +%H:%MZ):"
while IFS='|' read -r name art ivl; do
  [[ -z "$name" ]] && continue
  check_one "$name" "$art" "$ivl" || fails=$((fails+1))
done <<< "$(echo "$MAP" | sed '/^[[:space:]]*$/d')"

if (( fails == 0 )); then echo "CRON-EVIDENCE: OK (all recently-fired crons produced downstream evidence)"; exit 0; fi
echo "CRON-EVIDENCE: ${fails} DEAD-CRON FLAG(S) — fired but no downstream work, escalate seb_boss."
exit 2
