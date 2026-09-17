# Agent Bridge — Self-Correction / OSS Code Ingest
## Absorbed 2026-09-16. Ordering and reconciliation only; nothing here is built yet.

Source: `agent_bridge_self_correction_oss_code_ingest_1.md`, handed over by Danny
2026-09-16 evening. This file is the absorbed form. The pack is a roadmap, so it
is written into the map before anything is built from it, which is the thing
that did not happen for five hours.

## This is a DIFFERENT AXIS from RELIABILITY_INGEST, and conflating them wastes a week

`docs/RELIABILITY_INGEST.md` mines Temporal, DBOS, Restate, NATS, pg-boss,
Hatchet, Trigger.dev, LangGraph and the Microsoft Agent Framework. Every one of
those answers the same question: **how does work survive a crash.** Durability,
queueing, leases, redelivery, exactly-once, reconciliation.

This pack answers a question none of them touch: **how does a wrong patch fail
to become a trusted patch.** Localize, patch, execute, observe, classify the
failure, repair, retest, regress, review, verify on a clean SHA, promote.

They meet in exactly one place -- the attempt record -- and nowhere else. Two
names appear in both documents, SWE-agent and OpenHands, and in
RELIABILITY_INGEST they appear only for trajectories and clean retry
boundaries, which is one paragraph of section A here.

## The executive rule, kept verbatim because it is the whole point

```text
bad patch can be proposed
→ bad patch cannot become trusted
```

We are not trying to make the model stop writing bugs.

## WHAT ALREADY EXISTS, UNDER DIFFERENT NAMES

This is not greenfield, and treating it as greenfield would rebuild twelve
modules. The shape was arrived at independently; the vocabulary was not.
Measured against master, not remembered:

| Pack concept | What exists here | Honest gap |
|---|---|---|
| mini-SWE-agent loop | `workerLoop.mjs`, `attemptPipeline.mjs` | no trajectory/event record per step |
| SWE-ReX execution model | `executorAdapter.mjs`, `executorLocal.mjs` | one shell, no parallel sandbox sessions |
| OpenHands action/observation | `events.mjs`, `resultEnvelope.mjs`, `toolOutput.mjs` | no typed Observation; no ToolRegistry |
| Symphony scheduler/workspaces | `schedule.mjs`, `workspaceManager.mjs`, `leases.mjs` | no reconciler, no bounded concurrency |
| Attempt persistence | `attemptRecord.mjs` | see below -- verdicts, not a state machine |
| Reviewer loop | `reviewRunner.mjs`, `reviewerPacket.mjs`, `reviewDecision.mjs` | no typed `ReviewFinding`; routes undeployed |
| Repair budget | `tokenBudget.mjs`, `loopDetector.mjs`, `escalation.mjs` | no `maxChangedFilesDelta`, no repair-attempt cap |
| Mechanical invariants | `preExecutionGuard.mjs`, `agentPermissions.mjs`, the check scripts | lint rules do not carry remediation text |
| Promotion gate | `deployGate.mjs` | **not a clean-SHA gate; see below** |

## WHAT DOES NOT EXIST AT ALL, VERIFIED BY SEARCH RATHER THAN BY MEMORY

- **`AttemptState`** -- the eleven-state lifecycle. `attemptRecord.mjs` carries
  outcome verdicts (`done`, `failed`, `crashed`, `abandoned`, `refused`) and
  review verdicts (`accept`, `reject`, `fix_required`, `inconclusive`). Those are
  answers to "how did it end", not "where is it now". No state machine, so
  nothing can be resumed at `REPAIRING` after a restart.
- **`AttemptStep`** -- **CORRECTION, 2026-09-17: this file was wrong when first
  committed.** It said zero. `attemptRecord.mjs` exports `attemptStep()` and a
  frozen `STEP_KINDS` of twelve: CLAIM, PREPARE_WORKSPACE, COMPILE_CONTEXT,
  START_EXECUTOR, AGENT_RUN, COLLECT_RESULT, VERIFY, PUBLISH_ARTIFACTS,
  REQUEST_REVIEW, REVIEW, ACCEPT_OR_REJECT, CLEANUP. I searched for the
  TypeScript-style identifier `AttemptStep` from the pack, case-sensitively, and
  a lowercase JavaScript function named for the same thing did not match. Searching
  for a spec's spelling instead of the codebase's is how a repo gets a second
  implementation of something it already has, which is the specific outcome this
  document exists to prevent.

  The real gap is narrower and worth stating exactly: the step kinds cover the
  ORCHESTRATION path, claim through cleanup. The pack's kinds are about the
  REPAIR path -- INSPECT, LOCALIZE, EDIT, REPAIR. AGENT_RUN is one opaque step
  where the pack wants a trajectory, so a repair loop still has nothing to read
  back, for a different reason than "there is no step record".
- **`FailureClass`** -- zero occurrences of any member of the taxonomy. Re-checked
  after the `AttemptStep` error above, including lowercase and camelCase spellings. Every
  failure is currently untyped text, which means the repair loop in section 4
  cannot be written at all: it begins with "classify".
- **Clean-SHA verification** -- **nothing in the repository does a fresh
  checkout of the exact SHA and re-runs the suite.** `deployGate.mjs` checks that
  a commit was promoted and asks the far end what it is serving; it does not
  establish that the commit passes from a clean tree. So the pack's critical
  invariant, `worktree passing ≠ promotable`, is currently unenforced, and
  `check:clean-checkout` in the sibling repo exists precisely because that gap bit
  once already.
- **`VerificationProof`** -- no immutable artifact records that a SHA passed.
- **Fault localization** (Agentless) -- no file→function→edit-location narrowing.
- **Multi-candidate patches and evaluator scoring** -- none. Phase 5, correctly last.
- **`agentbridge inspect logs|tests|metrics|queue|diff`** -- none of these commands exist.
- **Repo knowledge layout** -- `AGENTS.md`, `WORKFLOW.md`, `docs/architecture/`,
  `docs/domains/`, `docs/invariants/`, `docs/runbooks/`, `skills/` are all absent.
- **`THIRD_PARTY_CODE.md`** -- created empty by this commit, see below.

## THE LICENSE POSITION, ESTABLISHED BEFORE THE FIRST COPY RATHER THAN AFTER

Searched for `MIT License`, `Apache License`, `Copyright (c)` and `SPDX-License`
across `src`, `bin`, `mcp`, `supabase` and `test`: **no matches.** Nothing has
been copied or adapted from any of these projects yet, so there is no
outstanding attribution debt today. Every module in the table above was written
here.

That is the good case and it is fragile. The pack's whole premise is copying MIT
and Apache code, and a ledger written after the first copy is a ledger written
from memory. `THIRD_PARTY_CODE.md` therefore exists now, empty, with the rule
stated: an entry lands in the same commit as the code it describes, or the code
does not land.

## ORDERING, AND WHY IT DIFFERS FROM THE PACK'S OWN PHASE 1

The pack opens Phase 1 with "ingest/adapt mini-SWE-agent loop". That is the
wrong first move **here**, because the loop already exists and the thing missing
underneath it is evidence.

The blocking fact: the `attempts` table has **0 rows**, measured 2026-09-16
22:33, against a writer merged at 18:49 in `2e34c48`. Something between the
pipeline and the table is unreached or failing silently. Until one real row
lands, every item below is unobservable -- a repair loop that cannot read a step
record, a classifier with nothing to classify, a proof with nothing to prove.

So:

1. **One real attempt row.** Not a fixture. Prove the writer is reached.
2. **`AttemptStep` persistence.** The trajectory the repair loop reads back.
3. **`FailureClass` taxonomy + a typed failure artifact per failed validation.**
   Section 4 cannot start before this.
4. **The repair loop**, with the budget and the hard rule: do not rewrite
   unrelated code unless evidence points there.
5. **Clean-SHA verification and `VerificationProof`.** This is the one item that
   could be pulled forward, because it is the invariant with a live hole and it
   does not depend on 1-4.
6. Agentless localization, then the typed reviewer loop, then Symphony
   reconciliation, then invariants and observability, then multi-candidate last.

## WHAT THE PACK GETS RIGHT THAT THIS REPO KEEPS REDISCOVERING

```text
MODEL_OUTPUT != SUCCESS
TEST_PASS_IN_DIRTY_WORKTREE != PROMOTABLE
HTTP_200 != SIDE_EFFECT_VERIFIED
REVIEW_TEXT != REVIEW_PROOF
RETRY != SAFE_UNLESS IDEMPOTENT
SELF_REFLECTION != MACHINE_EVIDENCE
```

Every one of those has already cost this project a day. `HTTP_200 !=
SIDE_EFFECT_VERIFIED` is the deploy that shipped nothing and reported success.
`REVIEW_TEXT != REVIEW_PROOF` is why a plain "looks good" is not accepted.
`SELF_REFLECTION != MACHINE_EVIDENCE` is the hollow gate in one line.
