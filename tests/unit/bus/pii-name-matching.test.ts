/**
 * tests/unit/bus/pii-name-matching.test.ts
 *
 * Whole-name matching for the prepare-submission PII scan.
 *
 * The previous implementation was a substring test. With a real name list that is a false-positive
 * generator — a short surname hits every longer word containing it — and a scanner that cries wolf
 * scrolled past. Unlike a noisy cron report, the thing being scrolled past here is the last gate
 * before a public repository.
 *
 * EVERY NAME BELOW IS INVENTED. This file is committed, so using a real entry from the live list
 * would publish the exact thing the scanner exists to keep out of a public repo.
 *
 * The first draft of this file DID contain two real entries, under a comment asserting it did not.
 * A leak scan over the diff caught them. Recorded because the failure is the interesting part: the
 * comment claiming compliance was written before the compliance existed, and reading the comment
 * would have confirmed it. Only comparing the diff against the list found it.
 */
import { describe, it, expect } from 'vitest';
import { matchesWholeName, loadPiiNames } from '../../../src/bus/catalog';

describe('matchesWholeName', () => {
  it('matches a whole single-token name, case-insensitively', () => {
    expect(matchesWholeName('contact Alvarez about it', 'alvarez')).toBe(true);
    expect(matchesWholeName('CONTACT ALVAREZ', 'Alvarez')).toBe(true);
  });

  it('does NOT match a name embedded in a longer word', () => {
    // This is the whole reason the substring version was wrong: a short name inside a longer word.
    expect(matchesWholeName('we queried the Oracle', 'Ora')).toBe(false);
    expect(matchesWholeName('a pale aurora', 'Ora')).toBe(false);
    expect(matchesWholeName('https://example.com/floramint', 'Flora')).toBe(false);
  });

  it('matches a two-part name only as a WHOLE, never either half alone', () => {
    expect(matchesWholeName('ask Dana Alvarez tomorrow', 'Dana Alvarez')).toBe(true);
    // Half-matches must not fire: neither part alone is the protected name.
    expect(matchesWholeName('ask Dana tomorrow', 'Dana Alvarez')).toBe(false);
    expect(matchesWholeName('ask Alvarez tomorrow', 'Dana Alvarez')).toBe(false);
  });

  it('tolerates a line break or repeated spaces inside a name', () => {
    // A name wrapped by a formatter is still the name; missing it would fail in the silent
    // direction, which for this scanner means a leak reported clean.
    expect(matchesWholeName('ask Dana\n  Alvarez tomorrow', 'Dana Alvarez')).toBe(true);
    expect(matchesWholeName('ask Dana\tAlvarez tomorrow', 'Dana Alvarez')).toBe(true);
  });

  it('matches at string boundaries and next to punctuation', () => {
    expect(matchesWholeName('Alvarez', 'Alvarez')).toBe(true);
    expect(matchesWholeName('(Alvarez)', 'Alvarez')).toBe(true);
    expect(matchesWholeName('owner: Alvarez.', 'Alvarez')).toBe(true);
    expect(matchesWholeName('Alvarez, owner', 'Alvarez')).toBe(true);
  });

  it('finds a later occurrence when an earlier one is embedded — does not stop at the first hit', () => {
    // A naive implementation returning on the first indexOf would report false here.
    expect(matchesWholeName('the Oracle spoke but Ora is a person', 'Ora')).toBe(true);
  });

  it('treats an email-shaped name as a whole token', () => {
    expect(matchesWholeName('mail nobody@example.com now', 'nobody@example.com')).toBe(true);
    expect(matchesWholeName('mail someoneelse@example.com', 'nobody@example.com')).toBe(false);
  });

  it('an empty or whitespace-only name never matches — it would otherwise match everything', () => {
    expect(matchesWholeName('anything at all', '')).toBe(false);
    expect(matchesWholeName('anything at all', '   ')).toBe(false);
  });

  it('does not treat the name as a regex — a name with metacharacters is a literal', () => {
    // The implementation is deliberately regex-free; this pins that so a future "optimisation"
    // back to RegExp has to keep the property. `.` must not act as any-char.
    expect(matchesWholeName('the a.b file', 'a.b')).toBe(true);
    expect(matchesWholeName('the axb file', 'a.b')).toBe(false);
  });
});

describe('loadPiiNames', () => {
  it('returns [] for a missing config rather than throwing — absence is reported, not fatal', () => {
    // The caller turns [] into a NAMED skipped check, so a missing list degrades to an honest
    // partial scan instead of a crash or a silent full-looking pass.
    expect(loadPiiNames('/definitely/not/a/real/ctxroot')).toEqual([]);
  });
});
