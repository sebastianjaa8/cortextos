# task_1786672430694 — kb-ingest: drop Gemini, switch to local embedding

- decision: fix belongs in mmrag.py's `embed_content()` only, not a new Node/onnxruntime-node
  pipeline (task text suggested that as an example, "or similar" left room). The existing
  architecture is already Python + venv + chromadb; chromadb's own bundled
  `DefaultEmbeddingFunction` (ONNX MiniLM-L6-v2, 384-dim) was ALREADY an installed dependency
  (verified via `pip list`: onnxruntime 1.26.0 present before I touched anything) — zero new
  packages needed. Smallest possible diff for the actual requirement (local, no API, no key,
  no billing).
- decision: `get_api_key()` used to `sys.exit(1)` unconditionally when GEMINI_API_KEY was
  missing — meaning even a PURE TEXT kb-ingest (the only thing heartbeat step 10 ever does)
  refused to start. Changed it to return None; `embed_content()` routes plain text (the common
  case, covers every .md/.txt/code file and every query) to the local embedder, which never
  touches `client` at all. Multimodal content (a list of Parts — image/video/audio bytes) still
  requires a real Gemini client and now fails with a clear, contained RuntimeError only if that
  specific path is reached with no key — not at process start.
- SCOPE BOUNDARY, deliberate: only TEXT embedding was touched. Gemini Flash-based multimodal
  DESCRIPTION generation (`describe_media`, for image/video/audio/PDF ingestion) still requires
  GEMINI_API_KEY and remains broken until a separate decision. Heartbeat step 10 only ever
  ingests MEMORY.md + daily memory files (pure text), so this covers the actual blocking issue
  for all 11+ agents. Did not silently expand scope to "replace Gemini everywhere."
- verification: wrote `_test_clients/test_local_embedding.py` (matches the existing
  `_test_clients/test_retry.py` / `test_prune_orphaned_chunks.py` convention — module-run,
  exit 0/1, no pytest). 5 scenarios including a discriminating pair (related text scores higher
  than unrelated) so the test can't pass against a stub returning zeros/random noise. MUST-FAIL
  CASE proven red first via git stash: on unmodified mmrag.py, test 1 doesn't even reach an
  assertion — the process hard-exits with "ERROR: No Gemini API key" before the test harness can
  catch it, exit code 1. Restored the fix, all 5/5 green. Existing baseline suites
  (test_retry.py, test_prune_orphaned_chunks.py) re-run clean before and after — neither touches
  the embedding backend directly (test_prune stubs embed_content entirely).
- REAL FINDING, not yet resolved: ran a real end-to-end ingest of GOALS.md (small, 8 chunks) into
  an isolated test chromadb — worked cleanly, correct token count, correct dimension. Then queried
  it ("what is the current goal") against the EXISTING config's `similarity_threshold: 0.5` (tuned
  for Gemini's embedding space) and got **0 results** — the real top match scored 0.295, well
  under 0.5. Confirmed via a direct calibration script (5 query/document pairs, known-related vs
  known-unrelated): the local MiniLM model's similarity scores vary WIDELY by query concreteness —
  a specific query ("daemon restart procedure") separated cleanly (0.546 related vs -0.038
  unrelated), but a vague/abstract query ("what is the current goal") barely separated at all
  (0.008 related vs -0.039 unrelated, 0.022 for a partial match). **The existing 0.5 threshold
  would silently return "no results" for a large fraction of real queries under the new model —
  a real quality regression that needs an explicit decision, not a silent config carry-over.**
  Did not pick a new number unilaterally; flagging for seb_boss/Sebastian.
- REAL FINDING, not yet resolved: ingesting my own MEMORY.md (191KB) + seb_boss's (110KB) timed
  out at 7 minutes; re-tested seb_boss's file alone (110KB) in the background and it was STILL
  running past 10 minutes with no progress line (ingest only prints one summary line per file, no
  per-chunk progress, so I can't see WHERE it's slow). An isolated single-call benchmark showed
  ~0.5-0.9s per embed (model load ~1s, warm), which would put a ~110-chunk file around 1-2 minutes
  — the real run is running far longer than that estimate. Two live hypotheses, not yet
  distinguished: (a) genuine CPU contention from the rest of the fleet (RAM was already flagged
  ~85% used earlier this session) making sequential local inference much slower under load than
  in isolation, or (b) something in the per-chunk loop itself (chromadb HNSW insert cost scaling
  with collection size, or a chunking-logic difference between GOALS.md's 8 chunks and a much
  larger real chunk count) that isn't purely about the embedding call. NOT diagnosed yet — this
  needs profiling before a fleet-wide rollout, not guessed at.
- gotcha: chromadb's local embedder returns `numpy.ndarray` of `float32`, not plain Python floats
  — not JSON-serializable, and would silently differ from what every existing caller expects from
  the old Gemini path (`result.embeddings[0].values`, a plain list of floats). Converted
  explicitly (`[float(x) for x in ...]`) inside `embed_text_local()`.
- gotcha, minor, NOT fixed yet: the CLI still prints `Cost: $0.0003` on a local (free) embed,
  because `UsageTracker`'s cost math applies `EMBEDDING_PRICE_PER_M` to the token-proxy count
  unconditionally. Cosmetically wrong now (claims a cost that doesn't exist) but does NOT affect
  the receipt/verdict contract kb-ingest-receipt.mjs depends on (it only reads the `Tokens: N`
  line, never the `Cost:` line) — confirmed by reading that wrapper's parser before deciding this
  was safe to defer. Worth a follow-up, not urgent, noted rather than silently left unmentioned.
- receipt/verdict contract preserved by design, verified by test 5: `track_embedding()` computes
  its token-proxy count from the INPUT TEXT LENGTH (`len(content.split()) * 1.3`), not from any
  Gemini API response — that was already true before my change, so leaving that function
  untouched and calling it unconditionally after every successful embed (local or Gemini) means
  `kb-ingest-receipt.mjs`'s `Tokens: N` parsing and its INGESTED/ZERO-TOKENS verdict split needs
  ZERO changes. Deliberately did not touch that wrapper at all.
- NOT DONE: the LIVE shared org knowledge-base (one config.json + one chromadb per org, used by
  all 13 agents — confirmed via src/bus/knowledge-base.ts's buildKBEnv) still has
  `embedding_dimensions: 3072` and all existing vectors are Gemini-shaped. Switching the live
  config to `embedding_dimensions: 384` without resetting the collections would make every
  `.add()` call fail on a chromadb dimension mismatch. This needs a one-time reset + full
  re-ingest (source files — MEMORY.md, daily memory — are still on disk, nothing is actually
  lost, only the derived vector index gets rebuilt) as an explicit, coordinated migration step
  across all 13 agents, not something to do silently mid-task. NOT executed against the live
  collection — all testing above used an isolated scratch chromadb
  (.kb-test-scratch/, worktree-local, deleted before merge).
- Held on branch builder_1/kb-local-embeddings, worktree
  ../cortextos-worktrees/builder_1-kb-local-embeddings. Core fix + tests done and verified; three
  open decisions (similarity_threshold recalibration, ingest throughput at scale, live-collection
  migration coordination) reported to seb_boss before proceeding further.

## Follow-up 2026-08-14 — throughput profiled properly, threshold set (seb_boss direction)

- THRESHOLD: seb_boss set 0.3 as the starting point (real top score for the vague-query test was
  0.295). Not applying to the LIVE config.json yet -- it ships together with the dimension change
  and collection reset (item 3, still held). Migration snippet prepared below.
- THROUGHPUT, profiled in three isolated stages, not guessed:
  1. Stage-by-stage timing on a real 184-chunk file (seb_boss's MEMORY.md): chunk_text is
     instant, `already_exists()` .get() check is 0.4ms/call, `collection.upsert()` is 104ms/call.
     `embed_content()` averaged 4420ms/call in that same run -- overwhelmingly the bottleneck.
     **The per-chunk insert loop is NOT the problem** -- ruled out cleanly by isolating it from
     the embed call.
  2. Ran a controlled repeated-call test: first ~8 calls fast (0.2-0.3s each, matches an isolated
     cold-start benchmark), then a sharp, sustained jump to 4-5s/call for the rest -- NOT random
     jitter, a real step change.
  3. Distinguished "my code" from "the box" directly: created a completely FRESH embedder
     instance immediately after the slowdown started and ran 6 more calls on it -- still
     3.6-5.2s/call. A fresh, uncached instance being equally slow RULES OUT a caching/session-
     reuse bug in my singleton pattern. The slowness is external to the code.
  4. Correlated with the box: 17 live node.exe processes + 4 python.exe processes running
     concurrently at the time, RAM ~77-85% used (consistent with readings all session). This is
     ambient fleet CPU contention, not a defect in this change -- matches seb_boss's own
     hypothesis #2a exactly.
- OPERATIONAL IMPLICATION for the eventual reset+re-ingest: at ~4-5s/chunk under current ambient
  load (vs ~0.25s/chunk best-case when the box is quiet), a full re-ingest of a large file
  (MEMORY.md-sized, 180-300+ chunks) could take 15-25 minutes per agent under load. Worth
  scheduling the actual migration during a quieter window if one exists, or just accepting the
  cost -- Sebastian's call, not mine, noted for the heads-up conversation.
- MIGRATION SNIPPET, prepared not applied -- the config.json diff that ships together with the
  reset, when Sebastian's heads-up is done:
  ```
  - "embedding_dimensions": 3072,
  + "embedding_dimensions": 384,
  - "similarity_threshold": 0.5,
  + "similarity_threshold": 0.3,
  ```
  Plus: `mmrag.py reset --confirm` (existing command, already built) per agent/collection, then a
  full re-ingest from each agent's real source files (MEMORY.md + daily memory) -- nothing is
  destroyed, only the derived vector index rebuilds from files already on disk.
- Items 1 and 2 (seb_boss's list) now resolved. Item 3 (live reset) still held pending
  Sebastian's heads-up, per seb_boss's explicit instruction.
