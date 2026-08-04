#!/usr/bin/env python3
"""bus-write — pass example-bearing text to the bus with NO SHELL IN THE PATH.

WHY THIS EXISTS. Four independent incidents in one day, across two agents:

  * builder_1, 00:10Z — `--desc "$(cat <missing-file>)"` produced an empty string, the CLI accepted
    it, and 3,991 characters of task description were destroyed by a command that printed
    "Updated <id> -> pending" and nothing else.
  * seb_boss, ~02:1xZ — backticks inside a double-quoted `--desc` were substituted by bash into three
    description segments, and ONE OF THEM EMITTED A REAL cron_completed EVENT INTO THE LIVE STORE.
  * builder_1, 18:3xZ — the same backtick trap, while filing a task ABOUT silent failures. The
    description landed with its subject deleted.
  * builder_1, 00:06Z — `/tmp` written by bash is not the `/tmp` a native node reads.

TREATING THIS AS CARELESSNESS IS WHY IT KEEPS HAPPENING (seb_boss, and he is right). Four occurrences
in the two lanes that spent the day writing rules about silent failure is not inattention, it is a
bad arrangement: **passing prose through a double-quoted shell string is a trap that fires on
CONTENT** — and the content most likely to trip it is a command example, which is exactly what a task
about a CLI defect contains. Same family as the $-digit truncation rule.

SO THE FIX IS NOT A HABIT. IT REMOVES THE SHELL FROM THE PATH, so no author has to notice that their
own text contains a backtick, a `$(`, or a `!`.

  python scripts/bus-write.py update-task <id> <status> --desc-file work/foo.md
  python scripts/bus-write.py update-task <id> <status> --evidence-file work/bar.md
  python scripts/bus-write.py create-task "the title, positional" --desc-file work/baz.md [--priority high]

TEXT ALWAYS COMES FROM A FILE, NEVER FROM ARGV. That is the whole design: a file has no quoting
semantics, and the bytes that reach the CLI are the bytes on disk.

EXIT 0 written · EXIT 2 refused (the guard fired) · EXIT 3 could not run.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
# `cortextos` IS A .cmd ON WINDOWS AND subprocess CANNOT EXEC IT with shell=False — Node has refused
# that since the CVE-2024-27980 fix, and going through shell=True would put back the exact shell this
# file exists to remove. So invoke the real entrypoint with a real interpreter.
CLI = [sys.executable and 'node', str(REPO / 'dist' / 'cli.js')]


def task_path(task_id):
    root = os.environ.get('CTX_ROOT') or str(Path.home() / '.cortextos' / 'default')
    org = os.environ.get('CTX_ORG') or 'SEB_company'
    return Path(root.replace('\\', '/')) / 'orgs' / org / 'tasks' / f'{task_id}.json'


def existing_description(task_id):
    p = task_path(task_id)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text('utf8')).get('description') or ''
    except Exception:
        return None


def check_shrink(new_text, old_text):
    """(ok, reason). An append that SHRINKS the field is always a bug."""
    if old_text is None:
        return True, 'no existing description could be read, so no comparison was possible'
    if not new_text.strip():
        return False, 'the composed text is empty or whitespace — this is the 3,991-character failure exactly'
    if len(new_text) < len(old_text):
        return False, (f'the composed text is SHORTER than what is stored ({len(new_text)} < {len(old_text)}). '
                       f'An append that shrinks the field is always a bug. If the shrink is deliberate, '
                       f'edit the file to include the existing text and re-run.')
    return True, f'{len(old_text)} -> {len(new_text)} chars'


def _usage_matches_cli():
    """Every `--flag` in the docstring usage block must appear in that subcommand's --help.

    `-file` flags are OURS and are stripped before forwarding, so they are exempt by construction.
    """
    import re
    lines = [l.strip() for l in (__doc__ or '').splitlines() if l.strip().startswith('python scripts/bus-write.py')]
    if not lines:
        return False
    for line in lines:
        toks = line.split()
        sub = toks[2] if len(toks) > 2 else None
        if not sub or sub.startswith('-'):
            return False
        flags = {f.strip('[]') for f in re.findall(r'--[a-z-]+', line)}
        flags = {f for f in flags if not f.endswith('-file')}
        if not flags:
            continue
        r = subprocess.run(CLI + ['bus', sub, '--help'], cwd=str(REPO), capture_output=True, text=True)
        help_text = (r.stdout or '') + (r.stderr or '')
        for f in flags:
            if f not in help_text:
                print(f'     usage documents {f} for `{sub}`, CLI help does not list it')
                return False
    return True


def _self_test():
    cases = [
        ('an empty composed text is refused', lambda: check_shrink('', 'abc')[0] is False),
        ('a whitespace-only composed text is refused', lambda: check_shrink('   \n ', 'abc')[0] is False),
        ('a SHORTER composed text is refused', lambda: check_shrink('ab', 'abcdef')[0] is False),
        # PAIRED NEGATIVE: without it, "refuse everything" passes all three above.
        ('a LONGER composed text is allowed', lambda: check_shrink('abcdefg', 'abcdef')[0] is True),
        # EQUAL LENGTH IS ALLOWED ON PURPOSE: a same-length correction (a typo fix, a reworded clause)
        # is legitimate, and refusing it would push authors back to the shell to get around the guard.
        ('an EQUAL-length composed text is allowed', lambda: check_shrink('abcdef', 'abcdef')[0] is True),
        # An unreadable existing description must NOT block the write — the guard is a safety net, and
        # a net that refuses when it cannot see is a net that stops all work on its first bad day.
        ('an unreadable existing description does not block', lambda: check_shrink('abc', None)[0] is True),
        # THE USAGE BLOCK MUST MATCH THE INTERFACE IT DOCUMENTS. seb_boss adopted this file within the
        # hour and the FIRST LINE HE COPIED FAILED: the docstring advertised `create-task --title`, and
        # create-task takes the title POSITIONALLY. 6/6 plus a byte-fidelity probe both exercised
        # update-task, so THE GREEN COUNT AND THE PROBE AGREED WITH EACH OTHER AND NEITHER TOUCHED THE
        # PATH — and a pass-through forwarder cannot validate the command it forwards, so a wrong flag
        # surfaces only at the CLI, only for whoever runs that subcommand.
        #
        # This case asks the CLI itself rather than trusting the prose, so the two cannot drift apart
        # silently again. It is the same defect class the docstring exists to route around: the tool
        # built to dodge a CLI vocabulary trap acquired one of its own.
        ('every flag in the usage block exists in the CLI help for its subcommand', _usage_matches_cli),
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
    print(f'bus-write --self-test: {len(cases) - failed}/{len(cases)}')
    print('BOUNDARY: this proves the SHRINK GUARD and that the usage block matches the CLI. It does')
    print('NOT prove that no shell touches the text — that is a property of the argv list below and is')
    print('observable only by passing backtick-bearing content and confirming the stored bytes match.')
    print('Proven that way separately by builder_1 and reproduced independently by seb_boss.')
    return 0 if failed == 0 else 2


def main(argv):
    if '--self-test' in argv:
        return _self_test()
    if not argv:
        print(__doc__.strip().splitlines()[-6], file=sys.stderr)
        return 3
    if not (REPO / 'dist' / 'cli.js').exists():
        print(f'COULD-NOT-RUN: no dist/cli.js under {REPO}', file=sys.stderr)
        return 3

    args, text_flag, text_file = [], None, None
    it = iter(range(len(argv)))
    i = 0
    while i < len(argv):
        a = argv[i]
        if a.endswith('-file'):
            text_flag, text_file = '--' + a[2:-5], argv[i + 1]
            i += 2
            continue
        args.append(a)
        i += 1

    if text_flag is None:
        print('COULD-NOT-RUN: no --<opt>-file given. Text must come from a file, never from argv.',
              file=sys.stderr)
        return 3
    p = Path(text_file)
    if not p.exists():
        # THE FAILURE THAT STARTED ALL OF THIS: a missing file became an empty string and the write
        # went through. Here it is a refusal, before anything is sent.
        print(f'REFUSED: text file does not exist: {text_file}. This is exactly the substitution that '
              f'destroyed 3,991 characters — a missing file must never become an empty write.',
              file=sys.stderr)
        return 2
    text = p.read_text('utf8')

    if text_flag == '--desc' and len(args) >= 2 and args[0] == 'update-task':
        ok, reason = check_shrink(text, existing_description(args[1]))
        print(f'shrink guard: {reason}')
        if not ok:
            print('REFUSED.', file=sys.stderr)
            return 2

    cmd = CLI + ['bus'] + args + [text_flag, text]
    r = subprocess.run(cmd, cwd=str(REPO), capture_output=True, text=True)
    sys.stdout.write(r.stdout)
    sys.stderr.write(r.stderr)
    return r.returncode


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
