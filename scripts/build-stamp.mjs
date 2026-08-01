#!/usr/bin/env node
/**
 * Provenance stamp for dist/ — the fix for "two clocks cannot answer a content question".
 *
 * WIRED 2026-08-01: `tsup.config.ts` calls `--write` via onSuccess, and guard-arm-check's
 * STALE-BUNDLE leg calls `--check`. Both halves together on purpose — a stamp with no reader is dead
 * weight, and a reader with no stamp reports UNVERIFIABLE forever and trains someone to ignore it.
 *
 * IT LIVES IN scripts/ AND NOT IN THE AGENT'S work/ FOR ONE REASON: `.gitignore` line 13 is `orgs/`,
 * commented "User-created org data (not part of the framework)". `tsup.config.ts` is tracked and
 * ships. Pointing a tracked build at an untracked path builds fine on the box that authored it and
 * breaks `npm run build` on every clone, every CI run, every fresh checkout. The two obvious
 * workarounds — `|| true`, or an existence guard — both make the stamp SILENTLY not get written,
 * which is the exact failure this file exists to detect. Moved instead.
 *
 * WHY IT EXISTS, both modes measured on one run 2026-07-31:
 *
 *   MTIME       `git checkout` reverted two src files. Content returned to what the bundle was
 *               built from; mtime jumped to 04:08:13. The guard compared newest-src-mtime against
 *               bundle-mtime and reported STALE-BUNDLE against a bundle that was current.
 *
 *   COMMIT TIME the obvious fix, and it fails independently on the SAME run: da70966d committed at
 *               00:36:04Z, bundle built 00:16:47Z from the working tree BEFORE the commit. Older
 *               than its own source's commit, and correct.
 *
 * Both are proxies for "was this artifact produced from this source". Only the artifact recording
 * its own provenance answers it.
 *
 * THE DIRTY CASE IS THE ONE WORTH GETTING RIGHT. A bundle built from uncommitted source cannot be
 * proven current later — the hash it was built from no longer exists anywhere. That is reported as
 * UNVERIFIABLE, never as CURRENT. Claiming a clean bill for a build whose source is unrecoverable
 * would be the same false-success shape this whole exercise is about.
 *
 * Usage:
 *   node scripts/build-stamp.mjs --write [root]  write dist/.build-stamp (tsup postbuild step)
 *   node scripts/build-stamp.mjs --check [root]  compare stamp against current HEAD + working tree
 *   node scripts/build-stamp.mjs --self-test     prove every verdict can be reached
 *
 * Exit: 0 CURRENT · 2 a real finding (STALE or UNVERIFIABLE) · 3 the check could not run
 *
 * UNVERIFIABLE IS 2, NOT 3, AND THIS FILE SAID 3 UNTIL 2026-08-01. guard-arm-check has always
 * mapped it to 2 and reserved 3 for could-not-run, with a comment saying the two must not be
 * conflated — so the conflation the comment forbids lived at the SEAM between the two files, where
 * neither file's own reasoning was looking. Any caller applying the documented semantics to
 * `--check` read an unprovable bundle as a broken check. 2 is the correct one on the merits: "we
 * cannot establish what this bundle was built from" is a FINDING about the bundle, and 3 must stay
 * reserved for "this tool did not work", or a wrong invocation reads as a real result again.
 * STALE and UNVERIFIABLE now share exit 2 deliberately. They are distinguished by `status`, which
 * is what guard-arm-check branches on; an exit code separates could-not-run from found-something,
 * not one finding from another. (seb_boss, reading the ACTIVATION 4 diff.)
 */
import { writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// RESOLVED FROM THE SCRIPT'S OWN LOCATION, NOT process.cwd(). The first draft of this move used
// cwd, which is invocation-dependent: tsup from the repo root gives the root, guard-arm-check
// importing this from another directory gives THAT directory, and a cron with its own working
// directory gives a third answer. That trades "works on one box" for "works from one directory" —
// the same silent-wrong-path failure in a new costume. import.meta.url is fixed at authorship and
// identical from every call site. (seb_boss caught this before it was committed.)
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STAMP = 'dist/.build-stamp';

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf-8' }).trim();
}

/**
 * The src TREE hash at a commit. THIS IS THE COMPARAND, and `head` is not.
 *
 * THE THIRD PROXY, fixed 2026-08-01 within twenty minutes of the second. This leg has now used
 * three stand-ins for one content question:
 *   commit date   fired by 278ms      (commit resolution vs mtime resolution)
 *   src mtime     fired on a revert   (checkout restored identical content, bumped mtime)
 *   HEAD hash     fires on ANY commit that does not touch src/ — including f5f6c1a6, the commit
 *                 that fixed the other two. Measured: 452c0c19:src and f5f6c1a6:src are both
 *                 061239e3, and the guard reported STALE-BUNDLE against a correct bundle.
 *
 * The stamp was built on the argument that only the artifact recording its own provenance answers
 * a content question. It then recorded a commit id, which is a REFERENCE to content and not the
 * content. `rev-parse <commit>:src` is the fact itself: it changes exactly when src/ changes and
 * is unmoved by every commit that cannot have affected the answer.
 *
 * IT IS BLIND TO THE WORKING TREE BY CONSTRUCTION — it reads the commit object. That is why
 * stamp.dirtySrc and current.dirtySrc stay SEPARATE signals and must not be folded into it: the
 * tree hash answers "which committed source", the dirty flags answer "is anything uncommitted".
 * Merging them would trade this over-fire for an under-fire, which is the worse direction.
 */
export function srcTreeAt(root, commit) {
  return git(root, ['rev-parse', `${commit}:src`]);
}

/** Committed src tree, HEAD hash, and whether src/ has uncommitted changes, right now. */
export function currentProvenance(root) {
  return {
    head: git(root, ['rev-parse', 'HEAD']),
    srcTree: srcTreeAt(root, 'HEAD'),
    // ONLY src/. dist/ is expected to differ, and a dirty README has no bearing on whether the
    // bundle matches its source. Scoping this is what keeps the check from crying wolf daily.
    dirtySrc: git(root, ['status', '--porcelain', '--', 'src']).length > 0,
  };
}

export function writeStamp(root, nowIso) {
  const p = currentProvenance(root);
  const stamp = { head: p.head, srcTree: p.srcTree, dirtySrc: p.dirtySrc, builtAt: nowIso };
  writeFileSync(join(root, STAMP), JSON.stringify(stamp, null, 2) + '\n', 'utf-8');
  return stamp;
}

/**
 * Read the stamp and normalise it, so both call sites branch on the same shape.
 *
 * BACK-COMPAT IS NOT COURTESY HERE, IT IS THE POINT. The stamp already on disk was written before
 * srcTree existed, and treating a missing field as unverifiable would manufacture exactly the
 * false finding this change removes. It carries `head`, and the tree of that commit is derivable —
 * so an old stamp stays FULLY verifiable and the swap costs no rebuild and no restart.
 *
 * If the recorded commit is gone (rebase, gc), the tree is genuinely underivable. That is
 * UNVERIFIABLE, a finding about the bundle, and NOT could-not-run: the tool worked fine.
 */
export function readStamp(root) {
  const path = join(root, STAMP);
  if (!existsSync(path)) return null;
  const stamp = JSON.parse(readFileSync(path, 'utf-8'));
  if (stamp.srcTree) return stamp;
  try {
    return { ...stamp, srcTree: srcTreeAt(root, stamp.head), srcTreeDerived: true };
  } catch {
    return { ...stamp, srcTree: null, srcTreeDerived: true };
  }
}

/** Max gap between a bundle's mtime and its stamp before the stamp is not believable as a postbuild step. */
export const STAMP_LAG_TOLERANCE_MS = 60_000;

/**
 * Pure verdict logic so the self-test can drive it with fabricated inputs — the same separation
 * guard-arm-check uses, and the reason its verdicts are testable at all.
 */
export function verdict({ stamp, current, bundleMtime }) {
  // THE FOOTGUN THIS GUARDS. Running `--write` by hand stamps the CURRENT HEAD onto whatever
  // bundle happens to be on disk. On this machine right now that would claim a bundle built at
  // 00:16:47Z from a pre-commit working tree was built from HEAD — a false receipt, produced by
  // the tool built to stop exactly that.
  //
  // And the motive is real: --write is the fastest way to make an UNVERIFIABLE go away, which is
  // editing the subject to silence the detector. So the stamp has to be checkable as having been
  // written BY a build, not merely present.
  //
  // A stamp far newer than the artifact it describes was not written by the build that produced it.
  if (stamp && bundleMtime && new Date(stamp.builtAt) - bundleMtime > STAMP_LAG_TOLERANCE_MS) {
    return { code: 2, status: 'UNVERIFIABLE',
      detail: `stamp says ${stamp.builtAt} but the bundle's mtime is ${bundleMtime.toISOString()} — the stamp was written well after the bundle, so it was not produced by that build. Rebuild rather than re-stamping.` };
  }
  if (!stamp) {
    return { code: 2, status: 'UNVERIFIABLE',
      detail: 'no dist/.build-stamp — this bundle predates provenance stamping, or the build did not write one. Absence is NOT evidence the bundle is current.' };
  }
  if (stamp.dirtySrc) {
    return { code: 2, status: 'UNVERIFIABLE',
      detail: `bundle was built from a DIRTY src/ at ${stamp.builtAt}. The exact source is not recoverable from any commit, so currency cannot be established — rebuild from a clean tree to get a checkable answer.` };
  }
  // The commit that recorded this stamp is no longer reachable, so its src tree cannot be
  // recovered. A finding about the bundle, not a broken tool.
  if (!stamp.srcTree) {
    return { code: 2, status: 'UNVERIFIABLE',
      detail: `stamp names commit ${String(stamp.head).slice(0, 8)}, which is no longer in this repository, so the source it was built from cannot be recovered. Rebuild.` };
  }
  // COMPARES THE src TREE, NOT HEAD. A commit touching only docs, scripts or agent files leaves
  // this identical and correctly reads CURRENT. See srcTreeAt for the three-proxy history.
  if (stamp.srcTree !== current.srcTree) {
    return { code: 2, status: 'STALE',
      detail: `bundle built from src tree ${stamp.srcTree.slice(0, 8)} (commit ${String(stamp.head).slice(0, 8)}), HEAD's src tree is now ${current.srcTree.slice(0, 8)}. Rebuild.` };
  }
  if (current.dirtySrc) {
    return { code: 2, status: 'STALE',
      detail: `bundle matches HEAD's src tree (${stamp.srcTree.slice(0, 8)}) but src/ has uncommitted changes that are not in it. Rebuild.` };
  }
  // SAYS TREE, NOT COMMIT. It read "at the same commit" for one commit after the comparand swap,
  // which was false the moment it mattered most: HEAD was f5f6c1a6 and the stamp named 452c0c19,
  // a DIFFERENT commit with the same src tree — precisely the case this leg now passes. A pass
  // whose wording describes the old predicate is how the next reader re-derives the old bug.
  return { code: 0, status: 'CURRENT',
    detail: `bundle built from src tree ${stamp.srcTree.slice(0, 8)} (commit ${String(stamp.head).slice(0, 8)}), which is HEAD's src tree, and the working tree is clean.` };
}

// --- CLI, ONLY WHEN THIS FILE IS THE ENTRY POINT ----------------------------
// Guarded because guard-arm-check.mjs now IMPORTS this module. Without the guard, running
// `node work/guard-arm-check.mjs --self-test` matched THIS file's `argv[2] === '--self-test'` at
// import time, so build-stamp's suite ran, printed 7/7, exited 0 — and the guard's own cases never
// executed. A green self-test for a file that was never tested.
//
// It was caught only because the gate specified the expected output exactly ("3 clean and 3
// firing") and what came back said "7/7 cases, all three verdicts reachable". A pre-registered
// expectation caught a passing result that a bare exit code would have waved through.
const IS_ENTRY = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// --- self-test -------------------------------------------------------------
if (IS_ENTRY && process.argv[2] === '--self-test') {
  const H = 'a'.repeat(40), H2 = 'b'.repeat(40);
  const T = '1'.repeat(40), T2 = '2'.repeat(40);   // src TREE hashes — the comparand
  const cases = [
    ['clean match',        { stamp: { head: H, srcTree: T, dirtySrc: false, builtAt: 't' }, current: { head: H, srcTree: T, dirtySrc: false } }, 0, 'CURRENT'],
    // THE CASE THE WHOLE CHANGE EXISTS FOR, and it is a CLEAN one. A commit that touches only
    // docs/scripts/agent files moves HEAD and leaves src/ untouched, so the bundle is still
    // correct. Measured live on 2026-08-01: 452c0c19:src == f5f6c1a6:src == 061239e3, and the
    // HEAD-comparing version called that STALE-BUNDLE. Revert the comparand to head and this
    // goes red — which is the point of asserting it rather than describing it in a comment.
    ['commit moved, src tree unchanged',
                           { stamp: { head: H, srcTree: T, dirtySrc: false, builtAt: 't' }, current: { head: H2, srcTree: T, dirtySrc: false } }, 0, 'CURRENT'],
    ['src tree changed',   { stamp: { head: H, srcTree: T, dirtySrc: false, builtAt: 't' }, current: { head: H2, srcTree: T2, dirtySrc: false } }, 2, 'STALE'],
    // CONTROL FOR THE ABOVE PAIR: src can change WITHOUT a new commit. The tree hash is blind to
    // the worktree by construction, so this is caught by current.dirtySrc and nothing else. If
    // anyone ever folds dirtySrc into the tree comparison, this case is what goes red.
    ['uncommitted now',    { stamp: { head: H, srcTree: T, dirtySrc: false, builtAt: 't' }, current: { head: H, srcTree: T, dirtySrc: true } },  2, 'STALE'],
    ['built from dirty',   { stamp: { head: H, srcTree: T, dirtySrc: true,  builtAt: 't' }, current: { head: H, srcTree: T, dirtySrc: false } }, 2, 'UNVERIFIABLE'],
    ['no stamp',           { stamp: null, current: { head: H, srcTree: T, dirtySrc: false } },                                                    2, 'UNVERIFIABLE'],
    // readStamp could not derive a tree because the recorded commit is gone (rebase, gc).
    ['stamp commit gone',  { stamp: { head: H, srcTree: null, dirtySrc: false, builtAt: 't', srcTreeDerived: true }, current: { head: H2, srcTree: T, dirtySrc: false } }, 2, 'UNVERIFIABLE'],
    // The hand-written-stamp footgun: stamp two hours newer than the bundle it claims to describe.
    ['stamp after build',  { stamp: { head: H, srcTree: T, dirtySrc: false, builtAt: '2026-07-31T09:00:00Z' },
                             current: { head: H, srcTree: T, dirtySrc: false }, bundleMtime: new Date('2026-07-31T07:00:00Z') }, 2, 'UNVERIFIABLE'],
    // CONTROL: a stamp written BY the build sits within seconds of it and must stay CURRENT — a
    // lag check that rejects every stamp is as useless as one that rejects none.
    ['stamp from build',   { stamp: { head: H, srcTree: T, dirtySrc: false, builtAt: '2026-07-31T07:00:03Z' },
                             current: { head: H, srcTree: T, dirtySrc: false }, bundleMtime: new Date('2026-07-31T07:00:00Z') }, 0, 'CURRENT'],
  ];
  let pass = 0;
  for (const [name, input, wantCode, wantStatus] of cases) {
    const v = verdict(input);
    const ok = v.code === wantCode && v.status === wantStatus;
    if (ok) pass++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(18)} -> ${v.status} (${v.code}), want ${wantStatus} (${wantCode})`);
  }
  // EVERY verdict reachable, not just "some fire and some do not". A status that no input can
  // produce is dead code pretending to be a safety net.
  const reached = new Set(cases.map(([, i]) => verdict(i).status));
  const allThree = ['CURRENT', 'STALE', 'UNVERIFIABLE'].every(s => reached.has(s));
  // NO verdict may return 3. 3 means "this tool did not work" and verdict() only ever runs when it
  // did. Asserted as an INVARIANT rather than left to the per-case codes above, because those pin
  // the cases someone thought to write and this pins the boundary itself — the mapping drifted to 3
  // once already and each individual case looked locally reasonable while it did.
  const noThree = cases.every(([, i]) => verdict(i).code !== 3);
  console.log(`\nself-test: ${pass}/${cases.length} cases, all three verdicts reachable: ${allThree}, no verdict returns 3: ${noThree}`);
  process.exit(pass === cases.length && allThree && noThree ? 0 : 1);
}

const mode = IS_ENTRY ? process.argv[2] : null;
// Explicit argument overrides, for tests that need to point at a scratch repo. The DEFAULT is the
// location-derived root, never cwd.
const root = process.argv[3] || REPO_ROOT;
if (mode === '--write') {
  console.log('wrote', JSON.stringify(writeStamp(root, new Date().toISOString())));
  process.exit(0);
}
if (mode === '--check') {
  const stamp = readStamp(root);
  const bundle = join(root, 'dist/daemon.js');
  const bundleMtime = existsSync(bundle) ? statSync(bundle).mtime : null;
  const v = verdict({ stamp, current: currentProvenance(root), bundleMtime });
  console.log(`${v.status}: ${v.detail}`);
  process.exit(v.code);
}
// Also guarded: unguarded, importing this module fell straight through to here and killed the
// IMPORTING process with exit 3 before it ran a line of its own.
if (IS_ENTRY) {
  console.error('usage: --write [root] | --check [root] | --self-test');
  process.exit(3);
}
