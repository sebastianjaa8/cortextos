#!/usr/bin/env python3
"""cron-effectiveness-audit.py — invariant-monitor extension (overnight build G).

Flags crons that FIRE but produce NO bus event from the same agent within a
30-minute window. A cron firing injects a prompt into the agent's session; a
healthy agent then logs at least one bus event (heartbeat, task, action...).
A fire with zero events in the window is a "silent fire" — the cron ran but the
agent did nothing visible. 3+ consecutive trailing silent fires => the cron is
effectively dead, even though the scheduler reports it "fired".

Data sources (all JSONL, read-only):
  - fires:  <STATE>/<agent>/cron-execution.log   {ts,cron,status,...}
  - events: <EVENTS>/<agent>/<date>.jsonl        {agent,timestamp,event,...}

Also flags OVERDUE crons (added 2026-07-01): enabled crons in crons.json whose
last fire (or created_at, if never fired) is older than 2x their nominal period.
Catches the interval-cron reset bug — never-fired interval crons ("7d", "14d")
recompute nextFireAt from *now* on every daemon restart, so a daemon that
restarts more often than the interval means the cron NEVER fires (real cases:
vault_keeper/weekly-lint-gap-finder, brand_writer/nanoneuro-biweekly-update).

Output:
  - one summary line appended to seb_boss/.watchdog.log
  - one `bus log-event monitoring cron_effectiveness_gap` per flagged cron
  - one `bus log-event metric cron_overdue_gap` per overdue cron

Always exits 0 in normal mode (watchdog sub-check must never abort the chain).
Run `--self-test` for the built-in synthetic check.

Env overrides (used by --self-test, harmless in prod):
  CRON_AUDIT_STATE_DIR    dir of <agent>/cron-execution.log
  CRON_AUDIT_EVENTS_DIRS  colon-separated dirs of <agent>/<date>.jsonl (union)
  CRON_AUDIT_WATCHDOG_LOG path to .watchdog.log
  CRON_AUDIT_NOW          ISO8601 "now" for deterministic testing
  CRON_AUDIT_BUS          "off" to skip real bus calls
"""
import os
import re
import sys
import json
import glob
import subprocess
from datetime import datetime, timedelta, timezone

WINDOW_MIN = 30           # event must land within 30min of fire
SILENT_STREAK_FLAG = 3    # 3+ consecutive trailing silent fires => gap
LOOKBACK_HOURS = 48       # only judge recent fires (avoid ancient history)
# The daemon/watchdog injects passive "[watchdog] <agent> alive" liveness pokes
# into the event stream independent of any cron. Counting those as productivity
# would mask every truly-silent cron, so exclude them by default — a cron is
# "productive" only if it produced a GENUINE agent event in the window.
EXCLUDE_WATCHDOG = os.environ.get("CRON_AUDIT_EXCLUDE_WATCHDOG", "on") != "off"

HOME = os.path.expanduser("~")
DEFAULT_ROOT = os.path.join(HOME, ".cortextos", "default")
STATE_DIR = os.environ.get(
    "CRON_AUDIT_STATE_DIR",
    os.path.join(DEFAULT_ROOT, ".cortextOS", "state", "agents"))
EVENTS_DIRS = os.environ.get(
    "CRON_AUDIT_EVENTS_DIRS",
    os.pathsep.join([
        os.path.join(DEFAULT_ROOT, "analytics", "events"),
        os.path.join(DEFAULT_ROOT, "orgs", "SEB_company", "analytics", "events"),
    ])).split(os.pathsep)
# .watchdog.log sits one dir up from this script (agents/seb_boss/). Derive it from
# __file__ so it resolves under both Windows Python and MSYS bash (a hardcoded /c/...
# path is MSYS-only and fails under native CPython).
WATCHDOG_LOG = os.environ.get(
    "CRON_AUDIT_WATCHDOG_LOG",
    os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".watchdog.log")))
BUS_ENABLED = os.environ.get("CRON_AUDIT_BUS", "on") != "off"


def parse_ts(s):
    """Parse ISO8601 (handles trailing Z and fractional seconds) -> aware UTC."""
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.strip().replace("Z", "+00:00")).astimezone(timezone.utc)
    except (ValueError, AttributeError):
        return None


def now_utc():
    override = os.environ.get("CRON_AUDIT_NOW")
    return parse_ts(override) if override else datetime.now(timezone.utc)


def read_jsonl(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    continue
    except OSError:
        return


def load_fires(agent, since):
    """Return {cron_name: [fire_dt, ...]} sorted ascending, status==fired, ts>=since."""
    path = os.path.join(STATE_DIR, agent, "cron-execution.log")
    fires = {}
    for rec in read_jsonl(path):
        if rec.get("status") != "fired":
            continue
        ts = parse_ts(rec.get("ts"))
        if ts is None or ts < since:
            continue
        fires.setdefault(rec.get("cron", "?"), []).append(ts)
    for name in fires:
        fires[name].sort()
    return fires


def load_event_times(agent, since, until):
    """Union of event timestamps for agent across event dirs over the date range."""
    times = []
    day = since.date()
    last = until.date()
    dates = []
    while day <= last:
        dates.append(day.isoformat())
        day += timedelta(days=1)
    for base in EVENTS_DIRS:
        for d in dates:
            for rec in read_jsonl(os.path.join(base, agent, d + ".jsonl")):
                if EXCLUDE_WATCHDOG:
                    status = str((rec.get("metadata") or {}).get("status", ""))
                    if "[watchdog]" in status:
                        continue
                ts = parse_ts(rec.get("timestamp"))
                if ts is not None:
                    times.append(ts)
    times.sort()
    return times


def has_event_in_window(event_times, start, end):
    """True if any event time t satisfies start <= t <= end. Linear is fine (small N)."""
    for t in event_times:
        if t < start:
            continue
        if t <= end:
            return True
        break  # sorted: past the window
    return False


def trailing_silent_streak(fires, event_times, now):
    """Count consecutive silent fires ending at the most recent CLOSED-window fire."""
    window = timedelta(minutes=WINDOW_MIN)
    # only fires whose 30min window has fully elapsed are judgeable
    closed = [f for f in fires if f + window <= now]
    streak = 0
    for f in reversed(closed):
        if has_event_in_window(event_times, f, f + window):
            break
        streak += 1
    return streak, len(closed)


def nominal_period(schedule):
    """Nominal fire period for a schedule, or None if unjudgeable.

    Interval shorthand ("30m","2h","7d") parses exactly. 5-field cron exprs are
    estimated coarsely: month-restricted -> None (seasonal, skip), day-of-month
    -> ~31d, day-of-week -> 7d, else -> 1d. Sub-daily cron exprs collapse to 1d,
    which only makes the 2x-overdue check MORE conservative (never false-flags).
    """
    m = re.fullmatch(r"(\d+)([smhd])", schedule.strip())
    if m:
        n = int(m.group(1))
        return timedelta(seconds=n * {"s": 1, "m": 60, "h": 3600, "d": 86400}[m.group(2)])
    fields = schedule.split()
    if len(fields) != 5:
        return None
    _minute, _hour, dom, month, dow = fields
    if month != "*":
        return None
    if dom != "*":
        return timedelta(days=31)
    if dow != "*":
        return timedelta(days=7)
    return timedelta(days=1)


def audit_overdue(now):
    """Flag enabled crons whose last fire (or created_at) is > 2x period ago.

    Returns [(agent, cron, days_overdue_baseline, never_fired), ...].
    Judges crons.json directly, so it catches crons the fire-based audit can
    never see: ones that have NEVER fired.
    """
    flagged = []
    if not os.path.isdir(STATE_DIR):
        return flagged
    for agent in sorted(os.listdir(STATE_DIR)):
        path = os.path.join(STATE_DIR, agent, "crons.json")
        try:
            with open(path, "r", encoding="utf-8") as fh:
                crons = json.load(fh).get("crons", [])
        except (OSError, ValueError):
            continue
        for c in crons:
            if not c.get("enabled"):
                continue
            period = nominal_period(str(c.get("schedule", "")))
            if period is None:
                continue
            fired = parse_ts(c.get("last_fired_at")) or parse_ts(c.get("last_fire_attempted_at"))
            baseline = fired or parse_ts(c.get("created_at"))
            if baseline is None:
                continue
            if now - baseline > 2 * period:
                age_days = (now - baseline).total_seconds() / 86400.0
                flagged.append((agent, c.get("name", "?"), round(age_days, 1), fired is None))
    return flagged


def discover_agents():
    if not os.path.isdir(STATE_DIR):
        return []
    return sorted(
        a for a in os.listdir(STATE_DIR)
        if os.path.isfile(os.path.join(STATE_DIR, a, "cron-execution.log")))


def audit():
    now = now_utc()
    since = now - timedelta(hours=LOOKBACK_HOURS)
    gaps = []  # (agent, cron, streak, total_closed)
    checked = 0
    for agent in discover_agents():
        fires = load_fires(agent, since)
        if not fires:
            continue
        event_times = load_event_times(agent, since, now)
        for cron, flist in fires.items():
            checked += 1
            streak, total = trailing_silent_streak(flist, event_times, now)
            if streak >= SILENT_STREAK_FLAG:
                gaps.append((agent, cron, streak, total))
    return now, checked, gaps


def log_line(text):
    try:
        with open(WATCHDOG_LOG, "a", encoding="utf-8") as fh:
            fh.write(text + "\n")
    except OSError as e:
        print("WARN: could not write watchdog log: %s" % e, file=sys.stderr)


def emit_bus_event(agent, cron, streak):
    _emit("cron_effectiveness_gap",
          {"agent": agent, "cron": cron, "silent_fires": streak,
           "window_min": WINDOW_MIN, "detected_by": "cron-effectiveness-audit"})


def emit_overdue_event(agent, cron, age_days, never_fired):
    _emit("cron_overdue_gap",
          {"agent": agent, "cron": cron, "days_since_last_fire": age_days,
           "never_fired": never_fired, "detected_by": "cron-effectiveness-audit"})


def _emit(event, payload):
    if not BUS_ENABLED:
        return
    meta = json.dumps(payload)
    # The `cortextos` CLI is an npm shim (.cmd on Windows); CreateProcess won't resolve
    # it without a shell, so go through the shell. Python's shell=True uses cmd.exe on
    # Windows even when launched from Git Bash, so escape the JSON's quotes as \" .
    # category "monitoring" (spec wording) is not a valid bus category; the valid set is
    # action/error/metric/milestone/heartbeat/message/task/approval — a silent-cron finding
    # is a monitoring metric. Severity must be info/warning/error/critical (not "warn").
    if os.name == "nt":
        cmd = ('cortextos bus log-event metric %s warning '
               '--meta "%s"' % (event, meta.replace('"', '\\"')))
    else:
        import shlex
        cmd = ("cortextos bus log-event metric %s warning "
               "--meta %s" % (event, shlex.quote(meta)))
    try:
        subprocess.run(cmd, shell=True, check=False, capture_output=True, timeout=30)
    except (OSError, subprocess.SubprocessError) as e:
        print("WARN: bus log-event failed: %s" % e, file=sys.stderr)


def run(quiet=False):
    now, checked, gaps = audit()
    overdue = audit_overdue(now)
    ts = now.strftime("%Y-%m-%dT%H:%MZ")
    parts = []
    if gaps:
        detail = ", ".join("%s/%s (%d silent fires)" % (a, c, s) for a, c, s, _ in gaps)
        parts.append("%d GAP(s) — %s" % (len(gaps), detail))
        for agent, cron, streak, _ in gaps:
            emit_bus_event(agent, cron, streak)
    if overdue:
        detail = ", ".join(
            "%s/%s (%s, %.1fd since %s)" % (a, c, "NEVER FIRED" if nf else "stalled", d,
                                            "creation" if nf else "last fire")
            for a, c, d, nf in overdue)
        parts.append("%d OVERDUE — %s" % (len(overdue), detail))
        for agent, cron, age_days, never_fired in overdue:
            emit_overdue_event(agent, cron, age_days, never_fired)
    if parts:
        line = "[%s] cron-effectiveness-audit: %s" % (ts, "; ".join(parts))
    else:
        line = "[%s] cron-effectiveness-audit: CLEAN (%d crons checked, all fires productive within %dmin, none overdue)" % (
            ts, checked, WINDOW_MIN)
    log_line(line)
    if not quiet:
        print(line)
    return 0


# --------------------------------------------------------------------------- #
# self-test: synthetic fixtures in a temp dir, deterministic now, bus off.
# --------------------------------------------------------------------------- #
def self_test():
    import tempfile
    import shutil
    tmp = tempfile.mkdtemp(prefix="cronaudit-")
    try:
        state = os.path.join(tmp, "state")
        events = os.path.join(tmp, "events")
        wlog = os.path.join(tmp, "watchdog.log")
        NOW = "2026-06-30T12:00:00Z"
        now = parse_ts(NOW)

        def write_jsonl(path, rows):
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as fh:
                for r in rows:
                    fh.write(json.dumps(r) + "\n")

        # agent BROKEN: heartbeat fired 4x (every 2h), zero events -> silent streak 4
        broken_fires = [now - timedelta(hours=h) for h in (8, 6, 4, 2)]
        write_jsonl(os.path.join(state, "broken", "cron-execution.log"),
                    [{"ts": f.strftime("%Y-%m-%dT%H:%M:%SZ"), "cron": "heartbeat",
                      "status": "fired", "attempt": 1, "error": None} for f in broken_fires])
        # no event files for broken

        # agent HEALTHY: same fires, each followed by an event 5min later
        write_jsonl(os.path.join(state, "healthy", "cron-execution.log"),
                    [{"ts": f.strftime("%Y-%m-%dT%H:%M:%SZ"), "cron": "heartbeat",
                      "status": "fired", "attempt": 1, "error": None} for f in broken_fires])
        ev = []
        for f in broken_fires:
            e = f + timedelta(minutes=5)
            ev.append({"agent": "healthy", "timestamp": e.strftime("%Y-%m-%dT%H:%M:%SZ"),
                       "event": "heartbeat"})
        # events may span two dates; group by date
        by_date = {}
        for e in ev:
            by_date.setdefault(parse_ts(e["timestamp"]).date().isoformat(), []).append(e)
        for d, rows in by_date.items():
            write_jsonl(os.path.join(events, "healthy", d + ".jsonl"), rows)

        # agent RECOVERED: 3 silent then most-recent fire productive -> streak 0, no flag
        write_jsonl(os.path.join(state, "recovered", "cron-execution.log"),
                    [{"ts": f.strftime("%Y-%m-%dT%H:%M:%SZ"), "cron": "heartbeat",
                      "status": "fired", "attempt": 1, "error": None} for f in broken_fires])
        last = broken_fires[-1] + timedelta(minutes=5)
        write_jsonl(os.path.join(events, "recovered", last.date().isoformat() + ".jsonl"),
                    [{"agent": "recovered", "timestamp": last.strftime("%Y-%m-%dT%H:%M:%SZ"),
                      "event": "heartbeat"}])

        os.environ["CRON_AUDIT_STATE_DIR"] = state
        os.environ["CRON_AUDIT_EVENTS_DIRS"] = events
        os.environ["CRON_AUDIT_WATCHDOG_LOG"] = wlog
        os.environ["CRON_AUDIT_NOW"] = NOW
        os.environ["CRON_AUDIT_BUS"] = "off"
        # reload module-level config that reads env at import-time
        global STATE_DIR, EVENTS_DIRS, WATCHDOG_LOG, BUS_ENABLED
        STATE_DIR, EVENTS_DIRS, WATCHDOG_LOG, BUS_ENABLED = state, [events], wlog, False

        _, checked, gaps = audit()
        flagged = {(a, c) for a, c, _, _ in gaps}

        assert ("broken", "heartbeat") in flagged, "broken cron must flag, got %s" % flagged
        assert ("healthy", "heartbeat") not in flagged, "healthy cron must NOT flag"
        assert ("recovered", "heartbeat") not in flagged, "recovered cron must NOT flag (trailing streak 0)"
        broken_streak = next(s for a, c, s, _ in gaps if a == "broken")
        assert broken_streak == 4, "broken streak should be 4, got %d" % broken_streak
        # the just-fired-but-window-open case is excluded: add a fire 10min ago, no event
        assert checked >= 3, "should have checked >=3 crons, got %d" % checked

        # --- overdue check fixtures ---
        def iso(dt):
            return dt.strftime("%Y-%m-%dT%H:%M:%SZ")
        stale_crons = {"crons": [
            # never fired, 7d interval, created 20d ago -> FLAG (the real-world bug)
            {"name": "dead-weekly", "schedule": "7d", "enabled": True,
             "created_at": iso(now - timedelta(days=20))},
            # daily cron fired 2h ago -> clean
            {"name": "fresh-daily", "schedule": "0 8 * * *", "enabled": True,
             "created_at": iso(now - timedelta(days=60)),
             "last_fired_at": iso(now - timedelta(hours=2))},
            # daily cron stalled 5d -> FLAG
            {"name": "stalled-daily", "schedule": "0 8 * * *", "enabled": True,
             "created_at": iso(now - timedelta(days=60)),
             "last_fired_at": iso(now - timedelta(days=5))},
            # disabled + ancient -> clean (skipped)
            {"name": "disabled-old", "schedule": "24h", "enabled": False,
             "created_at": iso(now - timedelta(days=90))},
            # month-restricted (seasonal) never fired -> clean (unjudgeable)
            {"name": "tax-jan", "schedule": "0 8 5 1,2 *", "enabled": True,
             "created_at": iso(now - timedelta(days=90))},
        ]}
        os.makedirs(os.path.join(state, "staleagent"), exist_ok=True)
        with open(os.path.join(state, "staleagent", "crons.json"), "w", encoding="utf-8") as fh:
            json.dump(stale_crons, fh)

        overdue = audit_overdue(now)
        oflag = {(a, c): nf for a, c, _, nf in overdue}
        assert ("staleagent", "dead-weekly") in oflag and oflag[("staleagent", "dead-weekly")] is True, \
            "never-fired 7d cron must flag as never_fired, got %s" % oflag
        assert ("staleagent", "stalled-daily") in oflag and oflag[("staleagent", "stalled-daily")] is False, \
            "stalled daily cron must flag as stalled, got %s" % oflag
        assert ("staleagent", "fresh-daily") not in oflag, "fresh daily must NOT flag"
        assert ("staleagent", "disabled-old") not in oflag, "disabled cron must NOT flag"
        assert ("staleagent", "tax-jan") not in oflag, "month-restricted cron must NOT flag"

        print("self-test OK: flagged=%s checked=%d broken_streak=%d overdue=%s" % (
            flagged, checked, broken_streak, sorted(oflag)))
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        sys.exit(self_test())
    sys.exit(run(quiet="--quiet" in sys.argv))
