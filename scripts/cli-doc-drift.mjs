#!/usr/bin/env node
/**
 * CLI doc-vs-help drift check — THREE directions.
 *
 *   (a) DOCUMENTED, DOES NOT EXIST      agents write commands that fail loudly
 *   (b) DENIED, ACTUALLY EXISTS         agents stop looking, nothing ever re-tests it
 *   (c) EXISTS, ABSENT FROM CONTRACTS   capability the fleet is collectively unaware of
 *
 * (c) IS A COVERAGE FRACTION, NOT A BINARY. "documented nowhere" was the original framing and it
 * was FALSE: send-message-file is in 1 of 15 live contracts, not 0. "One agent was told and
 * fourteen were not" is a measurement; absent/present is not. So (c) reports, for every command
 * --help exposes, what fraction of contracts mention it — which also answers a question nobody
 * asked: which capabilities is this fleet collectively unaware of, ranked.
 *
 * --help IS THE GROUND TRUTH AND IS PARSED, NEVER HARDCODED. A hardcoded flag list is a second
 * document that decays exactly like the first one, which is the defect this tool exists to find.
 *
 *   node work/cli-doc-drift.mjs [--json] [--verbose]
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO = 'C:/Users/Sebas/cortextos';
const CLI = path.join(REPO, 'dist/cli.js');
const JSON_OUT = process.argv.includes('--json');

// ---------------------------------------------------------------------------
// EXCLUSIONS — a blocking constraint, not tidy-up.
//
// A naive recursive scan reported 30 live contracts still carrying a flag that was FIXED, because
// it read 21 pre-fix AGENTS.md snapshots sitting in the SCANNING AGENT'S OWN work directory. A
// scanner that resurrects every defect we have ever fixed, out of a backup of the broken state, is
// worse than no scanner: it manufactures work, and the first phantom costs it the credibility it
// needs to be believed on a real finding.
//
// The skips are REPORTED, not silent, so a reader can tell a narrow scan from a clean tree.
// ---------------------------------------------------------------------------
const EXCLUDE = [
  { re: /NOT-A-BACKUP|[\\/]backups?[\\/]|-was-inside-scan-path/i, why: 'backup/snapshot of a pre-fix state' },
  { re: /node_modules/, why: 'dependency tree' },
  { re: /[\\/]\.git[\\/]/, why: 'git internals' },
  { re: /[\\/]dev[\\/]finance-tracker/i, why: 'separate project, HELD-BY-OWNER' },
  { re: /[\\/]archive[\\/]|[\\/]_archive[\\/]|[\\/]_trash[\\/]/i, why: 'archived' },
];
const excluded = [];
function keep(file) {
  for (const e of EXCLUDE) {
    if (e.re.test(file)) { excluded.push({ file, why: e.why }); return false; }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Ground truth from --help
// ---------------------------------------------------------------------------
const help = (args) => {
  try {
    return execFileSync(process.execPath, [CLI, ...args, '--help'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { return String(e.stdout || ''); }
};

/** Command names from a commander help block: two-space indent, then the name. */
function parseCommands(text) {
  const out = new Set();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s{2}([a-z][a-z0-9-]{2,})(?:\s|$)/);
    if (m && !['options', 'commands', 'arguments', 'usage'].includes(m[1])) out.add(m[1]);
  }
  return out;
}
function parseFlags(text) {
  const out = new Set();
  for (const m of text.matchAll(/(^|\s)(--[a-z][a-z0-9-]+)/g)) out.add(m[2]);
  return out;
}

const busCommands = parseCommands(help(['bus']));
const flagCache = new Map();
function flagsFor(cmd) {
  if (!flagCache.has(cmd)) flagCache.set(cmd, parseFlags(help(['bus', cmd])));
  return flagCache.get(cmd);
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------
function collect() {
  const files = [];
  const push = (p) => { if (fs.existsSync(p) && keep(p)) files.push(p); };
  const walk = (dir, match) => {
    if (!fs.existsSync(dir)) return;
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) { if (keep(p)) walk(p, match); }
      else if (match(d.name)) push(p);
    }
  };
  // Live agent contracts: exactly one level, no subdirs — the subdir sweep is what pulled in
  // the snapshot copies.
  const agentsRoot = path.join(REPO, 'orgs');
  for (const org of fs.existsSync(agentsRoot) ? fs.readdirSync(agentsRoot) : []) {
    const agents = path.join(agentsRoot, org, 'agents');
    if (!fs.existsSync(agents)) continue;
    for (const a of fs.readdirSync(agents)) {
      push(path.join(agents, a, 'AGENTS.md'));
      if (a === '.shared') walk(path.join(agents, a), (n) => n.endsWith('.md'));
    }
  }
  walk(path.join(REPO, 'community'), (n) => n === 'AGENTS.md');
  walk(path.join(REPO, 'templates'), (n) => n === 'AGENTS.md');
  // TEST HOOK. Exists so the detectors and the exclusion can be SABOTAGED against planted files
  // without writing into .shared or any live contract (zero-edits rule). The exclusion reported
  // "SKIPPED 0" on the real tree, which is a vacuous safeguard until something is shown to trip it.
  const extraIdx = process.argv.indexOf('--extra');
  if (extraIdx >= 0 && process.argv[extraIdx + 1]) {
    walk(path.resolve(process.argv[extraIdx + 1]), (n) => n.endsWith('.md'));
  }
  return [...new Set(files)];
}

const files = collect();
const contracts = files.filter((f) => f.endsWith('AGENTS.md'));

// A WARNING about a bad flag and a USE of a bad flag are THE SAME STRING. If they cannot be told
// apart, report both and MARK the ambiguity rather than picking one and being silently wrong.
const WARNS_RE = /\b(does not exist|do not exist|no such|dead|WRONG|NOT a real|is not a flag|rejects|fails loudly|nonexistent|never existed|removed)\b/i;

/**
 * Is this line WARNING about a bad flag, rather than USING one?
 *
 * TEST THE PROSE, NOT THE IDENTIFIERS. v1 ran the regex over the whole line, so a flag whose NAME
 * happened to contain a warning word classified its own use as a warning and was demoted out of
 * direction (a) entirely. Caught by a discriminating pair: two identical lines differing only in
 * the flag name — `--nonexistent-flag-abc123` landed in AMBIGUOUS, `--plainflag-abc123` landed in
 * (a). A real documented `--dead-letter` or `--removed-only` would have silently disappeared.
 *
 * Found because analyst reported the splitter firing on their synthetic bait as PROOF IT WORKS. It
 * fired for the wrong reason — the bait was named `--nonexistent-flag-abc123`. Green for the wrong
 * reason, one more time, and this one arrived labelled as validation.
 */
function warnsAboutIt(line) {
  const prose = line
    .replace(/`[^`]*`/g, ' ')        // code spans hold identifiers, not commentary
    .replace(/--[a-z0-9-]+/gi, ' ')  // bare flags outside spans
    .replace(/\b[a-z]+(-[a-z0-9]+){2,}\b/gi, ' '); // long kebab identifiers
  return WARNS_RE.test(prose);
}

// Prose denials for direction (b).
const DENY = /\b(cannot|can't|no way to|there is no|unable to|not possible|only exposes|does not support|has no|impossible to)\b/i;

const findings = { a: [], b: [], ambiguous: [] };

for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    // ---- direction (a): documented invocation that does not exist ----
    // SHARPER PREDICATE, not a threshold. v1 matched /\bbus\s+(word)/ and pulled in every English
    // sentence using "bus dispatch", "bus messages", "bus per", "bus seb_boss" — 24 of 25 findings
    // were prose. The fix is not to filter the output, it is to require the text to LOOK LIKE AN
    // INVOCATION: prefixed by `cortextos`, or inside a backtick code span. Documentation telling an
    // agent what to run does one of those; prose that happens to use the word "bus" does neither.
    const spans = [...line.matchAll(/`([^`]+)`/g)].map((x) => x[1]).join('   ');
    const runs = (line.match(/cortextos\s+bus\s+[^.,;)]*/g) || []).join('   ');
    const invocationText = `${spans}   ${runs}`;
    // FLAGS ARE NOT ADJACENT TO THE COMMAND. v2 matched `bus <cmd>(\s+--flag)*`, which requires the
    // flag to follow the command name immediately. Real documented invocations put positional args
    // in between — `update-task <id> --title`, `create-task "<t>" --desc`. Sabotage caught this:
    // a planted `bus update-task <id> --frobnicate` did NOT surface, because of `<id>`. The control
    // instance passed only by luck, its flag happening to sit directly after the command.
    // So: capture the command, then take the REST of the invocation span and read every flag in it.
    for (const m of invocationText.matchAll(/\bbus\s+([a-z][a-z0-9-]{2,})([^`\n]*)/g)) {
      const cmd = m[1];
      const rec = { file: path.relative(REPO, file), line: i + 1, text: line.trim().slice(0, 160) };
      if (!busCommands.has(cmd)) {
        (warnsAboutIt(line) ? findings.ambiguous : findings.a).push({ ...rec, kind: 'command', name: cmd });
        continue;
      }
      const known = flagsFor(cmd);
      const flagsUsed = [...(m[2] || '').matchAll(/(--[a-z][a-z0-9-]+)/g)].map((x) => x[1]);
      for (const f of flagsUsed) {
        if (!known.has(f)) {
          (warnsAboutIt(line) ? findings.ambiguous : findings.a).push({ ...rec, kind: 'flag', name: `${cmd} ${f}` });
        }
      }
    }
    // ---- direction (b): a denial of something that exists ----
    if (DENY.test(line)) {
      for (const m of line.matchAll(/(--[a-z][a-z0-9-]+)|\b([a-z][a-z0-9-]{4,})\b/g)) {
        const flag = m[1];
        const word = m[2];
        if (flag) {
          const owner = [...busCommands].find((c) => flagsFor(c).has(flag) && line.includes(c));
          if (owner) findings.b.push({ file: path.relative(REPO, file), line: i + 1, name: `${owner} ${flag}`, text: line.trim().slice(0, 160) });
        } else if (word && busCommands.has(word)) {
          findings.b.push({ file: path.relative(REPO, file), line: i + 1, name: word, text: line.trim().slice(0, 160) });
        }
      }
    }
  });
}

// ---- direction (c): coverage fraction per command ----
const contractText = contracts.map((f) => ({ f, t: fs.readFileSync(f, 'utf8') }));
const coverage = [...busCommands].map((cmd) => {
  const re = new RegExp(`\\b${cmd.replace(/[-]/g, '\\-')}\\b`);
  const hits = contractText.filter((c) => re.test(c.t));
  return { cmd, n: hits.length, of: contractText.length, files: hits.map((h) => path.basename(path.dirname(h.f))) };
}).sort((x, y) => x.n - y.n || x.cmd.localeCompare(y.cmd));

// ---------------------------------------------------------------------------
const dedupe = (arr) => [...new Map(arr.map((x) => [`${x.file}:${x.line}:${x.name}`, x])).values()];
findings.a = dedupe(findings.a); findings.b = dedupe(findings.b); findings.ambiguous = dedupe(findings.ambiguous);

if (JSON_OUT) {
  console.log(JSON.stringify({ busCommands: busCommands.size, files: files.length, contracts: contracts.length, excluded, findings, coverage }, null, 2));
} else {
  console.log(`cli-doc-drift — ${busCommands.size} bus commands parsed from --help (ground truth, not hardcoded)`);
  console.log(`scanned ${files.length} doc files (${contracts.length} agent contracts)`);
  console.log(`SKIPPED ${excluded.length} path(s), reported not silent:`);
  for (const [why, n] of Object.entries(excluded.reduce((a, e) => ((a[e.why] = (a[e.why] || 0) + 1), a), {}))) {
    console.log(`    ${n.toString().padStart(3)}  ${why}`);
  }

  console.log(`\n(a) DOCUMENTED BUT DOES NOT EXIST — ${findings.a.length}`);
  for (const f of findings.a) console.log(`    ${f.file}:${f.line}  [${f.kind}] ${f.name}\n        ${f.text}`);
  if (!findings.a.length) console.log('    none');

  console.log(`\n(b) DENIED BUT EXISTS — ${findings.b.length}   *** READING LIST, NOT FINDINGS ***`);
  console.log('    DEMONSTRATED ABLE TO FIRE (a planted denial surfaces) and NOT TRUSTWORTHY UNREVIEWED.');
  console.log('    It matches a denial keyword anywhere on a line that also names an existing command, so');
  console.log('    "THERE IS NO ONE-SHOT FIRE IN THIS CLI. `bus add-cron` takes positional args only" flags');
  console.log('    add-cron — the denial is about one-shot fire, not about add-cron. Deciding what a denial');
  console.log('    is ABOUT needs comprehension, not text position. EVERY ENTRY BELOW NEEDS A HUMAN READ.');
  for (const f of findings.b) console.log(`    ${f.file}:${f.line}  ${f.name}\n        ${f.text}`);
  if (!findings.b.length) {
    console.log('    NONE FOUND. This is a reported ZERO, not a clearance: direction (b) needs a prose');
    console.log('    denial naming something that exists, in a scanned file. No in-scope control exists');
    console.log('    for it, so this direction is UNVERIFIED — it has never been shown able to fire.');
  }

  console.log(`\n(?) AMBIGUOUS — line names a nonexistent command/flag AND reads like a warning about it — ${findings.ambiguous.length}`);
  console.log('    A warning about a bad flag and a use of it are the same string. Both reported, neither assumed.');
  if (!findings.ambiguous.length) {
    console.log('    ZERO HERE MEANS UNEXERCISED, NOT CLEAN. This splitter has never seen a real warning:');
    console.log('    the known warning lines live in GUARDRAILS.md and memory files, which are NOT in the');
    console.log('    scanned set. It has therefore never been shown able to fire on real text.');
  }
  for (const f of findings.ambiguous) console.log(`    ${f.file}:${f.line}  ${f.name}\n        ${f.text}`);

  console.log(`\n(c) CAPABILITY COVERAGE across ${contractText.length} agent contracts — least-known first`);
  console.log('    A command at 0/N exists and no contract mentions it: the fleet cannot use what it was never told about.');
  for (const c of coverage.slice(0, 20)) {
    console.log(`    ${String(c.n).padStart(2)}/${c.of}  ${c.cmd}${c.n && c.n <= 3 ? '   (' + c.files.join(', ') + ')' : ''}`);
  }
  const zero = coverage.filter((c) => c.n === 0).length;
  console.log(`\n    ${zero} of ${coverage.length} commands appear in ZERO contracts.`);
}
