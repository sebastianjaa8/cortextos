// Wrapper for HEARTBEAT step 10 (`cortextos bus kb-ingest`) that turns an
// UNVERIFIABLE step into a checkable one.
//
// WHY THIS EXISTS. On 2026-08-01 builder_1's step 10 was killed at 120s and
// nobody could have known: the step has no receipt, no artifact and no token
// count, so it was caught only because a human happened to be watching that
// shell. Measuring the blast radius surfaced the real shape — THREE DIFFERENT
// STATES ARE INDISTINGUISHABLE TODAY:
//
//   1. killed mid-run          nonzero exit, ingested partially or not at all
//   2. exited 0, ingested NOTHING   <- demonstrated, not theorised: pass a path
//      that does not exist and `kb-ingest` prints "Ingested 0 new chunk(s) /
//      Tokens: 0 embedding" and EXITS 0. A typo'd path, or a daily memory file
//      that does not exist yet this session, both land here.
//   3. never wired at all      six of fifteen agents, including the 2nd and 3rd
//      largest memory stores in the fleet
//
// All three produce the same observable: nothing. So the deliverable is not
// "make the ingest more reliable", it is MAKE THE ABSENCE VISIBLE. That is why
// the assertion is on the EMBEDDING TOKEN COUNT and not on the exit code — the
// exit code is the signal that already failed to distinguish these.
//
// Usage (from any agent directory):
//   node <repo>/scripts/kb-ingest-receipt.mjs --agent <name> --org <org> <path...>
//   node <repo>/scripts/kb-ingest-receipt.mjs --self-test
//
// Exit: 0 ingested something · 2 a real finding (nothing ingested) · 3 could not run.
// 2 vs 3 is the same distinction guard-arm-check draws and for the same reason:
// "the step found nothing" and "the wrapper is broken" must not share a code.

import { execFileSync } from 'node:child_process';
import { existsSync, appendFileSync, mkdirSync, statSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

/**
 * Pull the embedding-token count out of a kb-ingest run.
 *
 * PARSED, NOT INFERRED FROM THE EXIT CODE. Returns null when no Tokens line is
 * present at all, which is DELIBERATELY DISTINCT from 0: a run that printed
 * "Tokens: 0" told us it embedded nothing, while a run with no Tokens line at
 * all was cut off before it could say — the killed-at-120s case. Collapsing
 * those two into 0 would recreate the ambiguity this file exists to remove.
 *
 * @returns {number|null}
 */
export function parseEmbeddingTokens(stdout) {
  // Tolerates thousands separators: the CLI prints "94,500 embedding".
  const m = /Tokens:\s*([\d,]+)\s*embedding/i.exec(stdout || '');
  if (!m) return null;
  return Number(m[1].replace(/,/g, ''));
}

/**
 * Pull the per-file error count out of a kb-ingest run.
 *
 * UNLIKE parseEmbeddingTokens, absence genuinely means zero here — mmrag.py's own source
 * (`if errors: print(f"  Errors: {errors}")`) only prints the line when the count is nonzero, so
 * "no Errors line" and "Errors: 0" are the same fact, not a null-vs-zero ambiguity to preserve.
 */
export function parseErrorCount(stdout) {
  const m = /Errors:\s*(\d+)/i.exec(stdout || '');
  return m ? Number(m[1]) : 0;
}

/**
 * A fingerprint of the inputs as they are RIGHT NOW: path and content hash for each.
 *
 * A CONTENT HASH, NOT mtime+size. I proposed mtime+size (two stats, cheaper); seb_boss overrode it
 * and was right, for a reason that outlives the performance argument: A HASH IN THE RECEIPT IS
 * RE-CHECKABLE BY ANYONE LATER. An mtime+size pair recorded in a receipt cannot be verified after
 * the fact — the file has moved on and nothing can reconstruct what it was. A receipt whose claim
 * cannot be re-tested is a chronicle, not evidence.
 *
 * And mtime is a DISCREDITED SIGNAL ON THIS BOX, twice in writing on 2026-08-01: a `git checkout`
 * revert bumped src mtime without changing content (the false positive the build-stamp exists to
 * fix), and OneDrive touches mtimes on files no cron wrote. Reading 350KB is trivial and bounded by
 * the same files we were already about to embed.
 *
 * THE PER-INPUT SHAPE IS LOAD-BEARING — DO NOT COLLAPSE THIS TO ONE HASH OF THE CONCATENATION.
 * Nothing in the tests covers this and seb_boss found it by checking his own lane, which is the only
 * one passing an `--optional` daily file. The daily path CHANGES NAME at UTC midnight: on 08-02 it
 * becomes memory/2026-08-02.md, which is absent, so a {path, sha256} list differs from yesterday's
 * and the run correctly INGESTS. A single hash over the concatenated bytes would be IDENTICAL on a
 * quiet rollover — same content, different filename — and the skip would fire on a day when the
 * input set genuinely changed. The paths are half the fingerprint, not decoration.
 */
export function fingerprint(paths) {
  return paths.map((p) => {
    try {
      return { path: p, sha256: createHash('sha256').update(readFileSync(p)).digest('hex') };
    } catch {
      return { path: p, sha256: null };
    }
  });
}

/**
 * Is this run a no-op? Only when the last receipt SUCCEEDED and its fingerprint is identical.
 *
 * GATED ON THE PRIOR STATUS, not just on the fingerprint. If the last run failed, the inputs being
 * unchanged is exactly the situation in which we must try AGAIN — skipping there would make a
 * failure permanent and silent, which is the whole family this file exists to prevent.
 */
export function isUnchanged(prev, now) {
  if (!prev || !["INGESTED", "UNCHANGED"].includes(prev.status)) return false;
  return JSON.stringify(prev.fingerprint) === JSON.stringify(now);
}

/**
 * Split the inputs into the ones that actually changed and the ones that did not.
 *
 * PER FILE, NOT ALL-OR-NOTHING, and the difference is the whole value of this feature. The first
 * version compared the WHOLE fingerprint as one boolean, which on the heartbeat path can never be
 * true: HEARTBEAT.md step 5 writes the daily memory file and step 10 ingests, in that order, so the
 * daily file has ALWAYS just changed. One moved file dragged the other into a full re-embed.
 *
 * MEASURED on builder_1 2026-08-01: MEMORY.md 173,278 bytes unchanged for six hours, daily 192,519
 * bytes rewritten every cycle, 0.2585 tokens/byte. So 47% OF EVERY FIRE was re-embedding a file
 * nobody had touched, and the all-or-nothing skip saved NONE of it.
 *
 * The prior fingerprint is already a per-path list, so the data was always there — it was being
 * collapsed to one comparison at the point of use.
 *
 * THE DAILY FILE IS DIRTY ON EVERY FIRE FOR REASONS THAT DIFFER PER AGENT — DO NOT "FIX" THIS BY
 * REORDERING ANYONE'S HEARTBEAT STEPS. builder_1's HEARTBEAT.md has an explicit step 5 that writes
 * daily memory before step 10 ingests. seb_boss has NO such step and writes daily memory on decision
 * triggers under Context-Save Discipline — and measured the same day, his MEMORY.md had been
 * unchanged for FIFTEEN hours while his daily file moved constantly. Two different causes, one
 * effect, worse ratio on his lane. The staleness is a property of what the files ARE, not of any
 * step order, so per-file partitioning is the fix and step reordering is not.
 */
export function partitionChanged(prev, now) {
  const usable = prev && ["INGESTED", "UNCHANGED"].includes(prev.status) ? prev : null;
  // A prior FAILURE re-ingests everything, same reasoning as isUnchanged: unchanged inputs after a
  // failed run are exactly when to retry, and a partial retry would leave the failure half-standing.
  if (!usable) return { changed: now.map((f) => f.path), unchangedPaths: [] };
  const before = new Map((usable.fingerprint || []).map((f) => [f.path, f.sha256]));
  const changed = [];
  const unchangedPaths = [];
  for (const f of now) {
    // A path absent from the prior receipt is NEW, therefore changed. Never skip on a missing entry.
    if (before.has(f.path) && before.get(f.path) === f.sha256 && f.sha256 !== null) unchangedPaths.push(f.path);
    else changed.push(f.path);
  }
  return { changed, unchangedPaths };
}

/**
 * Pure verdict logic so --self-test can drive it without touching the CLI.
 * @returns {{code:0|2|3, status:string, detail:string}}
 */
export function verdict({ missingPaths, tokens, ingestFailed, skippedOptional = [], unchanged = false, unchangedPaths = [], errors = 0 }) {
  // AN ABSENT OPTIONAL PATH IS NOT A FINDING, AND IT IS NOT SILENT EITHER.
  // seb_boss caught this before it did damage: `./memory/<today>.md` does not
  // exist until something writes memory that day, so treating every path as
  // required emits PATH-MISSING on every agent at the start of every UTC day —
  // a red that is correct by its own logic and means nothing. Once that is the
  // normal daily state, a REAL missing path (a typo, a rename, a rotation) is
  // indistinguishable from the routine one, which is the exact failure this
  // file exists to prevent, reintroduced by its own invocation. GUARDRAIL 99.
  //
  // The skip is NAMED in the detail rather than dropped, because "no daily file
  // today" and "nobody passed a daily file" are different facts — the same
  // null-versus-0 split as parseEmbeddingTokens, one level up.
  const skipNote = skippedOptional.length
    ? ` Skipped ${skippedOptional.length} absent optional path(s): ${skippedOptional.join(', ')}.`
    : '';
  // ORDER MATTERS AND THIS ORDER IS THE POINT. A missing path is reported as a
  // missing path, NOT as "0 tokens" — they have different remedies (fix the
  // path vs investigate the ingest) and the CLI itself conflates them by
  // exiting 0 either way. Checking paths first is what un-conflates them.
  if (missingPaths.length) {
    return { code: 2, status: 'PATH-MISSING',
      detail: `${missingPaths.length} input path(s) do not exist: ${missingPaths.join(', ')}. ` +
        `kb-ingest EXITS 0 on a missing path and reports 0 chunks, so this would otherwise read as a clean run.` };
  }
  // UNCHANGED IS A SUCCESS AND IT IS NOT SILENCE. Found by analyst 2026-08-01: this wrapper
  // hardcoded --force, so every fire fully re-embedded files that had not changed — ~96k tokens
  // and 199s per cycle for builder_1 alone, 12 cycles a day.
  //
  // THE OBVIOUS FIX WOULD HAVE BROKEN THE DETECTOR, measured rather than assumed: without --force,
  // kb-ingest prints "Ingested 0 new chunk(s) / Tokens: 0" for an already-indexed file, which this
  // wrapper correctly classifies as ZERO-TOKENS, a finding. Dropping the flag would have turned
  // every quiet cycle red on 15 agents. --force is what makes the nonzero-token assertion mean
  // anything, so the answer is not to weaken the assertion but to SKIP THE CALL when there is
  // nothing to do — cheaper than a no-op ingest, and it reports a POSITIVE fact rather than a zero.
  if (unchanged) {
    return { code: 0, status: 'UNCHANGED',
      detail: `inputs are byte-identical to the last receipt, so nothing was re-embedded. This is a SUCCESS, not a silence — the previous receipt still describes the indexed state.${skipNote}` };
  }
  if (ingestFailed) {
    // THE REASON IS CARRIED, NOT SWALLOWED. The first version of this returned a
    // bare "the call failed" and I hit it within a minute: `cortextos` resolves to
    // a .cmd on Windows, which Node refuses to execFile without a shell since the
    // CVE-2024-27980 fix. A COULD-NOT-RUN with no cause is a dead end for whoever
    // reads the receipt, and the whole point of this file is that someone can.
    return { code: 3, status: 'COULD-NOT-RUN',
      detail: `the kb-ingest call itself failed, so this wrapper has no opinion about the memory ` +
        `store: ${ingestFailed}` };
  }
  if (tokens === null) {
    return { code: 2, status: 'NO-TOKEN-LINE',
      detail: 'kb-ingest produced no "Tokens:" line. It was almost certainly cut off mid-run — the ' +
        'caller timeout is the first thing to check (the harness default is 120s; a 350KB ingest takes ~204s).' };
  }
  // A NONZERO TOKEN COUNT IS NOT PROOF OF A LANDED CHUNK. Found live 2026-08-14 (finance_tracker,
  // local-embeddings rollout): mmrag.py prints "Errors: N" for the files whose embedding call raised
  // (here, an embedding-dimension mismatch) and STILL prints a nonzero Tokens line, because tokens
  // are spent on the failed calls too — VERDICT: INGESTED (370 embedding tokens) while Errors: 2 and
  // 0 chunks actually landed. Checked BEFORE the zero/positive token branches below, because a
  // per-file error can coexist with either: tokens could be 0 (every file failed) or positive (only
  // some did), and both must read as a finding, not as ZERO-TOKENS or INGESTED respectively.
  if (errors > 0) {
    return { code: 2, status: 'INGEST-ERRORS',
      detail: `kb-ingest reported ${errors} per-file error(s). A nonzero Tokens count does not mean ` +
        `those chunks landed — tokens are spent on a failed embedding call too, so check which ` +
        `input(s) failed (dimension mismatch is the known cause) rather than trusting the token count.${skipNote}` };
  }
  // WHAT ZERO-TOKENS ACTUALLY MEANS, EXERCISED IN PRODUCTION 2026-08-03T17:4xZ RATHER THAN REASONED.
  // task_1785723004813_36146080 said the route was "a file whose bytes change but whose chunks are
  // already fully indexed", citing kb-ingest's no---force behaviour. THAT ROUTE IS UNREACHABLE HERE:
  // line ~498 passes --force on every changed run. Measured A-B-A on a real lane — content A (13
  // tokens), content B (9), then A AGAIN: INGESTED, 13 tokens, THE SAME COUNT AS ITS FIRST EMBED.
  // Already-indexed chunks are re-embedded, so they can never yield zero.
  //
  // THE ROUTE THAT DOES REACH IT is a changed input with NO EMBEDDABLE CONTENT — a file truncated to
  // whitespace reached ZERO-TOKENS at exit 2, with INGESTED on either side of it. So this verdict is
  // narrower and more actionable than its first wording: it does not mean "the ingest mysteriously
  // did nothing", it means AN INPUT THAT CHANGED HAS NOTHING IN IT.
  //
  // AND IT IS NOT THE todoist_keeper CASE. That receipt reported 195 tokens with a document count
  // that did not move — nonzero tokens, nothing embedded. ZERO-TOKENS CANNOT SEE THAT, and assuming
  // it would have is what this comment exists to stop.
  if (tokens === 0) {
    return { code: 2, status: 'ZERO-TOKENS',
      detail: `the ingest completed and embedded NOTHING despite at least one input having CHANGED. ` +
        `Since changed inputs are re-embedded with --force, the reachable cause is an input with no ` +
        `embeddable content — check whether a file was truncated or emptied.${skipNote}` };
  }
  // NAMES WHAT IT SKIPPED. "96,466 tokens" and "49,766 tokens, MEMORY.md skipped" are different
  // facts about the same success, and a reader comparing two receipts needs to know which happened
  // before concluding the cost fell.
  const partNote = unchangedPaths.length
    ? ` Skipped ${unchangedPaths.length} unchanged input(s): ${unchangedPaths.join(', ')}.`
    : '';
  return { code: 0, status: 'INGESTED', detail: `${tokens} embedding tokens.${skipNote}${partNote}` };
}

function selfTest() {
  const cases = [
    ['parses a thousands-separated count', () => parseEmbeddingTokens('  Tokens: 94,500 embedding, 0 gen-input') === 94500],
    ['parses a bare count', () => parseEmbeddingTokens('Tokens: 12 embedding') === 12],
    ['parses an error count', () => parseErrorCount('  Errors: 2') === 2],
    ['no Errors line is 0, not null — absence IS zero here', () => parseErrorCount('Done! Ingested 3 new chunk(s)') === 0],
    // THE DISTINCTION THIS FILE TURNS ON. "printed zero" and "never printed" are
    // different facts; if these two ever return the same thing, the killed-run
    // case becomes invisible again and this whole wrapper is decorative.
    ['an explicit zero parses AS zero', () => parseEmbeddingTokens('Tokens: 0 embedding, 0 gen-input') === 0],
    ['no Tokens line is null, NOT zero', () => parseEmbeddingTokens('Done! Ingested 0 new chunk(s)') === null],
    ['null and zero do not collapse', () => parseEmbeddingTokens('Done!') !== parseEmbeddingTokens('Tokens: 0 embedding')],

    ['real ingest passes', () => verdict({ missingPaths: [], tokens: 94500, ingestFailed: false }).code === 0],
    ['zero tokens is a finding', () => verdict({ missingPaths: [], tokens: 0, ingestFailed: false }).code === 2],
    ['no token line is a finding', () => verdict({ missingPaths: [], tokens: null, ingestFailed: false }).code === 2],
    ['missing path is a finding', () => verdict({ missingPaths: ['./gone.md'], tokens: 5, ingestFailed: false }).code === 2],
    // A missing path must NOT be reported as ZERO-TOKENS even when tokens are
    // genuinely zero, because the remedies differ. Asserting the code alone
    // would pass here while the operator is sent to the wrong place.
    ['missing path outranks zero tokens, by STATUS not just code', () =>
      verdict({ missingPaths: ['./gone.md'], tokens: 0, ingestFailed: false }).status === 'PATH-MISSING'],
    ['broken call is 3, not 2', () => verdict({ missingPaths: [], tokens: null, ingestFailed: 'spawn EINVAL' }).code === 3],

    // --- INGEST-ERRORS: the 2026-08-14 finance_tracker incident (nonzero tokens, 0 chunks landed) ---
    ['THE INCIDENT ITSELF: nonzero tokens + errors is a finding, not INGESTED', () =>
      verdict({ missingPaths: [], tokens: 370, ingestFailed: null, errors: 2 }).code === 2],
    ['THE INCIDENT ITSELF, by status not just code', () =>
      verdict({ missingPaths: [], tokens: 370, ingestFailed: null, errors: 2 }).status === 'INGEST-ERRORS'],
    ['errors survive into the detail', () =>
      verdict({ missingPaths: [], tokens: 370, ingestFailed: null, errors: 2 }).detail.includes('2 per-file error')],
    // errors can coexist with tokens:0 too (every file in the batch failed) — must still be
    // INGEST-ERRORS, not ZERO-TOKENS, because the remedy (check which file failed) differs.
    ['zero tokens WITH errors is INGEST-ERRORS, not ZERO-TOKENS', () =>
      verdict({ missingPaths: [], tokens: 0, ingestFailed: null, errors: 1 }).status === 'INGEST-ERRORS'],
    // CONTROL: without this, a verdict() that always returns INGEST-ERRORS would pass every case
    // above. errors defaults to 0, so an ordinary run must be unaffected.
    ['CONTROL: errors:0 still reaches INGESTED for a real ingest', () =>
      verdict({ missingPaths: [], tokens: 370, ingestFailed: false, errors: 0 }).status === 'INGESTED'],
    // PRECEDENCE: a cut-off run (no Tokens line at all) outranks a same-run Errors line — the
    // mid-run kill is the more urgent unknown, and mmrag.py prints Errors: before the Tokens summary,
    // so tokens:null + errors>0 is a real reachable combination, not a hypothetical.
    ['NO-TOKEN-LINE outranks INGEST-ERRORS', () =>
      verdict({ missingPaths: [], tokens: null, ingestFailed: null, errors: 2 }).status === 'NO-TOKEN-LINE'],

    // --- the UNCHANGED skip (analyst 2026-08-01: --force re-embedded everything every fire) ---
    // --- UTC ROLLOVER: the fingerprint must stay PER-INPUT (task_1785622930763_68411636) ---
    //
    // seb_boss found this 2026-08-01 checking his own lane, the only one passing an --optional daily
    // file, and it sat as PROSE IN A TASK DESCRIPTION for two days — a must-fail case with no
    // instrument, which is the exact shape audited and found wanting on 2026-08-03. Converting it to
    // a case is the whole point: it now runs whenever anyone touches this file.
    //
    // THE BREAK IS INVISIBLE EXCEPT AT MIDNIGHT UTC. If fingerprint() is ever collapsed to ONE hash
    // over the concatenated bytes — a plausible simplification, and smaller code — it behaves
    // identically every day except the one where the optional daily path CHANGES NAME while its
    // CONTENT is unchanged. On a quiet night the concatenation hash is identical, isUnchanged returns
    // true, AND THE SKIP FIRES ON A DAY THE INPUT SET GENUINELY CHANGED. The file that would be
    // skipped is the new day's, which is the one nobody has ingested yet.
    ['UTC ROLLOVER: same content, CHANGED daily path -> NOT unchanged', () => {
      const prev = { status: 'INGESTED', fingerprint: [
        { path: './MEMORY.md', sha256: 'aaa' },
        { path: './memory/2026-08-01.md', sha256: 'bbb' }] };
      const now = [
        { path: './MEMORY.md', sha256: 'aaa' },
        { path: './memory/2026-08-02.md', sha256: 'bbb' }];
      return isUnchanged(prev, now) === false;
    }],
    // PAIRED NEGATIVE: identical paths AND identical hashes must still be UNCHANGED, or the guard
    // above is satisfied by a function that simply never returns true.
    ['same content and SAME daily path -> unchanged', () => {
      const fp = [{ path: './MEMORY.md', sha256: 'aaa' }, { path: './memory/2026-08-01.md', sha256: 'bbb' }];
      return isUnchanged({ status: 'INGESTED', fingerprint: fp }, fp) === true;
    }],
    // AND THE CONVERSE HALF: same path, CHANGED content must also be not-unchanged. Without it, a
    // path-only comparison would pass both cases above.
    ['same daily path, CHANGED content -> NOT unchanged', () => {
      const prev = { status: 'INGESTED', fingerprint: [{ path: './memory/2026-08-01.md', sha256: 'bbb' }] };
      return isUnchanged(prev, [{ path: './memory/2026-08-01.md', sha256: 'ccc' }]) === false;
    }],
    ['unchanged is a SUCCESS, not a finding', () =>
      verdict({ missingPaths: [], tokens: null, ingestFailed: null, unchanged: true }).code === 0],
    // Without this, UNCHANGED and ZERO-TOKENS could collapse — and they are opposites: one is
    // "nothing needed doing", the other is "something should have happened and did not".
    ['unchanged and zero-tokens are DIFFERENT statuses', () =>
      verdict({ missingPaths: [], tokens: null, ingestFailed: null, unchanged: true }).status !==
      verdict({ missingPaths: [], tokens: 0, ingestFailed: null }).status],
    // A MISSING PATH STILL OUTRANKS AN UNCHANGED FINGERPRINT. Ordering, again: if a required file
    // is deleted, its hash goes null and the fingerprint "changes", but should the file be restored
    // byte-identically we must not skip past the fact that it was gone.
    ['missing path outranks unchanged', () =>
      verdict({ missingPaths: ['./gone.md'], tokens: null, ingestFailed: null, unchanged: true }).status === 'PATH-MISSING'],
    // isUnchanged is GATED ON THE PRIOR STATUS. If the last run FAILED, unchanged inputs are exactly
    // when we must retry — skipping there makes a failure permanent and silent.
    ['a prior FAILURE never permits a skip', () =>
      isUnchanged({ status: 'ZERO-TOKENS', fingerprint: [{ path: 'a', sha256: 'x' }] },
                  [{ path: 'a', sha256: 'x' }]) === false],
    ['a prior SUCCESS with an identical hash permits a skip', () =>
      isUnchanged({ status: 'INGESTED', fingerprint: [{ path: 'a', sha256: 'x' }] },
                  [{ path: 'a', sha256: 'x' }]) === true],
    ['a changed hash never permits a skip', () =>
      isUnchanged({ status: 'INGESTED', fingerprint: [{ path: 'a', sha256: 'x' }] },
                  [{ path: 'a', sha256: 'y' }]) === false],
    ['no prior receipt never permits a skip (first run must actually run)', () =>
      isUnchanged(null, [{ path: 'a', sha256: 'x' }]) === false],

    // --- PER-FILE partitioning. The all-or-nothing version could never fire on a heartbeat,
    // because step 5 writes the daily file and step 10 ingests, in that order. These are the
    // cases that distinguish "skips the right subset" from "skips nothing" and from "skips too much".
    ['THE HEARTBEAT SHAPE: one changed, one not -> ingest only the changed one', () => {
      const r = partitionChanged(
        { status: 'INGESTED', fingerprint: [{ path: 'MEMORY.md', sha256: 'a' }, { path: 'daily.md', sha256: 'b' }] },
        [{ path: 'MEMORY.md', sha256: 'a' }, { path: 'daily.md', sha256: 'CHANGED' }]);
      return r.changed.length === 1 && r.changed[0] === 'daily.md' && r.unchangedPaths[0] === 'MEMORY.md';
    }],
    ['all unchanged -> nothing to ingest', () => partitionChanged(
      { status: 'INGESTED', fingerprint: [{ path: 'a', sha256: 'x' }] },
      [{ path: 'a', sha256: 'x' }]).changed.length === 0],
    ['no prior receipt -> EVERYTHING is changed, nothing skipped', () => {
      const r = partitionChanged(null, [{ path: 'a', sha256: 'x' }, { path: 'b', sha256: 'y' }]);
      return r.changed.length === 2 && r.unchangedPaths.length === 0;
    }],
    // A partial retry after a failure would leave the failure half-standing, so a bad prior status
    // must re-ingest EVERY input, not just the ones that moved.
    ['a prior FAILURE re-ingests everything, not just the changed subset', () => {
      const r = partitionChanged(
        { status: 'ZERO-TOKENS', fingerprint: [{ path: 'a', sha256: 'x' }] },
        [{ path: 'a', sha256: 'x' }]);
      return r.changed.length === 1 && r.unchangedPaths.length === 0;
    }],
    // A path the prior receipt never saw is NEW. Skipping on a missing entry would silently never
    // index a newly-added input — the never-wired failure this whole file exists to surface.
    ['a path absent from the prior receipt counts as CHANGED', () => partitionChanged(
      { status: 'INGESTED', fingerprint: [{ path: 'a', sha256: 'x' }] },
      [{ path: 'a', sha256: 'x' }, { path: 'NEW.md', sha256: 'z' }]).changed[0] === 'NEW.md'],
    // An unreadable file hashes to null. Two nulls must NOT compare equal and skip.
    // FAIL-SAFE UNDER A DEGRADED PRIOR RECEIPT. These pin the property the fleet rollout was
    // authorised on: every way the prior receipt can be damaged — rotated file, truncated jsonl,
    // lost or empty fingerprint — must force a FULL ingest, never a silent skip. The failure
    // direction is a redundant re-embed (costs tokens) rather than a stale index (costs
    // correctness), which is why a lane that skips for TEN DAYS is not more dangerous than one
    // that skips for an hour, only more expensive to be wrong about. atlas is 230h stale; the
    // canary only ever tested a 0-hour interval.
    ['prior INGESTED but fingerprint MISSING -> full ingest', () => {
      const now = [{ path: 'a', sha256: 'x' }, { path: 'b', sha256: 'y' }];
      const r = partitionChanged({ status: 'INGESTED' }, now);
      return r.changed.length === 2 && r.unchangedPaths.length === 0;
    }],
    ['prior INGESTED but fingerprint null -> full ingest', () => {
      const now = [{ path: 'a', sha256: 'x' }];
      const r = partitionChanged({ status: 'INGESTED', fingerprint: null }, now);
      return r.changed.length === 1 && r.unchangedPaths.length === 0;
    }],
    ['prior INGESTED with an EMPTY fingerprint -> full ingest', () => {
      const now = [{ path: 'a', sha256: 'x' }];
      const r = partitionChanged({ status: 'INGESTED', fingerprint: [] }, now);
      return r.changed.length === 1 && r.unchangedPaths.length === 0;
    }],
    // THE CONTROL. Without it the three above are satisfiable by a partitioner that never skips
    // anything, which would pass fail-safe and defeat the entire feature.
    ['CONTROL: an intact prior with identical hashes STILL skips', () => {
      const now = [{ path: 'a', sha256: 'x' }];
      return partitionChanged({ status: 'INGESTED', fingerprint: now }, now).changed.length === 0;
    }],
    ['a null hash never permits a skip', () => partitionChanged(
      { status: 'INGESTED', fingerprint: [{ path: 'a', sha256: null }] },
      [{ path: 'a', sha256: null }]).changed.length === 1],
    // seb_boss's case 3, and it FIRES TONIGHT rather than hypothetically — it was 00:00Z when he
    // raised it. At UTC rollover the daily path changes name and does not exist, so it is
    // skipped-OPTIONAL, while MEMORY.md is unchanged and is skipped-UNCHANGED. Every input skipped,
    // zero tokens — and that must land in UNCHANGED (healthy) and NOT in ZERO-TOKENS (a finding).
    ['UTC ROLLOVER: daily absent + MEMORY.md unchanged -> UNCHANGED, not ZERO-TOKENS', () => {
      const prev = { status: 'INGESTED', fingerprint: [
        { path: './MEMORY.md', sha256: 'a' }, { path: './memory/2026-08-01.md', sha256: 'b' }] };
      // the new day: only MEMORY.md is present, the daily path has changed name and is absent
      const now = [{ path: './MEMORY.md', sha256: 'a' }];
      const part = partitionChanged(prev, now);
      const v = verdict({ missingPaths: [], tokens: null, ingestFailed: null,
                          skippedOptional: ['./memory/2026-08-02.md'],
                          unchanged: part.changed.length === 0,
                          unchangedPaths: part.unchangedPaths });
      return part.changed.length === 0 && v.status === 'UNCHANGED' && v.code === 0;
    }],
    ['a partial skip NAMES what it skipped', () =>
      verdict({ missingPaths: [], tokens: 500, ingestFailed: null, unchangedPaths: ['MEMORY.md'] })
        .detail.includes('MEMORY.md')],
    // Asserting only the CODE would pass while the receipt says nothing useful,
    // which is the failure this file already made once. The reason must survive
    // into the detail, or COULD-NOT-RUN is a dead end for whoever reads it.
    ['the failure REASON reaches the detail', () =>
      verdict({ missingPaths: [], tokens: null, ingestFailed: 'spawn EINVAL' }).detail.includes('spawn EINVAL')],

    // THE OPTIONAL/REQUIRED SPLIT. Without these two, the first person to
    // "simplify" the filter collapses them and reinstalls a PATH-MISSING on
    // every agent at the start of every UTC day — correct by its own logic,
    // meaningless, and it makes a REAL missing path indistinguishable from the
    // routine one. Same null-versus-0 discipline, one level up.
    ['an ABSENT OPTIONAL path is NOT a finding', () =>
      verdict({ missingPaths: [], tokens: 500, ingestFailed: false, skippedOptional: ['./memory/today.md'] }).code === 0],
    ['an ABSENT REQUIRED path IS a finding', () =>
      verdict({ missingPaths: ['./MEMORY.md'], tokens: 500, ingestFailed: false }).code === 2],
    ['absent-optional and absent-required give DIFFERENT statuses', () =>
      verdict({ missingPaths: [], tokens: 500, ingestFailed: false, skippedOptional: ['./x.md'] }).status !==
      verdict({ missingPaths: ['./x.md'], tokens: 500, ingestFailed: false }).status],
    // Skipped, but NOT silently: if the skip vanishes from the detail, "no daily
    // file today" and "nobody passed one" become the same observable again.
    ['a skipped optional path is NAMED in the detail', () =>
      verdict({ missingPaths: [], tokens: 500, ingestFailed: false, skippedOptional: ['./memory/today.md'] })
        .detail.includes('./memory/today.md')],
  ];
  let failed = 0;
  for (const [name, fn] of cases) {
    let ok = false;
    try { ok = fn() === true; } catch { ok = false; }
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  }
  // Both directions: some cases must pass clean, some must fire.
  console.log(failed === 0 ? `\nself-test PASSED (${cases.length} cases)` : `\nself-test FAILED: ${failed}`);
  process.exit(failed === 0 ? 0 : 2);
}

if (process.argv.includes('--self-test')) selfTest();

// ---------------------------------------------------------------------------
// STARTED-AT IS CAPTURED HERE, BEFORE ANY WORK, NOT NEAR THE RECEIPT WRITE.
// WHY IT EXISTS: analyst pre-registered at 2026-08-02 14:0xZ that skip-heavy runs finish FASTER
// than ingest-heavy ones. The receipt recorded COMPLETION TIME ONLY, so a member that finished
// last may simply have STARTED last — there is no arrangement of completion-only data that answers
// a duration question, and more spikes would not have changed that. The prediction was relabelled
// UNRESOLVABLE-BY-INSTRUMENT rather than logged as weak evidence. One field makes it testable.
// PLACED BEFORE ARG PARSING ON PURPOSE: a start captured later would silently exclude whatever ran
// before it, which is the same under-reporting the receipt exists to prevent.
const startedAt = new Date().toISOString();

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};
const agent = flag('--agent') || process.env.CTX_AGENT_NAME;
const org = flag('--org') || process.env.CTX_ORG;
// --optional may repeat. An optional path that is absent is SKIPPED AND NAMED;
// an absent required path is still PATH-MISSING. Keeping both concepts is the
// point — see verdict() for why collapsing them installs a daily false alarm.
const optionalPaths = argv.filter((a, i) => argv[i - 1] === '--optional');
const paths = argv.filter(
  (a, i) => !a.startsWith('--') && !['--agent', '--org', '--optional'].includes(argv[i - 1]),
);

if (!agent || !org) {
  console.log('VERDICT: COULD-NOT-RUN — need --agent and --org (or CTX_AGENT_NAME / CTX_ORG).');
  process.exit(3);
}
if (!paths.length && !optionalPaths.length) {
  console.log('VERDICT: COULD-NOT-RUN — no input paths given.');
  process.exit(3);
}

// EXISTENCE IS CHECKED HERE, BEFORE THE CLI SEES IT, because the CLI's answer to
// a missing path is a clean exit 0 — verified 2026-08-01, not assumed.
const missingPaths = paths.filter((p) => !existsSync(p));
// Optional paths split rather than fail: present ones join the ingest, absent
// ones are recorded so the receipt says WHICH, instead of silently shrinking.
const skippedOptional = optionalPaths.filter((p) => !existsSync(p));
const presentOptional = optionalPaths.filter((p) => existsSync(p));
const ingestPaths = [...paths, ...presentOptional];

// CALLS dist/cli.js WITH node DIRECTLY, not the `cortextos` shim. The shim is a
// .cmd on Windows, and Node has refused to execFile a .cmd without a shell since
// CVE-2024-27980 — measured, not guessed: the first version used the shim and
// returned COULD-NOT-RUN on a perfectly good file. Going through a shell instead
// would work and would put every path through shell quoting, on a box where a
// path already behaves differently as argv than as a string. This resolves the
// CLI relative to THIS file, so it does not depend on cwd or PATH either.
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

const RECEIPT_ROOT = (process.env.CTX_ROOT || `${process.env.HOME}/.cortextos/default`).replace(/\\/g, '/');
const RECEIPT = `${RECEIPT_ROOT}/state/${agent}/.kb-ingest-receipts.jsonl`;

let prevReceipt = null;
try {
  const lines = readFileSync(RECEIPT, 'utf8').trim().split('\n').filter(Boolean);
  prevReceipt = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
} catch {
  prevReceipt = null; // no receipt yet is not an error, it is the first run
}

// THE SKIP IS OFF UNTIL THE 15 HEARTBEAT.md BLOCKS SAY UNCHANGED IS A SUCCESS.
// All of them currently read "INGESTED (0) is the only success", so shipping the skip first would
// hand 15 live agents a status their own instructions explicitly deny — which is exactly the
// suspected-injection alarm pm_bot correctly raised on 2026-07-30 against an unannounced change.
// The code lands first and stays inert; the flag flips after the docs land with a bus announcement.
const SKIP_ENABLED = process.env.FT_KB_SKIP_UNCHANGED === '1';

const nowPrint = missingPaths.length ? null : fingerprint(ingestPaths);
// PER-FILE. `unchanged` is now "every input was unchanged", and the far more common case on a
// heartbeat is SOME unchanged — MEMORY.md sits still while the daily file moves every cycle.
const part = SKIP_ENABLED && nowPrint !== null
  ? partitionChanged(prevReceipt, nowPrint)
  : { changed: ingestPaths, unchangedPaths: [] };
const unchanged = SKIP_ENABLED && nowPrint !== null && part.changed.length === 0;

let stdout = '';
let ingestFailed = null;
if (!missingPaths.length && !unchanged) {
  if (!existsSync(CLI)) {
    ingestFailed = `no CLI bundle at ${CLI} — run npm run build.`;
  } else {
    try {
      stdout = execFileSync(
        process.execPath,
        [CLI, 'bus', 'kb-ingest', ...part.changed, '--org', org, '--agent', agent, '--scope', 'private', '--force'],
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
      );
    } catch (err) {
      ingestFailed = (err.message || String(err)).split('\n')[0];
      stdout = `${err.stdout || ''}${err.stderr || ''}`;
    }
  }
}

const tokens = parseEmbeddingTokens(stdout);
const errors = parseErrorCount(stdout);
const { code, status, detail } = verdict({ missingPaths, tokens, ingestFailed, skippedOptional, unchanged, unchangedPaths: part.unchangedPaths, errors });

// THE RECEIPT IS WRITTEN ON EVERY OUTCOME, INCLUDING THE BAD ONES. A receipt
// that only appears on success cannot distinguish "failed" from "never ran",
// which is the exact pair that made this invisible in the first place.
const root = process.env.CTX_ROOT || `${process.env.HOME}/.cortextos/default`;
const receipt = `${root.replace(/\\/g, '/')}/state/${agent}/.kb-ingest-receipts.jsonl`;
try {
  mkdirSync(dirname(receipt), { recursive: true });
  appendFileSync(receipt, JSON.stringify({
    // ts is COMPLETION. startedAt is when this process began, captured before arg parsing.
    // durationMs is redundant with the pair ON PURPOSE: a reader gets the answer without a
    // subtraction, and a mismatch between durationMs and (ts - startedAt) means the receipt is
    // internally inconsistent, which is a defect no single field could reveal.
    ts: new Date().toISOString(),
    startedAt,
    durationMs: Date.now() - Date.parse(startedAt),
    agent, status, tokens, errors,
    // Sizes travel with the receipt so the growth curve is readable from the
    // receipts alone, without re-stat'ing files that have since changed.
    bytes: ingestPaths.reduce((n, p) => n + (existsSync(p) ? statSync(p).size : 0), 0),
    // `paths` is WHAT WAS ACTUALLY SENT, not what was asked for. The first
    // version recorded only the required paths, so seb_boss's receipt read
    // paths:["./MEMORY.md"] while bytes proved a 135KB daily file had also been
    // ingested — the receipt under-describing its own coverage, in the file
    // whose entire job is describing coverage. Reading `paths` would have
    // understated what was indexed; only the byte count disagreed.
    paths: ingestPaths, skippedOptional,
    // The fingerprint is what makes the NEXT run's skip decision possible. Without it in the
    // receipt there is no prior state to compare against and every run re-embeds forever.
    fingerprint: nowPrint,
    // Which inputs were actually sent, so a later reader can tell a cheap fire from a full one.
    ingested: unchanged ? [] : part.changed,
    skippedUnchanged: part.unchangedPaths,
    // Carried forward on a skip so the receipt line still says how much is indexed. A receipt that
    // reads "tokens: null" on every quiet cycle loses the number the whole file exists to report.
    tokens_carried: unchanged ? (prevReceipt && (prevReceipt.tokens ?? prevReceipt.tokens_carried)) : undefined,
  }) + '\n');
} catch (err) {
  console.log(`NOTE: verdict stands but the receipt could not be written (${err.message}).`);
}

console.log(stdout.trim());
console.log(`VERDICT: ${status} — ${detail}`);
process.exit(code);
