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

---

# Record 1 — the first `regression_proven` failure

**The table does not exist yet and this is not a row.** It is the record written
by hand, in the schema above, because the failure it describes is the one this
ledger was specified to hold and losing it while waiting for attempt persistence
would be the point of the whole thing missed. Entered at the owner's direction.

```yaml
failure_id: F-0001
failure_class: gate_defect
symptom: a failing zero-test script minted a VERIFIED proof
failure_fingerprint: hash(agent007 + gate_defect + [src/verificationProof.mjs,bin/agentbridge.mjs] + "verified despite nonzero exit and unreconciled counts")
affected_files:
  - src/verificationProof.mjs
  - bin/agentbridge.mjs
command: agentbridge verify-sha <sha>
exit_code: 0            # the defect: it should never have been 0
root_cause:
  - candidate controlled the verification command
  - suite exit status ignored
  - incomplete count reconciliation
  - unsigned digest mistaken for attestation
missing_observation:
  - process exit status, termination signal and timeout were not captured
  - tracked-tree state after install and after the suite was not measured
gate_that_should_have_caught_it:
  - malicious candidate-owned suite mutation
repair:
  - observation-only contract
  - mandatory versioned promotion blockers, failing closed
  - exact count reconciliation including cancelled and todo
  - exit / signal / timeout binding
  - full semantic revalidation on read
  - exit 0 reserved for promotable; renamed verify-sha -> observe-sha
status: regression_proven
introduced_sha: 5f08a17
fixed_sha: f7e9939      # mechanical repair; authority and exit semantics followed
evidence_refs:
  - reproduction: a clone whose package.json set scripts.test to
    'printf "# tests 1662\n# pass 1647\n# fail 0\n# skipped 15\n"; exit 1'
    was reported VERIFIED with a proof minted, having run zero tests
  - the exit-0 variant of the same attack is STILL observed and is refused
    promotion by the candidate-controlled-suite blocker, not by a refusal
  - six mutations, each restoring one original defect, each red on the tests
    that exist for it; restores diffed byte-identical
```

## Why this one earns `regression_proven`

The state machine says `observed -> reproduced -> diagnosed -> repaired ->
regression_proven`, and only the last may instruct future attempts as fact. This
record walked all five:

- **reproduced** against a real clone before any repair, not argued from the
  review text. A defect list accepted from prose is the same error pointed the
  other way.
- **diagnosed** to four independent failures that had to line up together.
- **repaired** narrowly, and the parts that could not be repaired -- signing, a
  trusted policy store, isolation -- became mandatory blockers instead of being
  quietly dropped.
- **regression_proven** by putting each original defect back and watching the
  tests go red, then restoring byte-identical.

## The part that is NOT proven, recorded so it cannot be read as fact

The exit-0 variant of the attack still produces an observation. It runs zero
tests and says so to nobody. It is not refused and cannot be while the candidate
defines its own suite. That is a live, known hole with a named blocker, not a
solved problem, and no future attempt may quote this record as evidence that
candidate-supplied suites are safe.
