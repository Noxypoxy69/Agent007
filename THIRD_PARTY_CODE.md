# Third-party code ledger

**Status 2026-09-16: EMPTY, and verified empty rather than assumed.** Searched
`src`, `bin`, `mcp`, `supabase` and `test` for `MIT License`, `Apache License`,
`Copyright (c)` and `SPDX-License`: no matches. Nothing in this repository has
been copied or adapted from another project. Every module was written here.

This file exists BEFORE the first copy, not after it. `docs/SELF_CORRECTION_INGEST.md`
plans to adapt MIT and Apache-2.0 code from mini-SWE-agent, SWE-agent, SWE-ReX,
OpenHands' MIT core, Agentless, self-refine and OpenAI Symphony. A ledger started
after that work begins is a ledger written from memory, and the one fact nobody
reconstructs correctly six weeks later is which lines were adapted and which were
typed fresh.

## The rule

**An entry lands in the same commit as the code it describes, or the code does
not land.** Not the next commit, not a follow-up pass. A reviewer must be able to
answer "where did this come from" from the diff in front of them.

This applies to adapted code as much as to copied code. "Adapted" is not a way
out of attribution; it is a value of the `copied vs adapted` field below.

## What each entry records

| Field | Why it is here |
|---|---|
| repository | the upstream project |
| commit SHA | a moving target is not a provenance record |
| file / path | upstream path, so a future reader can diff against it |
| license | MIT, Apache-2.0, other — the actual one, read, not assumed from the badge |
| copyright | the holder line as written upstream |
| copied vs adapted | and if adapted, adapted how far |
| target path | where it lives here |
| modifications | what was changed and why |
| required notice | what must be reproduced, and where it is reproduced |

## Entries

*(none)*

## Two things that are not licence questions but belong next to them

**OpenHands ships MIT core alongside source-available commercial components.**
The ingest is scoped to the MIT core only. Confirm the licence of the specific
file, in the specific commit, rather than the licence of the repository.

**RepairAgent's licence is unconfirmed.** `docs/SELF_CORRECTION_INGEST.md` mines
its state machine as a pattern. Patterns are not copyrightable; an
implementation is. Do not copy from it until somebody has read its LICENSE file
and written the answer here.
