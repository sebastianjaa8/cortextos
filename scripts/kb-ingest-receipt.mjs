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
import { existsSync, appendFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * Pure verdict logic so --self-test can drive it without touching the CLI.
 * @returns {{code:0|2|3, status:string, detail:string}}
 */
export function verdict({ missingPaths, tokens, ingestFailed }) {
  // ORDER MATTERS AND THIS ORDER IS THE POINT. A missing path is reported as a
  // missing path, NOT as "0 tokens" — they have different remedies (fix the
  // path vs investigate the ingest) and the CLI itself conflates them by
  // exiting 0 either way. Checking paths first is what un-conflates them.
  if (missingPaths.length) {
    return { code: 2, status: 'PATH-MISSING',
      detail: `${missingPaths.length} input path(s) do not exist: ${missingPaths.join(', ')}. ` +
        `kb-ingest EXITS 0 on a missing path and reports 0 chunks, so this would otherwise read as a clean run.` };
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
  if (tokens === 0) {
    return { code: 2, status: 'ZERO-TOKENS',
      detail: 'the ingest completed and embedded NOTHING. The step ran and the memory store did not change.' };
  }
  return { code: 0, status: 'INGESTED', detail: `${tokens} embedding tokens.` };
}

function selfTest() {
  const cases = [
    ['parses a thousands-separated count', () => parseEmbeddingTokens('  Tokens: 94,500 embedding, 0 gen-input') === 94500],
    ['parses a bare count', () => parseEmbeddingTokens('Tokens: 12 embedding') === 12],
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
    // Asserting only the CODE would pass while the receipt says nothing useful,
    // which is the failure this file already made once. The reason must survive
    // into the detail, or COULD-NOT-RUN is a dead end for whoever reads it.
    ['the failure REASON reaches the detail', () =>
      verdict({ missingPaths: [], tokens: null, ingestFailed: 'spawn EINVAL' }).detail.includes('spawn EINVAL')],
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
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};
const agent = flag('--agent') || process.env.CTX_AGENT_NAME;
const org = flag('--org') || process.env.CTX_ORG;
const paths = argv.filter((a, i) => !a.startsWith('--') && !['--agent', '--org'].includes(argv[i - 1]));

if (!agent || !org) {
  console.log('VERDICT: COULD-NOT-RUN — need --agent and --org (or CTX_AGENT_NAME / CTX_ORG).');
  process.exit(3);
}
if (!paths.length) {
  console.log('VERDICT: COULD-NOT-RUN — no input paths given.');
  process.exit(3);
}

// EXISTENCE IS CHECKED HERE, BEFORE THE CLI SEES IT, because the CLI's answer to
// a missing path is a clean exit 0 — verified 2026-08-01, not assumed.
const missingPaths = paths.filter((p) => !existsSync(p));

// CALLS dist/cli.js WITH node DIRECTLY, not the `cortextos` shim. The shim is a
// .cmd on Windows, and Node has refused to execFile a .cmd without a shell since
// CVE-2024-27980 — measured, not guessed: the first version used the shim and
// returned COULD-NOT-RUN on a perfectly good file. Going through a shell instead
// would work and would put every path through shell quoting, on a box where a
// path already behaves differently as argv than as a string. This resolves the
// CLI relative to THIS file, so it does not depend on cwd or PATH either.
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

let stdout = '';
let ingestFailed = null;
if (!missingPaths.length) {
  if (!existsSync(CLI)) {
    ingestFailed = `no CLI bundle at ${CLI} — run npm run build.`;
  } else {
    try {
      stdout = execFileSync(
        process.execPath,
        [CLI, 'bus', 'kb-ingest', ...paths, '--org', org, '--agent', agent, '--scope', 'private', '--force'],
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
      );
    } catch (err) {
      ingestFailed = (err.message || String(err)).split('\n')[0];
      stdout = `${err.stdout || ''}${err.stderr || ''}`;
    }
  }
}

const tokens = parseEmbeddingTokens(stdout);
const { code, status, detail } = verdict({ missingPaths, tokens, ingestFailed });

// THE RECEIPT IS WRITTEN ON EVERY OUTCOME, INCLUDING THE BAD ONES. A receipt
// that only appears on success cannot distinguish "failed" from "never ran",
// which is the exact pair that made this invisible in the first place.
const root = process.env.CTX_ROOT || `${process.env.HOME}/.cortextos/default`;
const receipt = `${root.replace(/\\/g, '/')}/state/${agent}/.kb-ingest-receipts.jsonl`;
try {
  mkdirSync(dirname(receipt), { recursive: true });
  appendFileSync(receipt, JSON.stringify({
    ts: new Date().toISOString(),
    agent, status, tokens,
    // Sizes travel with the receipt so the growth curve is readable from the
    // receipts alone, without re-stat'ing files that have since changed.
    bytes: paths.reduce((n, p) => n + (existsSync(p) ? statSync(p).size : 0), 0),
    paths,
  }) + '\n');
} catch (err) {
  console.log(`NOTE: verdict stands but the receipt could not be written (${err.message}).`);
}

console.log(stdout.trim());
console.log(`VERDICT: ${status} — ${detail}`);
process.exit(code);
