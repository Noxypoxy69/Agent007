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

## EXCLUDED — DO NOT CLONE, READ OR ANALYSE

**MCP Agent Mail (Rust)** — commit `e97e29fa`, reported by an outside reviewer
2026-09-17. Its licence carries a rider prohibiting use and analysis by
OpenAI and Anthropic models. The reviewer deleted its clone on discovering this,
which was the right call.

**This binds the agents working in this repository, not only the humans.** Every
coordinator and worker here is an Anthropic model. Cloning it to "just look at
the inbox design" is the prohibited act, not a step toward one. Do not fetch it,
do not read it through a tool, do not paste excerpts into a session.

We may independently implement inboxes, acknowledgements, receipts and
dead-letter handling — those are ordinary designs, not its property. The
constraint is on reading THAT codebase, not on the problem it solves. Anything
built here for message delivery must be written from the requirements, and this
ledger is where that provenance gets recorded if it ever stops being obvious.

Recorded here rather than in a chat message because the next agent to go looking
for messaging prior art will search this file, not somebody's transcript.

## Two things that are not licence questions but belong next to them

**OpenHands ships MIT core alongside source-available commercial components.**
The ingest is scoped to the MIT core only. Confirm the licence of the specific
file, in the specific commit, rather than the licence of the repository.

**RepairAgent's licence is unconfirmed.** `docs/SELF_CORRECTION_INGEST.md` mines
its state machine as a pattern. Patterns are not copyrightable; an
implementation is. Do not copy from it until somebody has read its LICENSE file
and written the answer here.
# Claude coding-guard donors (2026-09-17)

- `karanb192/claude-code-hooks`, MIT, pinned review revision
  `a7122bc702057f71b250fdd40ccbd6cebb8019e8`. AgentBridge's emergency guard is
  informed by its protect-tests, config-guard, and git-safety patterns.
- `alexfazio/plankton`, MIT, pinned review revision
  `085d6727f0fd4b5d2c8b64b090d89b5c798f7b39`. AgentBridge uses its pattern of
  protecting quality configuration, with a fail-closed implementation.
- `jpicklyk/task-orchestrator`, MIT, pinned review revision
  `074130f913df7b8cdef51027ae8ca882c98ba518`. Architecture reference for
  server-enforced task transitions and actor attribution; no Kotlin copied.
- `databricks-solutions/consort`, DB License, inspected at
  `3c3af22c2d9ce7fb2d803e827a118cccb798e028`. Architecture reference only;
  source is restricted to use with Databricks Services and was not reused.
- `0xHoneyJar/loa`, AGPL-3.0. Architecture reference only; no code copied.
