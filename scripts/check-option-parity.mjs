#!/usr/bin/env node
/**
 * Hazard 13: THE INTERFACE IS A LOSSY PROJECTION OF THE LIBRARY, AND NOTHING COMPARES THEM.
 *
 * Two confirmed instances on this box before this existed:
 *
 *  1. `createTask` accepted `dueDate`. No CLI path ever passed it. So no task could carry a due
 *     date, so `check-stale-tasks` reported zero overdue STRUCTURALLY AND FOREVER — and that was
 *     read as good news the entire time. A gap that rendered its own health metric unfalsifiable.
 *  2. `mmrag.py` takes `--collection`. The Node `kb-ingest` CLI that replaced the shell wrapper
 *     never exposed it. Documented in nine places for seven weeks as a flag you could pass.
 *
 * THE PAIR, and the reason this is a diff rather than a judgement call: for a function whose
 * options parameter declares keys {a, b, c}, take the UNION of keys actually passed by every call
 * site in the repo. Anything declared and never passed by anyone is unreachable — the library can
 * do it and no caller can ask for it.
 *
 * Deliberately NOT name-matching option flags to keys (`dueDate` -> `--due`? `--due-date`?). That
 * would be a heuristic, and a heuristic is what puts a checker back in the business of being wrong
 * in the reassuring direction. Passed-vs-declared needs no naming convention to be correct.
 *
 * STATED BOUNDARIES — a clean score needs its denominator more urgently than a dirty one:
 *  - SYNTACTIC, not type-checked. Only functions whose options parameter is an INLINE type literal
 *    are analysed. Functions typing that parameter as a named interface are SKIPPED AND COUNTED,
 *    because an unstated skip is a shrinking denominator that reads as a clean bill of health.
 *  - Cross-LANGUAGE losses are invisible here. Instance 2 above (Node CLI vs a Python script's
 *    argparse) is NOT covered by this tool and will not be caught by it.
 *  - A spread (`{...opts}`) at a call site is treated as passing UNKNOWN keys, so that call site is
 *    counted as satisfying everything. Fails toward silence rather than toward a false finding.
 *  - TESTS ARE NOT SCANNED, and that is a DESIGN DECISION rather than an oversight. Counting a test
 *    as a caller would have suppressed the most serious thing this tool found on its first run:
 *    `prepareSubmission`'s `orgContext`/`userNames` PII checks are passed ONLY by
 *    tests/sprint4-catalog.test.ts, so the suite proves those checks WORK while no production
 *    caller supplies them. A green test on an unreachable capability is evidence the code is
 *    correct and evidence of nothing at all about whether anyone can reach it. The question here is
 *    reachability from a real caller, so `src/` is the set the fact lives in.
 *
 * Exit codes distinguish DIAGNOSES, not just success/failure:
 *   0 = no unreachable keys    2 = findings    3 = could not run
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import ts from 'typescript';

// Root is an ARGUMENT, defaulting to this repo. Hardcoding it made the checker untestable: a
// fixture tree needs its own node_modules to resolve `typescript` if the script is copied into it,
// so the script must stay put and be POINTED at the tree instead. A checker that can only ever
// examine the repo it lives in also cannot be pointed at a worktree or a sibling checkout.
const REPO = process.argv[2] ?? join(fileURLToPath(import.meta.url), '..', '..');
const ROOTS = ['src'];

/** Keys that are legitimately internal — passed by tests or other libraries, not by a CLI. */
const ALLOWLIST = new Set([
  // (empty today; every entry here shrinks the denominator, so each one needs a reason beside it)
]);

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

let files;
try {
  files = ROOTS.flatMap((r) => walk(join(REPO, r)));
} catch (err) {
  // An unreadable/absent tree is COULD-NOT-RUN (3), never a clean pass (0). Those two being the
  // same code is what lets a wrong invocation read as a clean bill of health.
  console.error(`could not run: ${String(err)}`);
  process.exit(3);
}
if (files.length === 0) {
  console.error('could not run: no source files found under ' + REPO);
  process.exit(3);
}

const sources = new Map();
for (const f of files) {
  sources.set(f, ts.createSourceFile(f, readFileSync(f, 'utf-8'), ts.ScriptTarget.Latest, true));
}

// ---- pass 1: functions with an INLINE options type literal ------------------------------------
/** name -> { file, keys:Set, skipped:false } */
const declared = new Map();
let skippedNamedType = 0;

for (const [file, sf] of sources) {
  ts.forEachChild(sf, function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name && node.parameters.length) {
      const last = node.parameters[node.parameters.length - 1];
      const isOptionsish = /^(options|opts)$/.test(last.name.getText(sf));
      if (isOptionsish) {
        let t = last.type;
        // `opts?: {...}` and `options: {...} = {}` both land here.
        if (t && ts.isTypeLiteralNode(t)) {
          const keys = new Set(
            t.members
              .filter((m) => ts.isPropertySignature(m) && m.name)
              .map((m) => m.name.getText(sf)),
          );
          if (keys.size) declared.set(node.name.getText(sf), { file, keys });
        } else if (t) {
          // Named interface / imported type: out of reach syntactically. COUNTED, not ignored.
          skippedNamedType++;
        }
      }
    }
    ts.forEachChild(node, visit);
  });
}

// ---- pass 2: keys actually passed, union across every call site -------------------------------
/** fnName -> { passed:Set, sites:[], sawSpread:bool } */
const usage = new Map();
for (const name of declared.keys()) usage.set(name, { passed: new Set(), sites: [], sawSpread: false });

for (const [file, sf] of sources) {
  ts.forEachChild(sf, function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = ts.isIdentifier(node.expression)
        ? node.expression.getText(sf)
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.getText(sf)
          : null;
      const rec = callee && usage.get(callee);
      if (rec) {
        const objArg = [...node.arguments].reverse().find((a) => ts.isObjectLiteralExpression(a));
        if (objArg) {
          rec.sites.push(`${relative(REPO, file)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
          for (const p of objArg.properties) {
            if (ts.isSpreadAssignment(p)) { rec.sawSpread = true; continue; }
            if (p.name) rec.passed.add(p.name.getText(sf));
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  });
}

// ---- report -----------------------------------------------------------------------------------
const findings = [];
for (const [fn, { file, keys }] of declared) {
  const u = usage.get(fn);
  if (!u || u.sites.length === 0) continue;   // never called with an object literal: nothing to compare
  if (u.sawSpread) continue;                   // unknown keys in play; fail toward silence
  const missing = [...keys].filter((k) => !u.passed.has(k) && !ALLOWLIST.has(k));
  if (missing.length) {
    findings.push({ fn, file: relative(REPO, file), missing, sites: u.sites });
  }
}

if (findings.length === 0) {
  console.log('No unreachable options keys: every key declared by an analysed function is passed by at least one caller.');
} else {
  console.log(`${findings.length} function(s) declare option keys NO CALLER EVER PASSES — the library can do it, nothing can ask for it:\n`);
  for (const f of findings) {
    console.log(`  ${f.fn}  (${f.file})`);
    console.log(`      unreachable: ${f.missing.join(', ')}`);
    console.log(`      callers checked: ${f.sites.join(', ')}`);
  }
  console.log('\nEach one is a capability the implementation has and the interface dropped. That is');
  console.log('how due_date stayed unsettable while check-stale-tasks reported zero overdue as good news.');
}

// COVERAGE, always, next to the pass — this tool is exactly the kind whose clean run is a claim.
console.log(
  `\nCoverage: ${declared.size} function(s) with an inline options type analysed; ` +
    `${skippedNamedType} skipped for typing that parameter as a named interface (invisible to a ` +
    `syntactic check, NOT verified clean). Cross-language losses are out of scope entirely.`,
);

process.exit(findings.length === 0 ? 0 : 2);
