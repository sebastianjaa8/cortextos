#!/usr/bin/env python3
"""cron-flag-drift — do the CLI flags written into cron prompts actually exist?

A CRON PROMPT IS DOCUMENTATION THAT EXECUTES (seb_boss, 2026-08-03). It has the same defect surface
as a usage block in a docstring — commands written by hand, never validated against the CLI, wrong
only for whoever runs that one cron. THE DIFFERENCE IS THE COST: a wrong flag in a docstring costs an
adopter five minutes; A WRONG FLAG IN A CRON PROMPT FIRES UNATTENDED AT 3AM AND PRODUCES A RECEIPT
SAYING SOMETHING RAN.

Provenance: builder_1's bus-write docstring advertised `create-task --title`, which does not exist —
create-task takes the title positionally. seb_boss adopted the file and THE FIRST LINE HE COPIED
FAILED. The self-test that followed asks the CLI rather than trusting the prose; this file points the
same question at ~40 hand-written cron prompts that nobody has ever checked against `--help`.

  python scripts/cron-flag-drift.py [--agent <name>]

EXIT 0 no mismatch · EXIT 2 at least one flag does not exist · EXIT 3 could not run.
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CLI = ['node', str(REPO / 'dist' / 'cli.js')]

# `cortextos bus <sub>` followed by its arguments, stopping at a shell operator or a newline. Flags
# after a pipe belong to grep/awk, not to the bus, and counting them would manufacture findings.
#
# THE ARGUMENT REGION MUST STOP AT THE NEXT INVOCATION, and the first version did not. Without the
# lookahead below, `cortextos bus check-inbox then cortextos bus update-heartbeat --x` attributed
# `--x` to check-inbox — A FLAG CHARGED TO THE WRONG SUBCOMMAND, which manufactures a mismatch on a
# correct prompt and hides a real one on the command that owns the flag. Caught by the two-invocation
# self-test case going red BEFORE the fleet numbers were reported; the fleet run had already printed
# 7 mismatches from the miswired extractor.
#
# THE FIRST FIX WAS HALF A FIX AND SHIPPED A CONFIDENT NUMBER. Stopping at the next `cortextos bus`
# leaves the region running through EVERY OTHER COMMAND, and bus calls sit beside git, python, node
# and bash constantly. seb_boss's weekly-agent-loop-scan reads:
#     ... (cortextos bus list-tasks), git log --since='7 days ago' --oneline across ...
# and BOTH GIT FLAGS WERE CHARGED TO list-tasks, two commands and a closing paren away. 4 false
# positives became 2, not 0 — the same misattribution wearing a different neighbour.
#
# So the region ends at a COMMAND BOUNDARY: a closing paren, comma, semicolon, pipe, ampersand,
# newline, or the start of any other known command word.
_NEXT_CMD = r'cortextos\s+bus|\bgit\b|\bpython3?\b|\bnode\b|\bnpm\b|\bnpx\b|\bbash\b|\bsh\b|\bgrep\b|\bawk\b|\bsed\b|\bcurl\b|\bjq\b|\bobsidian\b'
_INVOCATION = re.compile(
    rf'cortextos\s+bus\s+([a-z][a-z0-9-]*)((?:(?!{_NEXT_CMD})[^\n|;&,)])*)', re.I)
_FLAG = re.compile(r'(?<![\w-])--[a-z][a-z0-9-]*')


def strip_quoted(s):
    """Remove quoted payloads.

    A FLAG INSIDE A QUOTED ARGUMENT IS CONTENT, NOT AN OPTION — `send-message x normal 'use --force'`
    references no option. Same structural rule as the msys path guard: classify on position, not on
    the presence of a token, or the checker fires on every prompt that DISCUSSES a flag. The prompts
    most likely to mention flags are the ones documenting them.
    """
    s = re.sub(r"'[^']*'", " ", s)
    s = re.sub(r'"[^"]*"', " ", s)
    return s


def extract(prompt):
    """[(subcommand, {flags})] referenced in this prompt."""
    out = []
    for m in _INVOCATION.finditer(str(prompt or '')):
        sub, rest = m.group(1), strip_quoted(m.group(2))
        flags = set(_FLAG.findall(rest))
        out.append((sub, flags))
    return out


def help_text(sub, cache={}):
    if sub not in cache:
        try:
            r = subprocess.run(CLI + ['bus', sub, '--help'], cwd=str(REPO),
                               capture_output=True, text=True, timeout=60)
            cache[sub] = ((r.stdout or '') + (r.stderr or ''), r.returncode)
        except Exception as e:
            cache[sub] = ('', f'ERROR {e}')
    return cache[sub]


def _self_test():
    cases = [
        ('a plain invocation yields its subcommand and flags', lambda:
            extract('run cortextos bus list-tasks --agent builder_1 --status pending') ==
            [('list-tasks', {'--agent', '--status'})]),
        # THE FALSE-POSITIVE CLASS THIS CHECK WOULD DIE OF. Prompts that DOCUMENT a flag mention it in
        # prose; counting those makes every well-written prompt the worst offender.
        ('a flag inside a QUOTED payload is content, not an option', lambda:
            extract("cortextos bus send-message seb_boss normal 'remember to pass --force here'") ==
            [('send-message', set())]),
        # Flags after a pipe belong to the next command in the pipeline.
        ('flags after a PIPE are not attributed to the bus subcommand', lambda:
            extract('cortextos bus list-tasks | grep --color foo') == [('list-tasks', set())]),
        ('two invocations in one prompt are both found', lambda:
            len(extract('cortextos bus check-inbox then cortextos bus update-heartbeat --x')) == 2),
        # PAIRED NEGATIVE for the whole extractor: without it, "return nothing" passes everything above
        # that asserts an empty flag set.
        ('a real flag IS still extracted when unquoted', lambda:
            extract('cortextos bus kb-ingest ./MEMORY.md --org SEB_company --force')[0][1] ==
            {'--org', '--force'}),
        ('prose with no invocation yields nothing', lambda:
            extract('remember that --force re-embeds everything') == []),
        # THE TWO REAL FALSE POSITIVES, VERBATIM FROM THE PROMPTS THAT PRODUCED THEM. Both were
        # reported as findings to their owners and both owners refuted them from source — seb_boss on
        # git's flags, pm_bot on a `then`-chained python3. A neighbouring command's flags were charged
        # to the bus subcommand across a paren, a comma, and a chain word.
        ('seb_boss weekly-agent-loop-scan: GIT flags are not list-tasks flags', lambda:
            extract("Pull last 7 days (cortextos bus list-tasks), git log --since='7 days ago' "
                    "--oneline across repos") == [('list-tasks', set())]),
        ('pm_bot pm-pulse: a THEN-chained python3 flag is not a list-tasks flag', lambda:
            extract('cortextos bus list-tasks --agent pm_bot --format json > "x" then python3 '
                    '"pulse-prepass.py" --tasks-in "y"') ==
            [('list-tasks', {'--agent', '--format'})]),
    ]
    failed = 0
    for name, fn in cases:
        try:
            ok = fn() is True
        except Exception:
            ok = False
        failed += 0 if ok else 1
        print(('ok   ' if ok else 'FAIL ') + name)
    print('')
    print(f'cron-flag-drift --self-test: {len(cases) - failed}/{len(cases)}')
    print('BOUNDARY: this proves the EXTRACTOR. It cannot see a command described in prose rather than')
    print('written literally, and it does not check positional arguments — only flags. Every count it')
    print('prints is over CHECKABLE invocations, never over everything a prompt might run.')
    return 0 if failed == 0 else 2


def main(argv):
    if '--self-test' in argv:
        return _self_test()
    root = os.environ.get('CTX_ROOT') or str(Path.home() / '.cortextos' / 'default')
    base = Path(root.replace('\\', '/')) / '.cortextOS' / 'state' / 'agents'
    if not base.is_dir():
        print(f'VERDICT: COULD-NOT-RUN — no agent state dir at {base}')
        return 3
    only = None
    if '--agent' in argv:
        only = argv[argv.index('--agent') + 1]

    findings, crons_seen, invocations, agents_seen, subs = [], 0, 0, 0, set()
    flags_checked = 0
    for d in sorted(os.listdir(base)):
        if only and d != only:
            continue
        p = base / d / 'crons.json'
        if not p.exists():
            continue
        try:
            crons = json.loads(p.read_text('utf8')).get('crons', [])
        except Exception:
            continue
        agents_seen += 1
        for c in crons:
            crons_seen += 1
            for sub, flags in extract(c.get('prompt', '')):
                invocations += 1
                subs.add(sub)
                text, rc = help_text(sub)
                if not text:
                    findings.append((d, c.get('name'), sub, None,
                                     f'`bus {sub} --help` produced nothing (rc={rc}) — the SUBCOMMAND may not exist'))
                    continue
                for f in sorted(flags):
                    flags_checked += 1
                    if f not in text:
                        findings.append((d, c.get('name'), sub, f, 'flag not listed in --help'))

    for a, cron, sub, f, why in findings:
        print(f'  MISMATCH  {a}/{cron}: `bus {sub}` {f or ""} — {why}')
    print('')
    # THE FLAG COUNT IS THE REAL DENOMINATOR AND THE INVOCATION COUNT IS NOT. seb_boss ran a narrower
    # version of this check, reported 0 mismatches across 7 subcommands, and dressed it in a
    # denominator — but his regex required flags to follow the subcommand IMMEDIATELY, so it could not
    # have found these even if they were real. A DENOMINATOR TELLS YOU WHAT WAS COUNTED; IT DOES NOT
    # TELL YOU THE COUNTER COULD SEE. A zero over 184 invocations is meaningless if zero flags were
    # extracted from them, so the number of flags actually compared is printed beside it.
    print(f'{len(findings)} mismatch(es) across {flags_checked} flag(s) actually compared, drawn from '
          f'{invocations} checkable invocation(s), {len(subs)} distinct subcommand(s), '
          f'{crons_seen} cron(s), {agents_seen} agent(s).')
    print('THIS IS 0 OF WHAT IS CHECKABLE, NOT 0 OF EVERYTHING. A prompt that DESCRIBES a command in')
    print('prose is invisible here, and positional arguments are not checked at all — only flags')
    print('written literally as `cortextos bus <sub> --flag`. A clean result bounds the flag surface')
    print('and says nothing about the rest.')
    return 2 if findings else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
