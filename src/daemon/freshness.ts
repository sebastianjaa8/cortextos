/**
 * The two expectation predicates. Pure: `now`, the filesystem probe and the live cron list are all
 * injected, so every boundary is testable without a clock, a disk or a daemon.
 *
 * They are NOT one check, and collapsing them would be the wrong kind of tidy. `artifact-fresh` is
 * temporal (did the expected thing appear, recently enough, non-trivially). `prompt-matches-doc` is
 * a content comparison (does the live cron prompt still match what its doc says). What they share
 * is everything AROUND the predicate — declared durably, evaluated by a party other than the
 * producer, on a different cron in a different agent, reported once. Forcing one predicate to cover
 * both yields an interface whose only common member is "run and report", i.e. a scheduler with
 * extra steps.
 */

import { statSync, readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseDurationMs } from '../bus/cron-state.js';
import { readCrons } from '../bus/crons.js';
import { localDateStamp, readExpectations, resolveCandidatePaths } from './expectations.js';
import type {
  ArtifactFreshExpectation,
  Expectation,
  ExpectationRejection,
  PromptMatchesDocExpectation,
} from './expectations.js';
import { findReceipt, writeRunReceipt } from './cron-receipts.js';
import type { ReceiptResult } from './cron-receipts.js';
import type { CronDefinition } from '../types/index.js';

/** What a probe reports about one candidate path. `null` means it does not exist. */
export interface ArtifactProbe {
  mtimeMs: number;
  bytes: number;
  /** Non-blank, non-h1 lines. Counted lazily — most artifacts never need it. */
  bodyLines: () => number;
}

export type ProbeFn = (path: string) => ArtifactProbe | null;

/**
 * Body-line definition lifted verbatim from vault_keeper's check-context-save.sh
 * (`grep -vE '^\s*$|^# '`): non-blank, and not the title heading. Only `# ` is excluded, not `## `,
 * because a stub is a title with nothing under it while a real day has subheadings.
 */
export function countBodyLines(text: string): number {
  return text.split(/\r?\n/).filter((l) => !/^\s*$/.test(l) && !/^# /.test(l)).length;
}

/** Real filesystem probe. Injected by default; swapped out in tests. */
export const fsProbe: ProbeFn = (path) => {
  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  return {
    mtimeMs: st.mtimeMs,
    bytes: st.size,
    bodyLines: () => {
      try {
        return countBodyLines(readFileSync(path, 'utf-8'));
      } catch {
        // Unreadable-but-present is not zero body lines; it is unknown. Returning 0 would
        // manufacture a THIN finding out of a permissions problem.
        return -1;
      }
    },
  };
};

/**
 * FRESH, or one of the two distinct ways it can fail.
 *
 * THIN and MISSING stay separate because their CAUSES differ: THIN is a write that ran and produced
 * nothing meaningful (a silent no-op, a header-only stub), MISSING is nothing having run at all.
 * Collapsing them sends the investigation to the wrong place, which is the whole reason the
 * three-state shape was borrowed from analyst's PENDING/CLEAN/DRIFT.
 */
export type FreshnessState = 'FRESH' | 'THIN' | 'MISSING';

export interface ArtifactFreshResult {
  id: string;
  agent: string;
  state: FreshnessState;
  /** The candidate that was judged, or the newest candidate tried when none existed. */
  path: string;
  detail: string;
  /** True when MISSING is "stale" rather than "absent" — different fix, same severity. */
  stale: boolean;
}

export function checkArtifactFresh(
  exp: ArtifactFreshExpectation,
  now: Date,
  probe: ProbeFn = fsProbe,
): ArtifactFreshResult {
  const maxAgeMs = parseDurationMs(exp.max_age);
  const candidates = resolveCandidatePaths(exp.path, now, exp.timezone, maxAgeMs);

  let best: { path: string; probe: ArtifactProbe } | null = null;
  for (const path of candidates) {
    const p = probe(path);
    if (!p) continue;
    if (!best || p.mtimeMs > best.probe.mtimeMs) best = { path, probe: p };
  }

  if (!best) {
    return {
      id: exp.id,
      agent: exp.agent,
      state: 'MISSING',
      path: candidates[0],
      stale: false,
      detail:
        `no file at ${candidates.length} candidate path(s) within ${exp.max_age} ` +
        `(newest tried: ${candidates[0]})`,
    };
  }

  const ageMs = now.getTime() - best.probe.mtimeMs;
  if (ageMs > maxAgeMs) {
    return {
      id: exp.id,
      agent: exp.agent,
      state: 'MISSING',
      path: best.path,
      stale: true,
      detail: `last write ${fmtAge(ageMs)} ago, budget ${exp.max_age} — present but stale`,
    };
  }

  const bytes = best.probe.bytes;
  if (exp.min_bytes !== undefined && bytes < exp.min_bytes) {
    return {
      id: exp.id,
      agent: exp.agent,
      state: 'THIN',
      path: best.path,
      stale: false,
      detail: `${bytes}B < min_bytes ${exp.min_bytes} — wrote, produced nothing`,
    };
  }

  if (exp.min_body_lines !== undefined) {
    const lines = best.probe.bodyLines();
    // -1 is "could not read", which is not the same as empty. Reporting it as THIN would turn a
    // permissions problem into a false claim about the producer.
    if (lines >= 0 && lines < exp.min_body_lines) {
      return {
        id: exp.id,
        agent: exp.agent,
        state: 'THIN',
        path: best.path,
        stale: false,
        detail: `${lines} body line(s) < min_body_lines ${exp.min_body_lines} — header-only stub`,
      };
    }
  }

  return {
    id: exp.id,
    agent: exp.agent,
    state: 'FRESH',
    path: best.path,
    stale: false,
    detail: `${bytes}B, written ${fmtAge(ageMs)} ago (budget ${exp.max_age})`,
  };
}

function fmtAge(ms: number): string {
  const h = ms / 3_600_000;
  return h < 1 ? `${Math.round(ms / 60_000)}m` : `${h.toFixed(1)}h`;
}

/**
 * CLEAN, or the two states either side of it, or a coverage gap.
 *
 * `NOT-EVALUABLE` is deliberately not a failure: a manifest naming a cron the agent no longer has
 * is a gap in what we can SEE, and reporting it as a pass would let the denominator shrink silently.
 * Same reason the stated-time check reports coverage.
 */
export type PromptDocState = 'CLEAN' | 'PENDING-CONVERSION' | 'DRIFT' | 'NOT-EVALUABLE';

export interface PromptMatchesDocResult {
  id: string;
  agent: string;
  cron: string;
  state: PromptDocState;
  detail: string;
}

export function checkPromptMatchesDoc(
  exp: PromptMatchesDocExpectation,
  liveCrons: CronDefinition[],
): PromptMatchesDocResult {
  const base = { id: exp.id, agent: exp.agent, cron: exp.cron };
  const cron = liveCrons.find((c) => c.name === exp.cron);
  if (!cron) {
    return { ...base, state: 'NOT-EVALUABLE', detail: 'no live cron by that name' };
  }

  const prompt = cron.prompt ?? '';
  // Case-insensitive so a term that survives a re-capitalisation is still caught. The failure mode
  // is "policy text crept back inline", not exact-text equality — a byte-diff against a canonical
  // string would flag every legitimate wording tweak and be abandoned inside a week.
  const lower = prompt.toLowerCase();
  const present = exp.inline_forbidden.filter((t) => lower.includes(t.toLowerCase()));

  if (present.length === 0) {
    return {
      ...base,
      state: 'CLEAN',
      detail: `${prompt.length} chars, none of ${exp.inline_forbidden.length} forbidden term(s) present`,
    };
  }

  // Forbidden-term presence is the PRIMARY gate; length is used only to separate the two ways a
  // term can be present. A term that must live only in the doc is a fact about that term. Length is
  // a proxy, and it keeps the one job the fact cannot do: telling not-yet-converted apart from
  // converted-then-edited.
  const threshold = exp.max_prompt_chars;
  if (threshold !== undefined && prompt.length > threshold) {
    return {
      ...base,
      state: 'PENDING-CONVERSION',
      detail:
        `${prompt.length} chars > ${threshold} with ${present.length} forbidden term(s) ` +
        `(${present.join(', ')}) — expected before conversion to ${exp.doc}`,
    };
  }

  return {
    ...base,
    state: 'DRIFT',
    detail:
      `${prompt.length} chars with forbidden term(s) present (${present.join(', ')}) — ` +
      `policy text belongs only in ${exp.doc}; someone edited the live cron`,
  };
}

// ---------------------------------------------------------------------------
// Sweep — the harness around the two predicates
// ---------------------------------------------------------------------------

export interface ExpectationFinding {
  agent: string;
  id: string;
  kind: 'MISSING' | 'THIN' | 'DRIFT';
  detail: string;
  /** Present for artifact-fresh: what receiving-side evidence backed (or failed to back) it. */
  receipt?: ReceiptResult;
  /**
   * The author declared this expectation without confirming the artifact exists.
   *
   * A speculative MISSING is a possible NAMING error. A confirmed MISSING is a possible OUTAGE.
   * They are ranked and rendered separately so the first can never push the second off the top.
   */
  speculative?: boolean;
}

/**
 * Coverage, reported alongside findings and never folded into them.
 *
 * A shrinking denominator is indistinguishable from a clean bill of health, and this harness has
 * three separate ways to shrink one silently: an agent deleting its manifest, a manifest naming a
 * cron that no longer exists, and an expectation declaring no receipt. "0 findings" is not an honest
 * report; "18 of 21 expectations evaluable, 9 of 14 receipt-backed, 0 findings" is.
 */
export interface ExpectationCoverage {
  agentsWithManifest: number;
  declared: number;
  evaluable: number;
  rejected: ExpectationRejection[];
  notEvaluable: Array<{ agent: string; id: string; reason: string }>;
  /** artifact-fresh expectations that name a receipt, over the total that could. */
  receiptDeclared: number;
  receiptEligible: number;
  /** Of those declaring one, how many had discoverable evidence. */
  receiptFound: number;
  /** Expectations declared against an unconfirmed artifact. Cheap to have, must stay labelled. */
  speculative: number;
  /**
   * Speculative expectations that PASSED, i.e. the guess was right and the flag has done its job.
   *
   * Surfaced because a provisional marker nobody ever removes decays into noise, which is the
   * verified-once-then-never-rechecked failure in a new costume. A passing speculative expectation is
   * an ACTION — drop the flag — not a status.
   */
  promotable: Array<{ agent: string; id: string }>;
}

export interface SweepResult {
  findings: ExpectationFinding[];
  /** PENDING-CONVERSION is a state, not a flag — surfaced separately so it is visible but quiet. */
  pending: Array<{ agent: string; id: string; detail: string }>;
  coverage: ExpectationCoverage;
}

function agentDirs(frameworkRoot: string): Array<{ agent: string; org: string; dir: string }> {
  const out: Array<{ agent: string; org: string; dir: string }> = [];
  const orgsBase = join(frameworkRoot, 'orgs');
  if (!existsSync(orgsBase)) return out;
  for (const org of readdirSync(orgsBase, { withFileTypes: true })) {
    if (!org.isDirectory()) continue;
    const agentsBase = join(orgsBase, org.name, 'agents');
    if (!existsSync(agentsBase)) continue;
    for (const agent of readdirSync(agentsBase, { withFileTypes: true })) {
      if (!agent.isDirectory()) continue;
      out.push({ agent: agent.name, org: org.name, dir: join(agentsBase, agent.name) });
    }
  }
  return out;
}

/**
 * Evaluate every manifest on the box.
 *
 * Enumerates from `orgs/`, because that is WHERE THE FACT LIVES: a manifest is authored by its
 * owner and sits beside their config.json. The state dir is a different set — this fleet has agents
 * present in one and absent from the other — and sweeping the wrong one earlier produced a clean,
 * confident, structurally-blind report. So each check enumerates the directory its own fact is in.
 */
export function sweepExpectations(
  frameworkRoot: string,
  now: Date = new Date(),
  probe: ProbeFn = fsProbe,
): SweepResult {
  const findings: ExpectationFinding[] = [];
  const pending: SweepResult['pending'] = [];
  const coverage: ExpectationCoverage = {
    agentsWithManifest: 0,
    declared: 0,
    evaluable: 0,
    rejected: [],
    notEvaluable: [],
    receiptDeclared: 0,
    receiptEligible: 0,
    receiptFound: 0,
    speculative: 0,
    promotable: [],
  };

  for (const { agent, org, dir } of agentDirs(frameworkRoot)) {
    const { expectations, rejected } = readExpectations(agent, dir);
    coverage.rejected.push(...rejected);
    if (expectations.length === 0 && rejected.length === 0) continue;
    coverage.agentsWithManifest++;
    coverage.declared += expectations.length + rejected.length;

    // One read per agent, not per expectation.
    let liveCrons: CronDefinition[] = [];
    try {
      liveCrons = readCrons(agent);
    } catch {
      /* an agent with no readable crons.json still has artifact expectations worth checking */
    }

    for (const exp of expectations) {
      if (exp.type === 'artifact-fresh') {
        coverage.evaluable++;
        coverage.receiptEligible++;
        if (exp.speculative) coverage.speculative++;
        const res = checkArtifactFresh(exp, now, probe);
        const receipt = evaluateReceipt(exp, now, org, coverage);
        if (res.state !== 'FRESH') {
          findings.push({
            agent: exp.agent,
            id: exp.id,
            kind: res.state,
            detail: `${res.path}: ${res.detail}`,
            receipt,
            speculative: exp.speculative,
          });
        } else if (exp.speculative) {
          // The guess was right. Say so, so the flag gets removed instead of aging into noise.
          coverage.promotable.push({ agent: exp.agent, id: exp.id });
        }
        continue;
      }

      if (exp.speculative) coverage.speculative++;
      const res = checkPromptMatchesDoc(exp, liveCrons);
      if (res.state === 'NOT-EVALUABLE') {
        coverage.notEvaluable.push({ agent: exp.agent, id: exp.id, reason: res.detail });
        continue;
      }
      coverage.evaluable++;
      if (res.state === 'DRIFT') {
        findings.push({
          agent: exp.agent,
          id: exp.id,
          kind: 'DRIFT',
          detail: res.detail,
          speculative: exp.speculative,
        });
      } else if (res.state === 'CLEAN' && exp.speculative) {
        coverage.promotable.push({ agent: exp.agent, id: exp.id });
      } else if (res.state === 'PENDING-CONVERSION') {
        pending.push({ agent: exp.agent, id: exp.id, detail: res.detail });
      }
    }
  }

  return { findings, pending, coverage };
}

function evaluateReceipt(
  exp: ArtifactFreshExpectation,
  now: Date,
  org: string,
  coverage: ExpectationCoverage,
): ReceiptResult {
  if (!exp.receipt) {
    // Not a failure. Nobody declared what receiving-side evidence exists for this cron, so there is
    // nothing to look for — that is a gap in what the harness can SEE, and it belongs in the
    // denominator rather than in the findings.
    return { kind: 'NOT-CHECKED', evidence: 'expectation declares no receipt' };
  }
  coverage.receiptDeclared++;
  const res = findReceipt({
    agent: exp.agent,
    cron: exp.receipt.cron,
    date: localDateStamp(now, exp.timezone),
    timezone: exp.timezone,
    now,
    windowMs: parseDurationMs(exp.max_age),
    declared: exp.receipt,
    org,
  });
  if (res.kind !== 'NONE' && res.kind !== 'NOT-CHECKED') coverage.receiptFound++;
  return res;
}

/**
 * The checker's own run receipt.
 *
 * This is how "who watches the watcher" gets answered concretely instead of as a paradox: the line
 * appended here is itself an `artifact-fresh` expectation in seb_boss's manifest, evaluated by
 * seb_boss's morning brief on a different agent, cron and schedule. Both have to fail inside the
 * same window to stay silent. That is not perfect and is not claimed to be — it converts a single
 * point of failure into a coincidence.
 */
export function writeCheckerReceipt(
  ctxRoot: string,
  agentName: string,
  result: SweepResult,
  now: Date = new Date(),
): string {
  return writeRunReceipt(
    ctxRoot,
    agentName,
    'check-expectations-receipt.jsonl',
    {
      cron: 'check-expectations',
      findings: result.findings.length,
      declared: result.coverage.declared,
      evaluable: result.coverage.evaluable,
      receipt_found: result.coverage.receiptFound,
      receipt_declared: result.coverage.receiptDeclared,
    },
    now,
  );
}

/** One line per finding, plus the coverage the findings alone cannot convey. */
export function formatSweep(result: SweepResult): string {
  const { findings, pending, coverage } = result;
  const lines: string[] = [];

  const order: Record<ExpectationFinding['kind'], number> = { MISSING: 0, THIN: 1, DRIFT: 2 };
  const rank = (a: ExpectationFinding, b: ExpectationFinding) =>
    order[a.kind] - order[b.kind] || a.agent.localeCompare(b.agent);
  const render = (f: ExpectationFinding) => {
    lines.push(`  ${f.agent}/${f.id}  ${f.kind}: ${f.detail}`);
    if (f.receipt) lines.push(`      receipt: ${f.receipt.kind} — ${f.receipt.evidence}`);
  };

  // Confirmed findings ABOVE speculative ones, in two separate blocks.
  //
  // A speculative MISSING is a possible NAMING error; a confirmed MISSING is a possible OUTAGE.
  // Interleaved they are indistinguishable, and once declaring-anyway is fleet practice the invented
  // paths outnumber the real failures — so the crons that genuinely stopped scroll off the top. That
  // is exactly how the cron-drift detector would have died on day one had it reported its 90 correct
  // entries. The habit is worth keeping; it just has to be labelled to stay affordable.
  const confirmed = findings.filter((f) => !f.speculative).sort(rank);
  const speculative = findings.filter((f) => f.speculative).sort(rank);

  if (confirmed.length === 0 && speculative.length === 0) {
    lines.push('No expectation failures.');
  }
  if (confirmed.length > 0) {
    lines.push(`${confirmed.length} expectation failure(s) on CONFIRMED expectations:`);
    confirmed.forEach(render);
  }
  if (speculative.length > 0) {
    if (confirmed.length > 0) lines.push('');
    lines.push(
      `${speculative.length} failure(s) on SPECULATIVE expectations — declared against an ` +
        `unconfirmed artifact, so a wrong path is as likely as a real miss. Confirm the path, then ` +
        `drop the speculative flag:`,
    );
    speculative.forEach(render);
  }

  lines.push('');
  lines.push(
    `Coverage: ${coverage.evaluable} of ${coverage.declared} declared expectation(s) evaluable ` +
      `across ${coverage.agentsWithManifest} agent(s) with a manifest. ` +
      `Receipts: ${coverage.receiptFound} found of ${coverage.receiptDeclared} declared, ` +
      `${coverage.receiptEligible - coverage.receiptDeclared} artifact expectation(s) declare none. ` +
      `${coverage.speculative} declared speculatively (unconfirmed artifact). ` +
      `A DROP in any of these between runs is itself a finding — a deleted manifest reads exactly ` +
      `like a clean report.`,
  );

  if (coverage.promotable.length > 0) {
    lines.push('');
    lines.push(
      'Speculative expectations that PASSED — the guess was right, remove `"speculative": true` so ' +
        'a future failure reads as the outage it is:',
    );
    for (const p of coverage.promotable) lines.push(`  ${p.agent}/${p.id}`);
  }

  if (coverage.notEvaluable.length > 0) {
    lines.push('');
    lines.push('Not evaluable (coverage gap, not a pass):');
    for (const n of coverage.notEvaluable) lines.push(`  ${n.agent}/${n.id}: ${n.reason}`);
  }
  if (coverage.rejected.length > 0) {
    lines.push('');
    lines.push('Rejected manifest entries:');
    for (const r of coverage.rejected) lines.push(`  ${r.agent}/${r.id}: ${r.reason}`);
  }
  if (pending.length > 0) {
    lines.push('');
    lines.push('Pending conversion (expected, not a flag):');
    for (const p of pending) lines.push(`  ${p.agent}/${p.id}: ${p.detail}`);
  }
  if (findings.length > 0) {
    lines.push('');
    lines.push(
      'A MISSING artifact on a legitimately quiet day is a FALSE FLAG this check accepts on ' +
        'purpose: over-flagging that explains itself does not train people to ignore it, and a ' +
        'silent miss does. Check the receipt line before chasing the artifact — receipt NONE with a ' +
        'scheduler-side fire means the injection dropped, not that the producer failed.',
    );
  }
  return lines.join('\n');
}
