# The slice contract

**Set by Danny, 2026-09-17, after a session in which every deliverable arrived
with a confession attached.** This file is not advice. It is the completion
standard, and `docs/AGENTBRIDGE_MASTER_BUILD_MAP.md` is the authority above it.

## The ruling

> Code can still implement, but the master map is now the authority, and Code's
> report is only a claim until the system proves it.

Nothing below is satisfiable by writing prose about it, including this file.

## Why it exists — the pattern, named by the owner

Recurring failures, each of which has happened here more than once:

- Correct modules that nothing calls.
- Tables that nothing writes to.
- Functions that were never scheduled.
- Routes present locally but not deployed.
- Tests that passed without exercising the real failure.
- Duplicate sources of truth.
- Counts reported from the wrong instrument.
- Roadmaps that quietly shrink the original requirements.
- "Completed" work with no end-to-end production evidence.

The through-line: **polished explanations and strong unit tests, failing at the
production wiring boundary.** Every one of those is a claim that looked like
evidence. That is why self-certification from prose is no longer accepted.

## The contract — every slice, all nine

1. Name the exact production caller.
2. Name every durable write.
3. Prove the success path.
4. Prove the refusal path.
5. Mutate back to the actual bug and watch the test fail.
6. Run one real end-to-end operation.
7. Read the resulting database rows back.
8. Have a different agent review it.
9. Do not mark complete from code, comments or test count alone.

**Items 6, 7 and 8 cannot be satisfied by the agent that wrote the slice.** 6 and
7 need the thing to actually run and leave a row; 8 needs somebody else. A slice
missing any of them is INCOMPLETE and says so, rather than being described as
built.

## What is mechanised, and what is not

| item | enforced by | limit |
|---|---|---|
| 1 | `test/deadExports.test.mjs` | proves a name is REFERENCED, not that the path RUNS |
| 2 | nothing yet | a durable write has no gate; state it by hand and prove with 7 |
| 3, 4 | the suite | unit level only |
| 5 | by hand, recorded in the commit | no harness in this repo (the sibling has one) |
| 6 | `agentbridge verify-sha` proves a COMMIT, not an OPERATION | not the same thing |
| 7 | nothing | needs the database |
| 8 | nothing — it is a person or another agent | — |
| 9 | this document | — |

**A green gate for item 1 is never evidence for item 6.** `deadExports` answers
"does shipped code mention this name". It cannot answer "did this ever execute".
Reading it as end-to-end proof would be the same substitution the contract exists
to stop.

## Slice 5 — completion seam: INCOMPLETE

Scored against the contract on the day the contract was written, by the agent
that wrote the slice, which is why item 8 is unmet by construction.

| item | completion seam | verify-sha |
|---|---|---|
| 1 production caller | **FAIL** — `workFingerprint`, `resolveWork`, `canComplete`: zero callers | PASS — `agentbridge verify-sha` |
| 2 durable writes | **FAIL** — zero; no `completions` table in any migration | n/a, writes nothing by design |
| 3 success path | PASS, unit only | PASS |
| 4 refusal path | PASS, unit only | PASS |
| 5 mutation watched fail | PASS | PASS |
| 6 real end-to-end | **FAIL** | PASS — `1e61b09` refused, `ec6b02d` verified, one file apart |
| 7 rows read back | **FAIL** — nothing writes rows | n/a |
| 8 different agent review | **FAIL** | **FAIL** |
| 9 not complete from tests | **FAIL** — the commit messages did exactly that | **FAIL** |

**The claim "the completion seam is built" is retracted.** What exists is a pure
decision module with no caller and no store, plus a path-overlap helper that IS
wired into `check-first`. The overlap helper is the side dish; it is what made
the module-level orphan gate go green while the seam itself was dead.

The measurement that found it was itself nearly wrong in the way item 7 of the
failure list describes: a hand grep reported `resolveWork: 13 callers`, and every
one was `resolveWorker`. Counted with the wrong instrument, checked, corrected.
`test/deadExports.test.mjs` now matches on word boundaries and plants exactly
that pair as a fixture.

## What slice 5 needs to become complete

Not more tests. These, in order:

1. The `completions` table and the partial unique index from the master map
   §3.6 — DDL, which is not this lane's to write.
2. A production caller: proposal or execution asking `resolveWork` before
   creating a task, and the completion writer calling `canComplete`.
3. One real task taken through create → execute → review → complete.
4. The rows read back out of the database afterwards.
5. A review by an agent that did not write it.
