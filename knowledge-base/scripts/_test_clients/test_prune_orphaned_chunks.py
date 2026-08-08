"""Behavioral tests for mmrag.prune_orphaned_chunks / ingest_text_file's orphan cleanup.

task_1785777463567_02346145: doc_id = md5(path)_chunkN. Ingest only ever writes chunk0..N-1 for
the CURRENT content -- nothing ever removed the higher indices a longer earlier version left
behind, so a file that SHRINKS kept serving its deleted content forever, attributed to the
still-live path. Demonstrated on a real file: 30 chunks -> 6 chunks, indices 6..29 stayed
retrievable and a query on the removed text returned the current path at score 0.835.

Run from knowledge-base/scripts:

    python -m _test_clients.test_prune_orphaned_chunks

Uses a REAL, isolated temp ChromaDB (MMRAG_CHROMADB_DIR is set before mmrag is imported, so the
module-level CHROMADB_DIR constant picks it up) and stubs embed_content so no real Gemini call
happens -- deterministic, offline, fast, and never touches the live fleet collection.

Exits 0 on all-pass, 1 on any failure.
"""

import os
import sys
import shutil
import tempfile
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)

_TMP_CHROMA_DIR = tempfile.mkdtemp(prefix="mmrag-orphan-test-chroma-")
os.environ["MMRAG_CHROMADB_DIR"] = _TMP_CHROMA_DIR

import mmrag  # noqa: E402  (must import AFTER setting the env var above)

# Stub the embedding call -- deterministic, no network, no API key needed.
mmrag.embed_content = lambda client, config, content, task_type="RETRIEVAL_DOCUMENT": [0.1] * 8

FAILURES = []


def _check(label, cond, detail=""):
    if cond:
        print(f"  PASS  {label}")
    else:
        print(f"  FAIL  {label}: {detail}")
        FAILURES.append(label)


def _fresh_collection(name_hint):
    client = mmrag.get_chroma_client()
    name = f"orphan_test_{name_hint}_{os.urandom(4).hex()}"
    return client.get_or_create_collection(name=name, metadata={"hnsw:space": "cosine"})


def _chunks_for_source(collection, file_path):
    """Every chunk currently stored for this file, keyed by chunk_index."""
    resolved = str(Path(file_path).resolve())
    got = collection.get(where={"source": resolved}, include=["metadatas", "documents"])
    out = {}
    for doc_id, meta, doc in zip(got["ids"], got["metadatas"], got["documents"]):
        out[meta["chunk_index"]] = (doc_id, doc, meta.get("total_chunks"))
    return out


def test_shrink_then_reingest_removes_orphans_keeps_survivors():
    print("\n[test 1/4] MUST-FAIL CASE + PAIRED NEGATIVE: shrink, re-ingest, "
          "orphan gone / survivor intact")
    collection = _fresh_collection("shrink")
    src_dir = tempfile.mkdtemp(prefix="mmrag-orphan-src-")
    try:
        file_path = Path(src_dir) / "shrinking.md"
        config = {"text_chunk_size": 50, "text_chunk_overlap": 0}

        # LONG version: 6 clearly-separated, individually-greppable paragraphs.
        long_paragraphs = [f"MARKER_{i:02d} " + ("x" * 60) for i in range(6)]
        file_path.write_text("\n\n".join(long_paragraphs))

        mmrag.args_force = True
        mmrag.ingest_text_file(None, config, collection, file_path)

        before = _chunks_for_source(collection, file_path)
        _check("first ingest produced multiple chunks", len(before) >= 4,
               f"got {len(before)} chunks — fixture must produce enough to have a real tail")
        highest_idx = max(before)
        orphan_doc_id, orphan_text, _ = before[highest_idx]
        # chunk_size=50 means the highest-index chunk may be pure trailing filler with no marker
        # substring of its own — the real assertion is that it comes from the REMOVED section
        # (anything past MARKER_01, since only paragraphs 0-1 survive the shrink below), not that
        # it literally contains a specific marker string.
        _check("the doomed chunk is from the section that will be removed, not the survivors",
               "MARKER_00" not in orphan_text and "MARKER_01" not in orphan_text,
               orphan_text[:80])

        # SHRINK: keep only the first two paragraphs.
        file_path.write_text("\n\n".join(long_paragraphs[:2]))
        mmrag.ingest_text_file(None, config, collection, file_path)

        after = _chunks_for_source(collection, file_path)
        # MUST-FAIL CASE: the removed portion's chunk must no longer be retrievable at all.
        still_there = collection.get(ids=[orphan_doc_id])
        _check("orphaned chunk id no longer exists in the collection",
               not still_there["ids"],
               f"expected empty, got {still_there['ids']}")
        _check("orphaned chunk index is absent from this source's current chunk set",
               highest_idx not in after,
               f"index {highest_idx} still present: {after.get(highest_idx)}")
        # PAIRED NEGATIVE: content that SURVIVED must still be there, findable by its own marker.
        surviving_texts = " ".join(doc for _id, doc, _t in after.values())
        _check("surviving marker (MARKER_00) is still retrievable",
               "MARKER_00" in surviving_texts, surviving_texts[:120])
        # No extra stale entries beyond the new, smaller set — the fix must not under- or
        # over-delete.
        _check("chunk count after shrink matches the new content exactly, no leftovers",
               len(after) < len(before) and all(i < len(after) for i in after),
               f"before={sorted(before)} after={sorted(after)}")
    finally:
        shutil.rmtree(src_dir, ignore_errors=True)


def test_first_ingest_never_prunes(env=None):
    print("\n[test 2/4] CONTROL: a file's first-ever ingest must not delete anything "
          "(no prior chunk0 to compare against)")
    collection = _fresh_collection("firstrun")
    src_dir = tempfile.mkdtemp(prefix="mmrag-orphan-src2-")
    try:
        file_path = Path(src_dir) / "new-file.md"
        file_path.write_text("MARKER_ONLY " + ("y" * 60))
        mmrag.args_force = True
        old_count = mmrag._prior_chunk_count(collection, file_path)
        _check("_prior_chunk_count reads 0 for a never-ingested file", old_count == 0,
               f"old_count={old_count}")
        pruned = mmrag.prune_orphaned_chunks(collection, file_path, 1, old_count)
        _check("prune_orphaned_chunks is a no-op on a never-ingested file", pruned == 0,
               f"pruned={pruned}")
    finally:
        shutil.rmtree(src_dir, ignore_errors=True)


def test_emptied_file_prunes_every_prior_chunk():
    print("\n[test 3/4] a file emptied to nothing must lose ALL of its prior chunks, not just "
          "the tail past some smaller N")
    collection = _fresh_collection("emptied")
    src_dir = tempfile.mkdtemp(prefix="mmrag-orphan-src3-")
    try:
        file_path = Path(src_dir) / "goes-empty.md"
        config = {"text_chunk_size": 50, "text_chunk_overlap": 0}
        paragraphs = [f"MARKER_{i:02d} " + ("z" * 60) for i in range(4)]
        file_path.write_text("\n\n".join(paragraphs))
        mmrag.args_force = True
        mmrag.ingest_text_file(None, config, collection, file_path)
        before = _chunks_for_source(collection, file_path)
        _check("setup produced real chunks to empty out", len(before) >= 2, len(before))

        file_path.write_text("   \n  ")  # whitespace only -> ingest_text_file's SKIP-empty path
        mmrag.ingest_text_file(None, config, collection, file_path)

        after = _chunks_for_source(collection, file_path)
        _check("every chunk is gone once the file is emptied", len(after) == 0, after)
    finally:
        shutil.rmtree(src_dir, ignore_errors=True)


def test_growing_file_loses_nothing():
    print("\n[test 4/4] PAIRED CONTROL: a file that GROWS must not lose any of its original "
          "low-index chunks — the boundary check (old <= new -> no-op) must hold in this "
          "direction too, not just be untested")
    collection = _fresh_collection("growing")
    src_dir = tempfile.mkdtemp(prefix="mmrag-orphan-src4-")
    try:
        file_path = Path(src_dir) / "growing.md"
        config = {"text_chunk_size": 50, "text_chunk_overlap": 0}
        small = [f"MARKER_{i:02d} " + ("w" * 60) for i in range(2)]
        file_path.write_text("\n\n".join(small))
        mmrag.args_force = True
        mmrag.ingest_text_file(None, config, collection, file_path)
        before = _chunks_for_source(collection, file_path)

        big = [f"MARKER_{i:02d} " + ("w" * 60) for i in range(8)]
        file_path.write_text("\n\n".join(big))
        mmrag.ingest_text_file(None, config, collection, file_path)
        after = _chunks_for_source(collection, file_path)

        _check("chunk count grew, did not shrink", len(after) > len(before),
               f"before={len(before)} after={len(after)}")
        _check("every original low-index chunk is still present after growth",
               all(i in after for i in before), f"before={sorted(before)} after={sorted(after)}")
    finally:
        shutil.rmtree(src_dir, ignore_errors=True)


if __name__ == "__main__":
    test_shrink_then_reingest_removes_orphans_keeps_survivors()
    test_first_ingest_never_prunes()
    test_emptied_file_prunes_every_prior_chunk()
    test_growing_file_loses_nothing()

    shutil.rmtree(_TMP_CHROMA_DIR, ignore_errors=True)

    print()
    if FAILURES:
        print(f"FAILED: {len(FAILURES)} check(s): {FAILURES}")
        sys.exit(1)
    print("All checks passed.")
    sys.exit(0)
