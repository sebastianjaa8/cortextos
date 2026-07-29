// Does a cron fire logged as status=fired actually reach the agent's PTY?
//
// `agent-manager` injects `[CRON FIRED <iso>] <name>: <prompt>` into the PTY and the
// PTY echoes it, so it lands in logs/<agent>/stdout.log. That makes stdout.log a
// per-fire DELIVERY ledger the daemon itself does not keep, joinable to
// cron-execution.log on the iso timestamp (which exists as a MessageDedup salt).
//
// Matcher design — both failure directions matter, because either one manufactures
// a finding:
//   FALSE NEGATIVE: PTY writes chunk and terminal redraw injects ANSI mid-string, so
//     a raw includes() scores a DELIVERED fire as dropped. Observed in the wild:
//     a bare "CRON FIRED " with the timestamp separated. Handled by stripping ANSI
//     and all whitespace, then matching in the resulting dense string.
//   FALSE POSITIVE: a bare "20:44:44" appears constantly in 40MB of agent output, so
//     matching a time fragment anywhere in the file undercounts drops. Handled by
//     ANCHORING: the timestamp must sit within ANCHOR_SLACK chars after a
//     "CRONFIRED" banner in the dense string.
// --self-test asserts both directions plus a sabotage line proving the naive matcher
// fails the split case.
//
// Usage: node cron-injection-trace.mjs [agent|--all] [--json]
//        node cron-injection-trace.mjs --self-test
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(os.homedir(), ".cortextos", "default");
const ANCHOR = "CRONFIRED";
const ANCHOR_SLACK = 60; // dense chars between banner and timestamp

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[()][A-Za-z0-9]|\u001b[=>]/g;

// ANSI-stripped and whitespace-free, so chunk splits and terminal redraw cannot
// separate characters that were logically contiguous.
export function densify(s) {
  return s.replace(ANSI, "").replace(/[\s\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

// Collect the text just after every CRONFIRED banner, ONCE. Scanning per-fire is
// O(fires x banners) over tens of MB and does not finish at fleet scale.
export function bannerRegions(dense) {
  const out = [];
  let from = 0;
  for (;;) {
    const a = dense.indexOf(ANCHOR, from);
    if (a === -1) return out;
    const start = a + ANCHOR.length;
    out.push(dense.slice(start, start + ANCHOR_SLACK + 30));
    from = start;
  }
}

// Anchored: the timestamp must appear inside one of those banner regions.
export function reached(dense, ts, regions) {
  const needle = densify(ts);
  const rs = regions || bannerRegions(dense);
  for (const r of rs) {
    if (r.startsWith(needle)) return "anchored-exact";
    if (r.includes(needle)) return "anchored-near";
  }
  return null;
}

function loadFires(agent) {
  const p = path.join(ROOT, ".cortextOS", "state", "agents", agent, "cron-execution.log");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").trim().split(/\r?\n/)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && r.status === "fired");
}

function trace(agent) {
  const fires = loadFires(agent);
  const outPath = path.join(ROOT, "logs", agent, "stdout.log");
  if (!fires.length) return { agent, skip: "no fired records in cron-execution.log" };
  if (!fs.existsSync(outPath)) return { agent, skip: "no stdout.log" };

  const st = fs.statSync(outPath);
  const dense = densify(fs.readFileSync(outPath, "latin1"));
  const regions = bannerRegions(dense);

  // Window floor. Two candidates, and the choice changes the headline:
  //   "iso"    = earliest ISO timestamp anywhere in the log. Too early if the agent
  //              ever ECHOED an old date (reading a file, printing a past record),
  //              which pulls pre-log fires into the window and inflates drops.
  //   "banner" = earliest fire this log actually witnessed. Self-consistent and
  //              conservative: it can only ever UNDERCOUNT (if the log's first fires
  //              were themselves dropped, they fall outside the window).
  // Default banner. --floor=iso reproduces the looser reading for comparison.
  const mode = (process.argv.find((a) => a.startsWith("--floor=")) || "--floor=banner").split("=")[1];
  const isoFloor = (dense.match(/20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d/) || [null])[0];
  const bannerTs = regions
    .map((r) => (r.match(/^\]?(20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d)/) || r.match(/(20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d)/) || [])[1])
    .filter(Boolean).sort();
  const floor = mode === "iso" ? isoFloor : bannerTs[0];
  if (!floor) return { agent, skip: `no ${mode} floor derivable from stdout.log` };

  const inWindow = fires.filter((r) => r.ts >= floor);
  const hits = [], misses = [];
  for (const r of inWindow) {
    const how = reached(dense, r.ts, regions);
    (how ? hits : misses).push({ ts: r.ts, cron: r.cron, how });
  }
  return {
    agent, sizeMB: +(st.size / 1048576).toFixed(1), windowFloor: floor,
    firesTotal: fires.length, inWindow: inWindow.length,
    reached: hits.length, noTrace: misses.length,
    dropPct: inWindow.length ? +((misses.length / inWindow.length) * 100).toFixed(1) : null,
    misses, hits,
  };
}

function selfTest() {
  const ts = "2026-07-29T20:44:44.568Z";
  const cases = [
    // delivered, but terminal redraw split the timestamp -> must be a HIT
    ["ANSI-split banner", `[CRON FIRED 2026-07-29T20:4\u001b[0m4:44.568Z] heartbeat`, true],
    // delivered, chunk boundary put a newline mid-timestamp -> must be a HIT
    ["newline-split banner", `[CRON FIRED 2026-07-29T20:44:4\n4.568Z] heartbeat`, true],
    // a different fire's banner only -> must be a MISS
    ["other fire's banner", `[CRON FIRED 2026-07-29T16:45:06.463Z] heartbeat`, false],
    // the time fragment appears in ordinary output, no banner -> must be a MISS
    ["bare fragment, no banner", `2026-07-29T20:44:44.568Z some unrelated log line`, false],
    // banner far away from the timestamp -> must be a MISS (anchor slack)
    ["banner then distant ts", `[CRON FIRED 2026-07-29T16:45:06.463Z] ${"x".repeat(200)} 2026-07-29T20:44:44.568Z`, false],
  ];
  let ok = true;
  for (const [name, sample, expectHit] of cases) {
    const got = reached(densify(sample), ts);
    const pass = expectHit ? got !== null : got === null;
    if (!pass) ok = false;
    console.log(`${pass ? "ok  " : "FAIL"}  ${name.padEnd(26)} -> ${got ?? "null"} (expect ${expectHit ? "hit" : "miss"})`);
  }
  // sabotage: the naive matcher this replaced must FAIL the split case, proving the
  // dense/anchored version is load-bearing rather than decorative
  const naiveSplit = cases[0][1].includes(ts);
  const naiveBare = cases[3][1].includes(ts);
  const sabOk = naiveSplit === false && naiveBare === true;
  if (!sabOk) ok = false;
  console.log(`${sabOk ? "ok  " : "FAIL"}  sabotage: naive includes() misses the split hit (${naiveSplit}) and accepts the bare false positive (${naiveBare})`);
  console.log(ok ? "SELF-TEST PASS" : "SELF-TEST FAIL");
  process.exit(ok ? 0 : 1);
}

// Main guard so this file can be imported for its matcher without running the CLI.
// `import.meta.url === "file://" + process.argv[1]` NEVER matches on Windows — the
// real URL has three slashes (file:///C:/...) — so compare resolved paths instead.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (!isMain) { /* imported: export the matcher, run nothing */ }
else main();

function main() {
if (process.argv.includes("--self-test")) selfTest();

const asJson = process.argv.includes("--json");
const all = process.argv.includes("--all");
const agents = all
  ? fs.readdirSync(path.join(ROOT, ".cortextOS", "state", "agents")).sort()
  : [process.argv.find((a, i) => i >= 2 && !a.startsWith("--")) || "builder_1"];

const results = agents.map(trace);
if (asJson) { console.log(JSON.stringify(results, null, 2)); process.exit(0); }

let tw = 0, th = 0, tm = 0;
console.log("agent            MB   window-floor          fires  window  reached  no-trace  drop%");
for (const r of results) {
  if (r.skip) { console.log(`${r.agent.padEnd(16)} -- SKIP: ${r.skip}`); continue; }
  tw += r.inWindow; th += r.reached; tm += r.noTrace;
  console.log(
    `${r.agent.padEnd(16)} ${String(r.sizeMB).padStart(4)} ${r.windowFloor}  ` +
    `${String(r.firesTotal).padStart(5)}  ${String(r.inWindow).padStart(6)}  ` +
    `${String(r.reached).padStart(7)}  ${String(r.noTrace).padStart(8)}  ` +
    `${r.dropPct === null ? "  --" : String(r.dropPct).padStart(5)}`
  );
}
console.log(`${"FLEET".padEnd(16)} ${"".padStart(4)} ${"".padEnd(19)}  ${"".padStart(5)}  ${String(tw).padStart(6)}  ${String(th).padStart(7)}  ${String(tm).padStart(8)}  ${tw ? String(((tm / tw) * 100).toFixed(1)).padStart(5) : "  --"}`);
if (process.argv.includes("--list-misses")) {
  for (const r of results) {
    if (r.skip || !r.misses.length) continue;
    console.log(`\n${r.agent} — fires with NO PTY trace (${r.misses.length}):`);
    for (const m of r.misses) console.log(`  ${m.ts}  ${m.cron}`);
  }
}
}
