"""Behavioral tests for local (no-Gemini) text embedding.

task_1786672430694 (2026-08-14): GEMINI_API_KEY access broke (403
PERMISSION_DENIED, no valid key in Sebastian's AI Studio account), blocking
kb-ingest for 11+ agents since ~08-11. Sebastian approved dropping Gemini for
text embedding entirely rather than waiting on a key.

Run from knowledge-base/scripts:

    python -m _test_clients.test_local_embedding

Exits 0 on all-pass, 1 on any failure.

MUST-FAIL CASE (proven red against the pre-fix code before this file existed,
via git stash — see implementation notes): with GEMINI_API_KEY unset,
get_api_key() used to sys.exit(1) unconditionally, so a plain-text-only
kb-ingest run (the ONLY thing heartbeat step 10 ever does) could not start at
all. get_api_key() now returns None instead, and embed_content() never
touches Gemini for plain text.

PAIRED NEGATIVE: multimodal content (a list, not a string) with no client
configured must still fail LOUDLY and specifically -- dropping Gemini for
text must not silently make multimodal ingestion look like it's "working"
when it has no way to actually embed anything.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)

import mmrag


FAILURES = []


def _check(label, cond, detail=""):
    if cond:
        print(f"  PASS  {label}")
    else:
        print(f"  FAIL  {label}: {detail}")
        FAILURES.append(label)


def test_no_api_key_does_not_crash():
    print("\n[test 1/5] MUST-FAIL CASE: get_api_key() with no key configured returns None, does not exit")
    saved = os.environ.pop("GEMINI_API_KEY", None)
    try:
        key = mmrag.get_api_key({})
        _check("get_api_key returns None rather than sys.exit(1)", key is None, detail=f"got {key!r}")
        client = mmrag.get_genai_client(key)
        _check("get_genai_client(None) returns None rather than raising", client is None, detail=f"got {client!r}")
    finally:
        if saved is not None:
            os.environ["GEMINI_API_KEY"] = saved


def test_plain_text_embeds_locally_with_no_client():
    print("\n[test 2/5] plain text embeds with client=None -- no Gemini call, no key needed at all")
    vec = mmrag.embed_content(None, {}, "hello from a real memory file")
    _check("returns a list", isinstance(vec, list), detail=f"got {type(vec)}")
    _check("384 dimensions (local MiniLM)", len(vec) == 384, detail=f"got {len(vec)}")
    _check("every element is a plain python float (JSON-serializable)",
           all(isinstance(x, float) for x in vec))


def test_local_embedding_is_semantically_real():
    print("\n[test 3/5] DISCRIMINATING PAIR: similar text embeds closer than unrelated text (not a stub returning zeros/random)")
    def cos_sim(a, b):
        dot = sum(x * y for x, y in zip(a, b))
        na = sum(x * x for x in a) ** 0.5
        nb = sum(x * x for x in b) ** 0.5
        return dot / (na * nb)

    a = mmrag.embed_content(None, {}, "the cron scheduler fires every six hours")
    b = mmrag.embed_content(None, {}, "the scheduled job runs on a six hour interval")
    c = mmrag.embed_content(None, {}, "chocolate chip cookies need butter and sugar")

    sim_related = cos_sim(a, b)
    sim_unrelated = cos_sim(a, c)
    _check(
        "related sentences score higher than unrelated ones",
        sim_related > sim_unrelated,
        detail=f"related={sim_related:.3f} unrelated={sim_unrelated:.3f}",
    )
    _check("not degenerate (related score well above 0)", sim_related > 0.3, detail=f"{sim_related:.3f}")


def test_multimodal_without_client_fails_loudly():
    print("\n[test 4/5] PAIRED NEGATIVE: multimodal content (a list) with client=None fails loudly, not silently")
    raised = None
    try:
        mmrag.embed_content(None, {}, ["a description", "fake-bytes-part"])
    except RuntimeError as e:
        raised = e
    _check("raises RuntimeError rather than silently returning something", raised is not None)
    if raised is not None:
        _check("error names the actual cause (Gemini client missing)",
               "Gemini" in str(raised), detail=str(raised))


def test_tracker_contract_preserved():
    print("\n[test 5/5] receipt/verdict contract: track_embedding still runs on every local embed (nonzero token proxy for real content)")
    mmrag._tracker = mmrag.UsageTracker("test")
    before = mmrag._tracker.session["embedding_calls"]
    mmrag.embed_content(None, {}, "a reasonably long sentence with several words in it")
    after = mmrag._tracker.session["embedding_calls"]
    _check("embedding_calls incremented", after == before + 1, detail=f"{before} -> {after}")
    _check(
        "embedding_tokens is nonzero for real content (kb-ingest-receipt.mjs reads this; "
        "Tokens:0 is a real FINDING, not just cosmetic)",
        mmrag._tracker.session["embedding_tokens"] > 0,
        detail=str(mmrag._tracker.session["embedding_tokens"]),
    )
    mmrag._tracker = None


if __name__ == "__main__":
    test_no_api_key_does_not_crash()
    test_plain_text_embeds_locally_with_no_client()
    test_local_embedding_is_semantically_real()
    test_multimodal_without_client_fails_loudly()
    test_tracker_contract_preserved()
    print()
    if FAILURES:
        print(f"FAILED: {len(FAILURES)} assertion(s)")
        for f in FAILURES:
            print(f"  - {f}")
        sys.exit(1)
    print("ALL PASS (5 scenarios)")
    sys.exit(0)
