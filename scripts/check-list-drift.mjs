#!/usr/bin/env node
/**
 * check-list-drift — the OTHER half of GUARDRAIL 83 (task_1785619356320_68235008).
 *
 * cli-doc-drift.mjs catches a DOCUMENTED INVOCATION drifting from --help (the CLI's own ground
 * truth). This catches the sibling failure: a LIST OF NAMES (agents, crons, files, statuses)
 * copied into a report, a doc, or a message, drifting from whatever enumerates it live.
 *
 * WHY THIS IS DELIBERATELY DULL. seb_boss's incident (2026-07-31) was a copied agent table that
 * had gone stale — nothing in the copy itself could reveal that, because a copy is internally
 * consistent by construction. The fix is not a new discipline, just a diff run before publishing:
 * pipe the live enumeration in, name the copy, get MISSING/EXTRA back. Two sets, one diff.
 *
 * USAGE
 *   <live-source-command> | node check-list-drift.mjs --against "a,b,c"
 *   <live-source-command> | node check-list-drift.mjs --against-file report.md
 *   node check-list-drift.mjs --self-test
 *
 * Live list comes from stdin, one identifier per line (or comma-separated — both accepted so a
 * `list-agents --format json | jq -r '.[].name'` pipe and a plain `echo "a,b,c"` both work).
 * The copy comes from --against (inline) or --against-file (path; identifiers extracted as any
 * `[a-z][a-z0-9_-]{2,}` token — deliberately loose, since a copy in a doc is prose around a list,
 * not a clean array. Loose extraction over-reports EXTRA before it ever under-reports MISSING:
 * the failure direction that matters (a stale copy silently short) is what tightening protects.)
 */
import fs from 'node:fs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function parseList(text) {
  return new Set(
    text
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

function extractTokens(text) {
  return new Set((text.match(/\b[a-z][a-z0-9_-]{2,}\b/gi) || []).map((s) => s.toLowerCase()));
}

function diff(live, copy) {
  const missing = [...live].filter((x) => !copy.has(x.toLowerCase())).sort();
  const extra = [...copy].filter((x) => !live.has(x) && ![...live].some((l) => l.toLowerCase() === x)).sort();
  return { missing, extra };
}

function report(live, copy, label) {
  const { missing, extra } = diff(live, copy);
  console.log(`check-list-drift: live=${live.size}  copy=${copy.size}  (${label})`);
  console.log(`  MISSING from copy (live has it, copy does not) — ${missing.length}`);
  for (const m of missing) console.log(`    ${m}`);
  console.log(`  EXTRA in copy (copy has it, live does not — stale/retired/typo) — ${extra.length}`);
  for (const e of extra) console.log(`    ${e}`);
  if (!missing.length && !extra.length) console.log('  clean — copy matches live enumeration');
  return missing.length + extra.length;
}

// ---------------------------------------------------------------------------
if (args.includes('--self-test')) {
  const cases = [
    ['identical sets are clean', new Set(['a', 'b', 'c']), new Set(['a', 'b', 'c']), 0],
    ['copy missing a live member (the failure that matters)', new Set(['a', 'b', 'c']), new Set(['a', 'b']), 1],
    ['copy has a retired/extra member', new Set(['a', 'b']), new Set(['a', 'b', 'zombie']), 1],
    ['case differs, still matches (agent names are case-insensitive here)', new Set(['Seb_Boss']), new Set(['seb_boss']), 0],
    ['both directions at once', new Set(['a', 'b', 'c']), new Set(['a', 'zombie']), 3],
  ];
  let pass = 0;
  const fail = [];
  for (const [label, live, copy, wantTotal] of cases) {
    const { missing, extra } = diff(live, copy);
    const got = missing.length + extra.length;
    if (got === wantTotal) pass += 1;
    else fail.push({ label, wantTotal, got, missing, extra });
  }
  console.log(`check-list-drift --self-test: ${pass}/${cases.length}`);
  if (fail.length) {
    console.log('FAILURES:');
    for (const f of fail) console.log(`  ${f.label}: want ${f.wantTotal}, got ${f.got}`, f);
    console.log('');
    console.log('A diff that cannot separate MISSING from EXTRA on these 5 cases is the vacuous-check');
    console.log('shape this tool exists to avoid becoming: never having been shown able to fail.');
    process.exit(2);
  }
  console.log('BOUNDARY: this proves the set-diff itself is correct on 5 fixtures. It does NOT prove');
  console.log('extractTokens() picks the right tokens out of real prose — that depends on the doc.');
  process.exit(0);
}

const liveText = fs.readFileSync(0, 'utf8').trim();
if (!liveText) {
  console.error('no live list on stdin. Usage: <source-command> | node check-list-drift.mjs --against "a,b,c"');
  process.exit(3);
}
const live = parseList(liveText);

let copy, label;
if (flag('--against')) {
  copy = parseList(flag('--against'));
  label = 'inline --against list, exact tokens';
} else if (flag('--against-file')) {
  const path = flag('--against-file');
  copy = extractTokens(fs.readFileSync(path, 'utf8'));
  label = `extracted from ${path}, loose token match`;
} else {
  console.error('need --against "a,b,c" or --against-file <path>');
  process.exit(3);
}

const total = report(live, copy, label);
process.exit(total ? 1 : 0);
