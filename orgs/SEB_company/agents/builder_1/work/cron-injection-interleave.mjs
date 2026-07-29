// Alternative-explanation check for cron-injection-trace.mjs.
//
// If a high drop rate were an artifact of PTY echo being unavailable for a stretch
// (log rotation, a session mode that suppresses echo), misses would form long
// CONTIGUOUS runs. If injection is genuinely unreliable, hits and misses interleave.
// Prints the hit/miss sequence in time order plus the longest miss run and the number
// of transitions, so the two stories are distinguishable rather than assumed apart.
//
// Usage: node cron-injection-interleave.mjs <agent> [more agents...]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { densify, bannerRegions, reached } from "./cron-injection-trace.mjs";

const ROOT = path.join(os.homedir(), ".cortextos", "default");

for (const agent of process.argv.slice(2)) {
  const cronPath = path.join(ROOT, ".cortextOS", "state", "agents", agent, "cron-execution.log");
  const outPath = path.join(ROOT, "logs", agent, "stdout.log");
  const fires = fs.readFileSync(cronPath, "utf8").trim().split(/\r?\n/)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && r.status === "fired");
  const dense = densify(fs.readFileSync(outPath, "latin1"));
  const regions = bannerRegions(dense);
  const bannerTs = regions
    .map((r) => (r.match(/(20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d)/) || [])[1])
    .filter(Boolean).sort();
  const floor = bannerTs[0];

  const seq = fires.filter((r) => r.ts >= floor)
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .map((r) => ({ ts: r.ts, cron: r.cron, hit: reached(dense, r.ts, regions) !== null }));

  let longestMiss = 0, run = 0, transitions = 0;
  for (let i = 0; i < seq.length; i++) {
    if (seq[i].hit) { run = 0; } else { run++; longestMiss = Math.max(longestMiss, run); }
    if (i && seq[i].hit !== seq[i - 1].hit) transitions++;
  }
  const hits = seq.filter((s) => s.hit).length;
  console.log(`\n=== ${agent} — ${seq.length} fires in window, ${hits} hit, ${seq.length - hits} miss`);
  console.log(`longest contiguous MISS run: ${longestMiss}   hit/miss transitions: ${transitions}`);
  console.log(`first hit ${seq.find((s) => s.hit)?.ts ?? "none"}   last hit ${[...seq].reverse().find((s) => s.hit)?.ts ?? "none"}`);
  // Compressed sequence: X = reached PTY, . = no trace, in time order.
  console.log(seq.map((s) => (s.hit ? "X" : ".")).join("").replace(/(.{80})/g, "$1\n"));
}
