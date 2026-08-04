// restatability-lint — can each GUARDRAILS entry be RESTATED at a decision point, or only read?
//
// THE STANDARD (builder_1, 2026-08-01): short, imperative, attached to a trigger, so A SECOND PARTY
// CAN RESTATE IT AT THE POINT OF USE. What fires is restatement, not authorship and not memory.
// Nobody hands another agent 1,963 characters mid-task. A rule that can only be READ cannot be handed
// over, so it can only work by being remembered — the mechanism proven repeatedly not to fire.
//
// WHAT THIS MEASURES, AND THE LIMIT IS THE WHOLE DESIGN: THE LENGTH OF THE FIRST SENTENCE OF THE
// FIRST PARAGRAPH. Nothing else. The unit is named in every row and in the summary, because all
// three wrong-unit verdicts on 2026-08-03 — 90 crons that FIRED read as crons that EXIST, 65 of 77
// by TITLE FORM read as task nature, 1,963 chars of MEAN ENTRY LENGTH read as restatability — would
// have been visible on their own output line if the unit had been printed beside the number.
//
// It does NOT try to detect an imperative. The first attempt at that number — "only 2 of 101 lead
// with an imperative" — came from a regex for a shouted opening clause, UNDERCOUNTED badly, and was
// withdrawn. That is a check matching one FORM as though it were the PROPERTY, which is the defect
// this file catalogues at entry 99. Detecting an imperative requires reading intent; length does not.
//
// SO THIS REPORTS A NECESSARY CONDITION, NOT THE PROPERTY. A short first sentence MIGHT be
// restatable, or might be a fragment meaningless out of context. A long one CANNOT be, because it
// cannot be handed to a second party mid-task. Every count here is a FLOOR on the number of
// unrestatable entries, never a count of them.
//
//   node scripts/restatability-lint.mjs [path] [--max-lead=200]
//
// EXIT 0 every first sentence within the limit · EXIT 2 at least one over · EXIT 3 could not run.
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const IS_MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

// An entry is a `## ` heading plus everything up to the next one.
// MEASURES THE LOGICAL UNIT, NOT THE PHYSICAL LINE, AND THE FIRST VERSION DID NOT.
//
// v1 took the first non-blank LINE. GUARDRAILS.md is HARD-WRAPPED AT ~100 CHARS — p90 100, max 146,
// 9 lines of 2,143 over 110 — so every lead measured ~97 and it reported 0 of 102 failures. IT WOULD
// HAVE REPORTED 0 ON ANY WRAPPED FILE REGARDLESS OF CONTENT. Form versus property, in a tool whose
// header cites the entry warning about it. seb_boss's correction, and it is the right one: A BETTER
// ANCHOR ON THE WRONG UNIT IS THE SAME FAILURE WITH A LONGER REGEX.
//
// So: join the wrapped paragraph, then take its FIRST SENTENCE — which is what a second party would
// actually have to hold to restate the rule at a decision point.
export function parseEntries(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (raw.startsWith('## ')) {
      if (cur) out.push(cur);
      cur = { heading: raw.slice(3).trim(), para: '', closed: false, body: 0 };
      continue;
    }
    if (!cur) continue;
    cur.body += raw.length;
    if (cur.closed) continue;
    if (raw.trim()) cur.para = cur.para ? `${cur.para} ${raw.trim()}` : raw.trim();
    else if (cur.para) cur.closed = true;   // blank line ends the first paragraph
  }
  if (cur) out.push(cur);
  for (const e of out) {
    if (!e.para) { e.lead = null; continue; }
    const m = /^(.+?[.!?])(\s|$)/.exec(e.para);
    e.lead = m ? m[1] : e.para;
  }
  return out;
}

// TABLE ROWS ARE ALREADY RESTATABLE AND MUST NOT BE COUNTED AS FAILURES. A `| Trigger | Red Flag |
// Required Action |` row is the restatable form — it is what the standard asks for, in a different
// notation. Flagging those would report the compliant sections as the worst offenders.
export function isTabular(lead) {
  return /^\|/.test(String(lead || ''));
}

// NOTHING MEASURED MUST NOT PRINT AS A MEASUREMENT. Found 2026-08-03T16:5xZ auditing my own tools
// for the fallback class that produced the suppress-gate defect: `median = leads.length ? ... : 0`
// printed "Median first sentence 0ch, longest 0ch" on a FULLY TABULAR file, where zero entries were
// measured at all. A 0 there reads as PERFECT COMPLIANCE and is in fact an empty denominator — the
// same unknown-rendered-as-a-benign-number shape as ageDays 0, on the summary line, which is exactly
// where every wrong-unit verdict of 2026-08-03 lived.
export function stats(leads) {
  if (!leads.length) return 'NO ENTRY HAD A MEASURABLE FIRST SENTENCE — there is no median to report, and this is not a score of 0.';
  return `Median first sentence ${leads[Math.floor(leads.length / 2)]}ch, longest ${leads[leads.length - 1]}ch.`;
}

export function judge(entry, maxLead) {
  if (entry.lead === null) return { state: 'EMPTY', ok: true };
  if (isTabular(entry.lead)) return { state: 'TABLE', ok: true };
  return entry.lead.length <= maxLead
    ? { state: 'OK', ok: true, lead: entry.lead.length }
    : { state: 'LEAD-TOO-LONG', ok: false, lead: entry.lead.length };
}

if (process.argv.includes('--self-test') && IS_MAIN) {
  const cases = [
    ['a heading with a short lead passes', () =>
      judge({ lead: 'Do X when Y.', body: 900 }, 200).ok === true],
    ['a long lead fails', () =>
      judge({ lead: 'x'.repeat(400), body: 900 }, 200).ok === false],
    // THE PAIRED NEGATIVE THAT MATTERS: without it, a lint that fails everything scores best on the
    // file it is meant to improve.
    ['exactly at the limit passes', () => judge({ lead: 'x'.repeat(200) }, 200).ok === true],
    ['one over the limit fails', () => judge({ lead: 'x'.repeat(201) }, 200).ok === false],
    // Table rows ARE the restatable form. Flagging them would report the compliant sections as the
    // worst offenders — the same shape as a matcher firing on the thing it is meant to endorse.
    ['a table row is not a failure', () =>
      judge({ lead: '| Trigger | Red Flag Thought | Required Action |' }, 20).ok === true],
    ['an entry with no body is not a failure', () => judge({ lead: null }, 200).ok === true],
    ['parseEntries takes the FIRST SENTENCE of the joined paragraph, not the first line', () => {
      const e = parseEntries('## A\n\n\nfirst line\nwrapped on. second sentence\n## B\nlead b.\n');
      return e.length === 2 && e[0].lead === 'first line wrapped on.' && e[1].lead === 'lead b.';
    }],
    // THE REGRESSION THAT MADE THE FIRST BASELINE MEANINGLESS. A hard-wrapped sentence must be joined
    // before measuring; measuring the physical line reports every wrapped file as compliant.
    ['a HARD-WRAPPED long sentence is measured WHOLE, not per line', () => {
      const wrapped = '## H\n' + `${'word '.repeat(19)}x\n`.repeat(4) + 'end of it.\n';
      return parseEntries(wrapped)[0].lead.length > 200;
    }],
    // NOTHING MEASURED IS NOT A SCORE OF ZERO. A fully tabular file measures no first sentence at
    // all, and the old fallback printed "Median 0ch, longest 0ch" — an empty denominator wearing the
    // look of perfect compliance, on the summary line.
    ['a file where NOTHING was measured refuses to print a median', () =>
      /NO ENTRY HAD A MEASURABLE/.test(stats([])) && !/0ch/.test(stats([]))],
    // PAIRED NEGATIVE: real measurements must still print the numbers.
    ['real leads still report median and longest', () => stats([10, 20, 30]) === 'Median first sentence 20ch, longest 30ch.'],
    ['a blank line ENDS the first paragraph — later prose is not joined in', () => {
      const e = parseEntries('## A\nshort lead here\n\nlater paragraph that is very much longer\n');
      return e[0].lead === 'short lead here';
    }],
  ];
  let failed = 0;
  for (const [name, fn] of cases) {
    let ok = false;
    try { ok = fn() === true; } catch { ok = false; }
    if (!ok) failed += 1;
    console.log((ok ? 'ok   ' : 'FAIL ') + name);
  }
  console.log('');
  console.log(`restatability-lint --self-test: ${cases.length - failed}/${cases.length}`);
  console.log('BOUNDARY: this proves the FIRST-SENTENCE length judgement and the table exemption.');
  console.log('IT CANNOT SEE WHETHER A SHORT FIRST SENTENCE IS ACTUALLY RESTATABLE — that needs a');
  console.log('second party to try to restate it.');
  console.log('Every number this tool prints is a FLOOR on the failures, never a count of them.');
  process.exit(failed === 0 ? 0 : 2);
}

if (IS_MAIN && !process.argv.includes('--self-test')) {
  const maxLead = Number((process.argv.find((a) => a.startsWith('--max-lead=')) || '--max-lead=200').split('=')[1]);
  const path = process.argv.find((a) => a.endsWith('.md')) || 'GUARDRAILS.md';
  if (!existsSync(path)) { console.log(`VERDICT: COULD-NOT-RUN — no file at ${path}`); process.exit(3); }
  const entries = parseEntries(readFileSync(path, 'utf8'));
  if (!entries.length) { console.log(`VERDICT: COULD-NOT-RUN — no "## " entries found in ${path}`); process.exit(3); }

  const judged = entries.map((e) => ({ ...e, ...judge(e, maxLead) }));
  const bad = judged.filter((j) => !j.ok);
  const tables = judged.filter((j) => j.state === 'TABLE').length;

  // WHAT THIS TOOL DID NOT JUDGE, PRINTED FIRST. Found by seb_boss 2026-08-03T16:4xZ running it
  // against HIS GUARDRAILS.md: it reported "1 of 10 entries" on a file holding 131 pipe-delimited
  // table rows. His rules live in the ROWS; this parser only sees `## ` sections, so it gave a clean
  // bill on a file it had mostly not read — THE DENOMINATOR DEFECT, IN A TOOL BUILT THIS AFTERNOON
  // TO STATE ITS DENOMINATORS. Not fixed by parsing tables, which is a different tool; fixed by
  // refusing to let the subset it found pass for the file.
  const raw = readFileSync(path, 'utf8').split(/\r?\n/);
  const pipeRows = raw.filter((l) => /^\s*\|/.test(l) && !/^\s*\|[\s|:-]*\|?\s*$/.test(l)).length;
  if (pipeRows > entries.length) {
    console.log(`UNJUDGED: ${pipeRows} pipe-delimited table row(s) against ${entries.length} "## " section(s).`);
    console.log('THIS FILE IS MOSTLY A TABLE AND THIS TOOL ONLY PARSES SECTIONS. Every count below is a');
    console.log('floor over the SECTIONS ONLY — a table-shaped guardrails file is not judged by it, and a');
    console.log('clean result here says nothing about the rows. Read this line before the verdict.');
    // A SCOPE STATEMENT IS NOT A FINDING. Same correction seb_boss made on the run-selftests NOT
    // SWEPT line: a checker that prints its own limits without saying they are not the alarm becomes
    // noisier the more honest it gets, and a downstream reader escalates the disclaimer.
    console.log('THIS IS A SCOPE STATEMENT, NOT A FINDING — it does not affect the exit code.');
    console.log('');
  }
  for (const j of bad.slice(0, 12)) {
    console.log(`  FIRST-SENTENCE ${String(j.lead).padStart(5)}ch  ${j.heading.slice(0, 74)}`);
  }
  if (bad.length > 12) console.log(`  ... and ${bad.length - 12} more`);
  console.log('');
  const leads = judged.filter((j) => typeof j.lead === 'number').map((j) => j.lead).sort((a, b) => a - b);
  console.log(`${bad.length} of ${entries.length} entries have a FIRST SENTENCE OF THE FIRST PARAGRAPH over ${maxLead} chars ` +
              `(${tables} tabular and exempt). ${stats(leads)}`);
  // WHICH UNIT THIS IS, STATED BECAUSE TWO UNITS EXIST AND ONLY ONE IS MEASURED. seb_boss ran the
  // second-party test on 2026-08-03: given HEADINGS ONLY, bodies unopened, he restated two rules and
  // named a live instance for each. THE HEADINGS CARRY THE RULES ON THEIR OWN. So the body first
  // sentence is a PROXY — but "measures a proxy" is not "measures the wrong thing": the heading
  // serves someone SCANNING the file, the body lead serves someone who has already opened the entry
  // and needs the rule before the incident. Different readers, and nobody has measured the second.
  // n=2 and seb_boss picked both, choosing the headings that read most like rules — the selection
  // pressure this file catalogues. Recorded as a bound, not acted on as a verdict.
  console.log('UNIT: this measures the BODY FIRST SENTENCE. The HEADING is what a scanner actually');
  console.log('restates from, and AN ENTRY CAN PASS ONE AND FAIL THE OTHER. Nothing here judges headings.');
  console.log('THIS IS A FLOOR, NOT A COUNT. A short first sentence MIGHT be restatable; a long one cannot');
  console.log('be, because it cannot be handed to a second party mid-task. Entries passing here may');
  console.log('still fail the standard for reasons length cannot see — this tool does not read intent,');
  console.log('deliberately, because the previous attempt to detect an imperative by regex undercounted');
  console.log('and was withdrawn.');
  process.exit(bad.length ? 2 : 0);
}
