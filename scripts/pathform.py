#!/usr/bin/env python3
"""pathform - accept a file path in EITHER form and return one that opens.

WHY THIS EXISTS. Bash on this box takes /c/Users/..., Windows-native python takes
C:/Users/.... Handing the wrong form across the boundary raises FileNotFoundError on a
file that demonstrably exists and was read seconds earlier by the other language.

THREE INSTANCES IN NINETY MINUTES, TWO AGENTS, NEITHER NEW TO THIS BOX: seb_boss on a
/tmp procs.csv, builder_1 at 00:06Z (the root cause behind a 3,991-character task
description being destroyed), seb_boss again while VERIFYING that fix. Nobody was
careless in any of the three, which is the whole argument: a rule saying "remember which
form python wants" IS THE THING THAT ALREADY FAILED THREE TIMES. This makes the error
impossible rather than infrequent.

SHARPEST CONSEQUENCE, AND THE REASON IT IS NOT COSMETIC: A VERIFICATION TOOL FAILING
INTO THE SHAPE OF THE THING IT VERIFIES. The third instance was a retained-input check
reporting a missing file, which is indistinguishable from the input actually being lost.
The instrument built to prove nothing was lost can manufacture the exact evidence that
something was.

    from pathform import resolve
    open(resolve(p), encoding="utf-8")

    python pathform.py --self-test
"""
import os
import re
import sys

__all__ = ["forms", "resolve"]


def forms(p):
    """Every plausible spelling of `p`, original first. Pure string work, no I/O."""
    p = str(p)
    out = [p]
    # MSYS -> Windows:  /c/Users/x  ->  C:/Users/x
    m = re.match(r"^/([A-Za-z])/(.*)$", p)
    if m:
        out.append(f"{m.group(1).upper()}:/{m.group(2)}")
    # Windows -> MSYS:  C:\Users\x or C:/Users/x  ->  /c/Users/x
    m = re.match(r"^([A-Za-z]):[\\/](.*)$", p)
    if m:
        out.append("/" + m.group(1).lower() + "/" + m.group(2).replace("\\", "/"))
    # Backslashes alone, no drive letter.
    if "\\" in p:
        out.append(p.replace("\\", "/"))
    seen, uniq = set(), []
    for c in out:
        if c not in seen:
            seen.add(c)
            uniq.append(c)
    return uniq


def resolve(p, must_exist=True):
    """Return the first spelling of `p` that exists.

    RAISES ON A GENUINELY ABSENT PATH, and that is not a detail. A helper that only ever
    succeeds would have fixed the false negative by making a real missing file INVISIBLE
    — strictly worse than the bug it replaces, and it would pass every positive case
    above. The error names every form tried, because a raise that hides what it looked
    for is as uninformative as the FileNotFoundError it replaces.
    """
    tried = forms(p)
    for cand in tried:
        if os.path.exists(cand):
            return cand
    if not must_exist:
        return tried[0]
    raise FileNotFoundError(
        f"no form of {p!r} exists; tried: " + ", ".join(repr(t) for t in tried))


def _self_test():
    import tempfile
    fd, win = tempfile.mkstemp(suffix="-pathform.txt")
    os.write(fd, b"ok")
    os.close(fd)
    win = win.replace("\\", "/")
    m = re.match(r"^([A-Za-z]):/(.*)$", win)
    assert m, win
    msys = "/" + m.group(1).lower() + "/" + m.group(2)
    failed = 0
    try:
        cases = [
            # The two forms this language is handed in practice. THE MSYS ONE IS THE
            # CASE THAT FAILS TODAY — a test using only the Windows form proves nothing,
            # which is precisely how this survived three occurrences.
            ("windows form opens", lambda: open(resolve(win)).read() == "ok"),
            ("MSYS form opens", lambda: open(resolve(msys)).read() == "ok"),
            ("backslash form opens", lambda: open(resolve(win.replace("/", "\\"))).read() == "ok"),
            ("both forms resolve to the SAME file", lambda: os.path.samefile(resolve(win), resolve(msys))),
            # NEGATIVE. Without this the helper could return its input unchanged and pass
            # every case above while making a real missing file invisible.
            ("a genuinely absent path still RAISES", _absent_raises),
            ("the raise NAMES the forms it tried", _raise_names_forms),
            ("must_exist=False returns rather than raising", lambda: resolve("/c/no/such", must_exist=False) == "/c/no/such"),
        ]
        for name, fn in cases:
            try:
                ok = fn() is True
            except Exception:
                ok = False
            failed += 0 if ok else 1
            print(("ok   " if ok else "FAIL ") + name)
    finally:
        os.unlink(win)
    print()
    print(f"pathform --self-test: {len(cases) - failed}/{len(cases)}")
    print("BOUNDARY: proves both forms open FROM PYTHON. The node twin (pathform.mjs) "
          "covers the other language; the four-combination claim needs BOTH run.")
    return failed == 0


def _absent_raises():
    try:
        resolve("/c/Users/definitely-not-here-4a7f/x.txt")
    except FileNotFoundError:
        return True
    return False


def _raise_names_forms():
    try:
        resolve("/c/Users/definitely-not-here-4a7f/x.txt")
    except FileNotFoundError as e:
        return "C:/Users/definitely-not-here-4a7f/x.txt" in str(e)
    return False


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        sys.exit(0 if _self_test() else 2)
    if len(sys.argv) > 1:
        print(resolve(sys.argv[1]))
    else:
        print(__doc__.strip().splitlines()[0])
