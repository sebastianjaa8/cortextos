// check-brief-health — did the morning brief actually go out, and if not, WHICH WAY did it fail?
//
// WHY THIS EXISTS. The 06-18 brief failsafe is a RULE IN seb_boss's INSTRUCTIONS: send a catch-up
// brief on resume when the last one is >4h overdue. It is WAKE-TRIGGERED, so it can only evaluate
// when a session resumes, and it is BLIND BY CONSTRUCTION to every failure where the agent stays up.
// THE WEEK OF 07-27, AFTER HAND-CHECKING EVERY FLAGGED DAY AGAINST outbound-messages.jsonl:
//
//   07-23  33 telegram sends, NOTHING between 08:00Z and 15:00Z  -> no brief. REAL.
//   07-24  54 sends, window empty, nearest are "back online"     -> no brief. REAL.
//   07-28  "Catch-up brief 07-28 (7am cron fired but produced
//          no output today, ran manually just now)" at 11:05Z    -> PRODUCTION failure, self-documented
//   07-29  brief present, self-labelled catch-up                 -> HANG, recovered after a restart
//
// THE TRANSPORT MODE WAS STRUCK 2026-08-03. It rested on 07-27 showing zero telegram rows, which was
// a fact about outbound-deliveries.jsonl BEGINNING ON 07-28, not about the day. outbound-messages
// records 22 sends and a brief on 07-27. The "bus active, 22 sends" figure was itself the telegram
// count, so the specified pair — bus activity CROSS telegram delivery — was two reads of one modality
// and could not have discriminated anything. No confirmed instance of a transport failure exists.
//
// The classifier keeps the TRANSPORT branch because it is cheap and unambiguous IF it ever fires; it
// has simply never fired on real data. That is a different claim from "this mode happens".
//
// Only 07-29 involved a restart, so the 06-18 wake-triggered failsafe was blind to 07-23, 07-24 and
// 07-28 by construction — three of the four real degradations.
//
// EXIT 0 clean · EXIT 2 finding · EXIT 3 could-not-run.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

// RUN ONLY AS AN ENTRY POINT. Without this, `import(...)` for the exported matchers
// executes the whole CLI and calls process.exit — found 2026-08-03 trying to reuse
// looksLikeBrief() from a one-off measurement script, which got a 7-day report and an
// exit 2 instead of a function. Exporting functions from a file that runs on import is
// exporting nothing.
const IS_MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

const ROOT = process.env.CTX_ROOT || join(homedir(), '.cortextos', 'default');
const ORG = process.env.CTX_ORG || 'SEB_company';
const AGENT = 'seb_boss';

// The 7am ET brief lands between 11:00Z and 12:30Z depending on DST and on how long composition takes.
// Observed: 11:00:30Z (08-01), 11:03:19Z (08-02). The window is deliberately wider than observation.
const WIN_START_MIN = 10 * 60;
const WIN_END_MIN = 12 * 60 + 30;

export function readJsonl(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* a partial write is not a finding about the fleet */ }
  }
  return out;
}

export function minutesUtc(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d.getUTCHours() * 60 + d.getUTCMinutes();
}

// TOLERATES A MARKDOWN HEADING PREFIX, AND THAT IS NOT A COSMETIC ALLOWANCE. The first version
// anchored on /^\s*morning\s+brief/ and reported 07-22 and 07-25 as SUSPECT-NO-BRIEF. Both days sent
// a brief — "## Morning Brief — 2026-07-22 (Wed)" at 11:08Z and "## Morning Brief - 2026-07-25 (Sat)"
// at 11:21Z. The matcher was defeated by two hashes and a space, and it produced the SAME verdict a
// genuinely missing brief produces. Hand-checking the four suspects split them 2 real / 2 mine.
//
// STILL ANCHORED: leading whitespace, #, *, - and _ only. "Re: the morning brief you sent" must not
// match, or the check reports a brief on any day someone MENTIONS one.
export function looksLikeBrief(preview) {
  return /^[\s#*_-]*morning\s+brief/i.test(String(preview || ''));
}

export function looksLikeCatchUp(preview) {
  return /catch-?up/i.test(String(preview || ''));
}

// THE CLASSIFIER. Takes counts, not files, so the self-test can drive every branch without fixtures.
//
// THE BRIEF-PRODUCTION VERDICT IS DELIBERATELY WEAKER THAN THE TRANSPORT ONE, and that asymmetry is
// the honest part rather than an omission. Transport needs no title matching: bus activity with zero
// telegram rows is unambiguous. Production has to identify WHICH send was the brief, and the only
// available handle is the preview text — which varies. 07-31's 7am send went out as "Croncheck alert",
// 07-28's as "Vault log rotation". So a title miss cannot be distinguished from a brief that never
// ran, and reporting ABSENT there would reintroduce the exact false negative this check exists to
// remove. It reports SUSPECT until outbound-deliveries carries a producer field
// (task_1785722971327_73829243), at which point this weakens to a one-line lookup.
// THE PRODUCER READER IS THREE-VALUED AND THAT IS THE ENTIRE POINT OF BUILDING IT SEPARATELY FROM
// THE WRITER. Once outbound-deliveries carries `producer`, the tempting shape is two-valued: brief
// row found or not. THAT REPORTS EVERY BRIEF MISSING ON ROLLOUT DAY, because no row written before
// the field shipped carries it — and rollout day is exactly when someone decides the new check is
// broken and stops reading it.
//
//   no `producer` on ANY row that day  -> THE FEATURE IS NOT LIVE          -> UNKNOWN (falls through)
//   `producer` on other rows, none the brief -> IT GENUINELY DID NOT SEND  -> ABSENT
//   a brief row by producer            -> CONFIRMED, with state and message_id
//
// FOURTH INDEPENDENT ARRIVAL OF THIS SHAPE IN TWO DAYS: UNCHANGED vs ZERO-TOKENS, kind=work vs noop,
// blocked_on, and now UNKNOWN vs ABSENT. EVERY INSTRUMENT SHIPS TWO-VALUED AND NEEDS THREE, and the
// missing state is always "THE INSTRUMENT COULD NOT OBSERVE" as distinct from "IT OBSERVED NOTHING".
export function classify({ busEvents, telegramRows, briefRow, catchUp, producerRows = 0, producerBriefRow = null }) {
  if (busEvents === 0 && telegramRows === 0) {
    return { code: 0, status: 'QUIET', detail: 'no bus activity and no telegram: a genuinely quiet day is not a finding.' };
  }
  if (busEvents > 0 && telegramRows === 0) {
    return { code: 2, status: 'TRANSPORT',
      detail: `${busEvents} bus event(s) and ZERO telegram deliveries — the agent was alive and the transport was not. This is the 07-27 signature and it is unambiguous: it needs no title matching.` };
  }
  // VERDICT 3 — a producer-tagged brief row. The only verdict that needs no title matching at all.
  if (producerBriefRow) {
    if (catchUp) {
      return { code: 2, status: 'HANG',
        detail: `producer=morning-brief row present (state ${producerBriefRow.state}, message_id ${producerBriefRow.message_id}) and it labels itself a catch-up — it ran late. The 07-29 signature, now confirmed by producer rather than inferred from a title.` };
    }
    return { code: 0, status: 'CONFIRMED',
      detail: `producer=morning-brief, state ${producerBriefRow.state}, message_id ${producerBriefRow.message_id}. No title matching involved.` };
  }
  // VERDICT 2 — the field is live that day and no row claims to be the brief. Only NOW is ABSENT
  // safe to say, because the absence of the tag is no longer explainable by the tag not existing.
  if (producerRows > 0) {
    return { code: 2, status: 'ABSENT',
      detail: `${producerRows} delivery row(s) that day carry a producer and NONE of them is the brief. The field is live, so this is a real absence rather than a title miss — the distinction that made the old verdict SUSPECT instead of ABSENT.` };
  }
  // VERDICT 1 — falls through to the title-based path below, which is UNKNOWN by its older name.
  if (!briefRow) {
    return { code: 2, status: 'SUSPECT-NO-BRIEF',
      detail: `${telegramRows} telegram delivery(s) but none in the 10:00-12:30Z window whose preview begins "MORNING BRIEF". THIS IS SUSPECT, NOT ABSENT: the 7am send is not always titled that (07-31 "Croncheck alert", 07-28 "Vault log rotation"), so a title miss and a missing brief are indistinguishable here. Confirm by hand until a producer field exists.` };
  }
  if (catchUp) {
    return { code: 2, status: 'HANG',
      detail: 'a brief went out and labels itself a catch-up — it ran late, after the fact. The 07-29 signature.' };
  }
  return { code: 0, status: 'OK', detail: 'a brief went out inside the window and does not label itself a catch-up.' };
}

// TWO TELEGRAM JOURNALS, AND USING THE WRONG ONE MANUFACTURES TRANSPORT FAILURES.
//
// outbound-deliveries.jsonl carries delivery STATE (delivering/accepted/dead-letter) and BEGINS
// 2026-07-28T01:20:32Z. outbound-messages.jsonl carries no state but runs back to 2026-05-12.
//
// THE FIRST VERSION OF THIS TOOL USED DELIVERIES ALONE AND REPORTED FIVE CONSECUTIVE TRANSPORT
// FAILURES FOR 07-23..07-27 — every date before the journal existed, because zero rows before a
// file's first write is indistinguishable from zero sends. outbound-messages shows 07-27 had 22
// telegram sends. THE INSTRUMENT'S ABSENCE WAS BEING READ AS THE THING'S ABSENCE, which is the exact
// failure this check was written to detect, reproduced inside it on its first real run.
//
// So: PRESENCE comes from messages (long history), STATE from deliveries (richer, recent). And a date
// before the deliveries journal begins is not silently downgraded — it is reported as reduced
// coverage, because "we could not observe" must never render as "nothing happened".
const DELIVERIES = join(ROOT, 'logs', AGENT, 'outbound-deliveries.jsonl');
const MESSAGES = join(ROOT, 'logs', AGENT, 'outbound-messages.jsonl');

export function journalStart(path) {
  const rows = readJsonl(path);
  if (!rows.length) return null;
  return rows.map((r) => String(r.timestamp || '')).filter(Boolean).sort()[0].slice(0, 10);
}

export function dayFacts(date) {
  const events = readJsonl(join(ROOT, 'orgs', ORG, 'analytics', 'events', AGENT, `${date}.jsonl`));
  const sends = readJsonl(MESSAGES).filter((r) => String(r.timestamp || '').startsWith(date));
  const delivered = readJsonl(DELIVERIES)
    .filter((r) => String(r.timestamp || '').startsWith(date) && r.state === 'accepted');
  // Prefer the state-bearing journal when it covers this date; fall back to the long one.
  const source = delivered.length ? delivered : sends;
  const inWindow = source.filter((r) => {
    const m = minutesUtc(r.timestamp);
    return m !== null && m >= WIN_START_MIN && m <= WIN_END_MIN;
  });
  const briefRow = inWindow.find((r) => looksLikeBrief(r.preview || r.text)) || null;
  return {
    busEvents: events.length,
    telegramRows: sends.length,
    briefRow,
    catchUp: briefRow ? looksLikeCatchUp(briefRow.preview || briefRow.text) : false,
  };
}

if (process.argv.includes('--self-test')) {
  const cases = [
    // THE MUST-FAIL CASE FROM THE TASK: a day where the agent NEVER RESTARTS and no brief goes out
    // must produce a finding. The wake-triggered failsafe cannot see this day at all.
    ['07-28 shape: telegram normal, no brief, no restart -> FINDING', () =>
      classify({ busEvents: 34, telegramRows: 12, briefRow: null, catchUp: false }).code === 2],
    // --- THE THREE-WAY PRODUCER READER. Built before the writer, because the writer is three src/
    // call sites and src/ is held against 9823.
    ['a producer-tagged brief row -> CONFIRMED, no title matching', () => {
      const v = classify({ busEvents: 40, telegramRows: 9, briefRow: null, catchUp: false,
        producerRows: 6, producerBriefRow: { state: 'accepted', message_id: 9820 } });
      return v.code === 0 && v.status === 'CONFIRMED';
    }],
    ['producer live that day, none is the brief -> ABSENT, not SUSPECT', () => {
      const v = classify({ busEvents: 40, telegramRows: 9, briefRow: null, catchUp: false,
        producerRows: 6, producerBriefRow: null });
      return v.code === 2 && v.status === 'ABSENT';
    }],
    // THE CASE THE WHOLE THREE-WAY SPLIT EXISTS FOR. On rollout day NO row carries a producer, so a
    // two-valued reader reports every brief missing — and that is the day someone decides the new
    // check is broken. It must fall back to the title path and say SUSPECT, never ABSENT.
    ['NO producer on any row that day -> UNKNOWN path, never ABSENT', () => {
      const v = classify({ busEvents: 40, telegramRows: 9, briefRow: null, catchUp: false,
        producerRows: 0, producerBriefRow: null });
      return v.code === 2 && v.status === 'SUSPECT-NO-BRIEF' && v.status !== 'ABSENT';
    }],
    // PAIRED NEGATIVE FOR THE PRODUCER PATH: a tagged brief that labels itself a catch-up is still a
    // HANG. Without this, CONFIRMED would swallow the late-brief signature the title path caught.
    ['a producer-tagged brief that is a catch-up is still HANG', () => {
      const v = classify({ busEvents: 40, telegramRows: 9, briefRow: null, catchUp: true,
        producerRows: 6, producerBriefRow: { state: 'accepted', message_id: 1 } });
      return v.code === 2 && v.status === 'HANG';
    }],
    ['07-27 shape: bus active, telegram zero -> TRANSPORT', () => {
      const v = classify({ busEvents: 22, telegramRows: 0, briefRow: null, catchUp: false });
      return v.code === 2 && v.status === 'TRANSPORT';
    }],
    ['07-29 shape: brief present but self-labelled catch-up -> HANG', () => {
      const v = classify({ busEvents: 58, telegramRows: 9, briefRow: {}, catchUp: true });
      return v.code === 2 && v.status === 'HANG';
    }],
    // THE PAIRED NEGATIVE THE TASK REQUIRES: a normal successful brief day must stay SILENT.
    // Without this the check could return a finding unconditionally and pass everything above.
    ['a normal brief day is SILENT', () =>
      classify({ busEvents: 40, telegramRows: 8, briefRow: {}, catchUp: false }).code === 0],
    // THE SECOND PAIRED NEGATIVE: a genuinely quiet day must not alarm, or the check is muted inside a
    // week. The discriminator is send-volume-with-no-brief, never brief-absence alone.
    ['a genuinely quiet day is SILENT', () =>
      classify({ busEvents: 0, telegramRows: 0, briefRow: null, catchUp: false }).code === 0],
    // ORDERING: transport outranks no-brief. A day with zero telegram rows also has no brief row, and
    // reporting it as SUSPECT-NO-BRIEF would name the wrong failure and send someone to the wrong fix.
    ['transport OUTRANKS no-brief when both are true', () =>
      classify({ busEvents: 22, telegramRows: 0, briefRow: null, catchUp: false }).status === 'TRANSPORT'],
    ['a title miss reports SUSPECT, never ABSENT', () =>
      classify({ busEvents: 40, telegramRows: 8, briefRow: null, catchUp: false }).status === 'SUSPECT-NO-BRIEF'],
    ['brief matcher is anchored: "Re: morning brief" does NOT count', () =>
      looksLikeBrief('MORNING BRIEF — Sun') && !looksLikeBrief('Re: the morning brief you sent')],
    // VERBATIM from outbound-messages.jsonl. Both were reported SUSPECT-NO-BRIEF by the first
    // version, and both are briefs — the matcher lost to a markdown heading. Real strings, because
    // an invented one would have been written to match whatever the regex already did.
    ['REAL 07-22 string with a ## heading is a brief', () =>
      looksLikeBrief('## Morning Brief — 2026-07-22 (Wed) YESTERDAY (git + log) - 0 commits')],
    ['REAL 07-25 string with a ## heading is a brief', () =>
      looksLikeBrief('## Morning Brief - 2026-07-25 (Sat) RECENT MOMENTUM cortextos: daemon')],
    ['catch-up matcher takes both spellings', () =>
      looksLikeCatchUp('catch-up again') && looksLikeCatchUp('catchup run')],
  ];
  let failed = 0;
  for (const [name, fn] of cases) {
    let ok = false;
    try { ok = fn() === true; } catch { ok = false; }
    if (!ok) failed += 1;
    console.log((ok ? 'ok   ' : 'FAIL ') + name);
  }
  console.log('');
  console.log(`check-brief-health --self-test: ${cases.length - failed}/${cases.length}`);
  console.log('BOUNDARY: these drive the CLASSIFIER with counts. THEY CANNOT PROVE dayFacts READS THE');
  console.log('RIGHT FILES, and that gap is not theoretical — the first version of this tool passed');
  console.log('every case above while reading a journal that begins 2026-07-28, and reported five');
  console.log('false TRANSPORT findings for the days before it existed. A unit case on the classifier');
  console.log('is blind to which journal the caller opened. Run --days=12 against the known week and');
  console.log('check the SOURCE COVERAGE line before trusting any verdict older than the journal.');
  process.exit(failed === 0 ? 0 : 2);
}

if (IS_MAIN) {
const daysArg = process.argv.find((a) => a.startsWith('--days=')) || '--days=7';
const days = Number(daysArg.split('=')[1]);
if (!Number.isFinite(days) || days <= 0) { console.log('VERDICT: COULD-NOT-RUN — bad --days'); process.exit(3); }
const journal = join(ROOT, 'logs', AGENT, 'outbound-deliveries.jsonl');
if (!existsSync(journal)) { console.log(`VERDICT: COULD-NOT-RUN — no delivery journal at ${journal}`); process.exit(3); }

const until = process.argv.find((a) => a.startsWith('--until='));
const end = until ? new Date(until.split('=')[1] + 'T00:00:00Z') : new Date();
// OFF BY ONE, FOUND ON THE FIRST SCHEDULED FIRE 2026-08-03T13:23Z BY seb_boss READING THE OUTPUT
// AGAINST A DRY RUN RATHER THAN CONFIRMING IT RAN.
//
// The loop ran `i = days; i >= 1`, so the newest row was `end - 1 day` — IT NEVER EVALUATED `end`
// ITSELF. The header, computed independently, said "7 day(s) ending 2026-08-03" while the rows ran
// 07-27 to 08-02. Header and range disagreed and only the header was right.
//
// WHY IT SURVIVED MY OWN DRY RUN: I tested with `--until=2026-08-04`, so `end` was TOMORROW and the
// newest row landed on today. THE BUG WAS INVISIBLE TO THE ONE TEST I RAN BECAUSE THAT TEST PASSED A
// FUTURE BOUNDARY. Under the cron, with no --until, `end` is now and today is silently excluded.
//
// THE CONSEQUENCE IS THE WHOLE POINT OF THE CHECK: THE DAY IT EXISTS TO CHECK WAS THE ONE DAY IT DID
// NOT EVALUATE. A brief-health check that silently ends at yesterday can never report today's brief
// missing, and it would look exactly like a clean run on the day it mattered.
const rows = [];
for (let i = days - 1; i >= 0; i -= 1) {
  const d = new Date(end.getTime() - i * 86400000).toISOString().slice(0, 10);
  const f = dayFacts(d);
  rows.push({ date: d, ...f, ...classify(f) });
}
// THE HEADER AND THE RANGE MUST NOT BE COMPUTED INDEPENDENTLY AGAIN. Assert they agree, in the tool,
// so a future edit to either cannot silently reintroduce the disagreement that hid this for one fire.
if (rows.length && rows[rows.length - 1].date !== end.toISOString().slice(0, 10)) {
  console.log(`VERDICT: COULD-NOT-RUN — internal window bug: header claims ${end.toISOString().slice(0, 10)} but the newest row is ${rows[rows.length - 1].date}`);
  process.exit(3);
}

console.log(`check-brief-health — AGENT ${AGENT} — ${days} day(s) ending ${end.toISOString().slice(0, 10)}`);
// SINGLE-AGENT BY CONSTRUCTION, and the output says so rather than leaving it implied. AGENT is hardcoded
// at line 41: the morning brief is seb_boss's and no other lane has an outbound-deliveries journal to judge.
// Named here because 'check-brief-health' reads like it takes an agent argument, and a reader running it
// while thinking about another lane would otherwise get seb_boss numbers with nothing indicating whose.
// Found 2026-08-03 by builder_1 auditing its own tools against: a tool verified only against its author's
// own data has been tested on the shape its author already had.
console.log(`SOURCE COVERAGE: presence from outbound-messages.jsonl (from ${journalStart(MESSAGES)}), ` +
            `state from outbound-deliveries.jsonl (from ${journalStart(DELIVERIES)}). ` +
            `A verdict for a date before a journal begins would be an artifact of the journal, not a fact about the day.`);
for (const r of rows) {
  console.log(`  ${r.code ? 'FLAG' : 'ok  '} ${r.date}  bus ${String(r.busEvents).padStart(3)}  telegram ${String(r.telegramRows).padStart(3)}  ${r.status}`);
}
const flagged = rows.filter((r) => r.code === 2);
console.log('');
for (const r of flagged) console.log(`${r.date} ${r.status}: ${r.detail}`);
console.log('');
console.log('THIS IS A SCHEDULED CHECK, NOT A WAKE-TRIGGERED RULE. The 06-18 failsafe evaluates only on');
console.log('resume, so it is blind to every failure where the agent stays up — which was THREE of the');
console.log('FOUR real degradations in the week of 07-23 (07-23, 07-24, 07-28).');
console.log('SUSPECT IS NOT ABSENT. Until outbound-deliveries carries a producer field, brief identity');
console.log('rests on preview text, and the 7am send is not always titled "MORNING BRIEF".');
process.exit(flagged.length ? 2 : 0);
}
