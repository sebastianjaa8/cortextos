# Merge review notes — seb_boss, 2026-08-06

## Reversed one Fable resolution: templates/hermes/USER.md

The templates/community agent kept HEAD's version, which contains Sebastian's real
name, working hours and communication preferences, and flagged it itself as "the one
judgment call worth a second look if these templates ship publicly."

They do ship publicly — the fork is PUBLIC. Took fork/main's generic placeholder
version instead. Correct on two counts: a template with a real person baked into it
is not a template, and this repo publishes.

Scanned the rest: `grep -rln "Sebastian" templates/ community/` returns nothing else.
This was the only instance.

Pre-existing, NOT introduced by this merge: the already-pushed branch
fork/local-main-2026-08-06 still carries the HEAD version of this file. Low
sensitivity — first name and working hours, no contact details, no credentials — but
worth scrubbing when the branch is next rewritten rather than urgently.
