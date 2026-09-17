# The failure ledger — specified, QUEUED, not started

**Specified by the owner 2026-09-17. Deliberately not built.** The spec's own
closing instruction governs: *"It should sit after attempt persistence
works — not block the immediate identity and execution repairs."*

This file exists so the design is not lost and is not quietly shrunk. Per the
ruling in `docs/SLICE_CONTRACT.md`, the master map is authority and a report is a
claim; this is a record of a decision, not of work.

## The design, as given

Automatic capture, assisted classification. **No model judgment in V1.**

On a failed attempt, AgentBridge writes automatically:

```
failure_id
task_id
attempt_id
failure_class
failure_fingerprint
affected_files
command
exit_code
evidence_refs
status = observed
```

Fingerprint: `hash(repo + task class + affected files + normalized error)`.

A reviewer or the next agent then fills in root cause, missing observation,
repair applied, and the gate that should have caught it. Those are promoted only
once regression and mutation evidence exists.

**Reuse, before the next attempt:** match repo, match affected paths, match
task/failure class, return the top three prior failures, add them to the bounded
attempt packet. Ordinary database filtering and text normalization.

**Stages:** V1 automatic record + deterministic fingerprints. V2 reviewer-assisted
classification and proven repair linkage. V3 automatic retrieval into attempt
context. V4 performance scoring and routing by engine/task class. Later, semantic
similarity only where deterministic matching is insufficient.

**The hard part is not recording failures. It is preventing agents from writing
guesses as verified root causes.** Hence the states:

```
observed -> reproduced -> diagnosed -> repaired -> regression_proven
```

**Only `regression_proven` records may instruct future attempts as established
fact.** Everything earlier is a hypothesis and must read as one.

Sized as roughly one table, one deterministic fingerprint function, three write
points, one query, one context-compiler section.

## The dependency, MEASURED rather than assumed

The spec says AgentBridge already sees most of the needed evidence. Against
master at `5f08a17`, using `deadExports()` plus a call-graph trace:

| evidence source | module :: export | state |
|---|---|---|
| exit codes / test failures | `evidenceCollector.mjs :: parseTestSummary` | no production caller |
| attempt fingerprint | `fingerprint.mjs :: fingerprintAttempt` | referenced — **only by Loop B** |
| failure fingerprint | `fingerprint.mjs :: fingerprintFailure` | no production caller |
| review verdicts | `attemptRecord.mjs :: REVIEW_VERDICTS` | no production caller |
| verification verdicts | `attemptRecord.mjs :: VERIFICATION_VERDICTS` | no production caller |
| attempt steps | `attemptRecord.mjs :: attemptStep` | no production caller |
| lease refusals | `leases.mjs :: canClaim` | no production caller |
| fence refusals | `preExecutionGuard.mjs :: REFUSAL` | no production caller |
| production-caller check | `moduleGraph.mjs :: deadExports` | test-only (written today) |
| verification proof | `verificationProof.mjs :: assertProvable` | **wired and executed** |

**Two of eleven are wired. One has ever executed.**

`fingerprintAttempt`'s only caller is `attemptPipeline.mjs` — Loop B, which
nothing spawns. `worker.mjs` and `workerLoop.mjs`, the path that actually runs
work, reference it zero times. `assertProvable` is the exception, and it is a CLI
command a person invokes, not something the loop emits.

**So the three write points have nothing to write yet.** The collectors sit on the
path that does not execute. V1 is one table and one function ONLY once an attempt
leaves a durable record; before that it is a table nothing writes to, which is
the second entry on the owner's list of recurring failures.

This is not an argument against the design. It is the measured reason the
sequencing instruction is right.

## Entry condition

Do not start until ALL of these hold, each verified rather than asserted:

1. The two execution paths are reconciled — one path, not two (ORDER item 1b/2).
2. `attempts` holds rows from a real run, read back out of the database.
3. Those rows carry the fields V1 reads: command, exit code, changed files,
   verdicts.

Until then this file is the whole of the work.

## The one thing to get right first, whenever it starts

`status` defaults to `observed` and nothing may promote itself. A record that an
agent wrote a root cause into is still `observed`; only regression and mutation
evidence moves it, and only `regression_proven` may be quoted to a future attempt
as fact. A ledger that lets a guess read as a finding is worse than no ledger,
because the guess arrives with the authority of a database row.
