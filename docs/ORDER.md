# The order

One list. Everything else queued behind it. `BACKLOG.md`,
`AMENDMENT_MATRIX.md`, `CONSOLE_UI0.md` and `EXPERT_WORKFORCE_MAP.md` are
reference material for the tail of this list — not work.

**The only milestone that counts:** one task goes queued → leased → coded →
machine-verified → independently reviewed → accepted → closed, with nobody
watching. Then a second one unlocks from the first and does the same.

**Revised 2026-09-16** against the reliability ingest. Nine of its Phase A items
were already on this list in this order, which is the useful finding — the
mining did not turn up a missing subsystem. It moved one item onto the critical
path that was parked beside it, and added two that were not here at all. Those
three are marked NEW. Phases B and C below are new sections and they are
correctly behind the loop, not in front of it.

---

## Blocking the loop

**0. ~~Deploy the edge function.~~ ALREADY LIVE — closed 2026-09-16 08:18.**
EVIDENCE: unverifiable live state is not in git; the provider is the only authority. deploy/last-deployment.json records what was shipped and has been reconciled after the fact four times today, which is itself the argument for asking the far end rather than the file.
`/task` and `/renew` SHIPPED in version 20, along with `/dispatch`,
`/register`, `/return`, `/wait` and `/health`. code-c's 04:53 report — *"until
they ship a worker cannot read its task, cannot renew"* — was true against
version 17 and stopped being true when version 20 shipped the outage fix and
carried those routes with it. **Nothing downstream was ever waiting on this.**

*I put it at the top of this list on the strength of that report and never
checked it against the live function. Read the deployed source; a report about
production ages the moment somebody deploys.*

**0b. What is actually live, measured against the platform's own copy.**
Version 20 is byte-identical to `origin/code-b/fifth-hosted-path` at `bb899fc`
in both `index.ts` and `_shared.js`. So production DOES correspond to a commit —
better than this morning's reading, where the outage looked like it had shipped
from an uncommitted tree; the fix was committed to that branch.

**Against production, master is 0 ahead and 14 BEHIND.** Deploying master would
ship nothing new and would REMOVE 232 lines currently serving traffic — the
single-transaction claim path, the rpc shape check, the refusal-reason mapping —
reinstating the read-decide-write race code-d found. *A pure regression wearing a
fresh version number, which is what a successful deploy looks like from outside.*

**So the merge is not queued behind a deploy. The merge IS the deploy**, and any
tree that ships must contain `fifth-hosted-path` or it goes backwards.

**1. ~~Merge THREE branches and deploy the result.~~ DONE — verified 2026-09-17.** — was code-c
EVIDENCE: merged bb899fc code-b/fifth-hosted-path
EVIDENCE: merged 1a97aa0 work/recover-orphan-branches
EVIDENCE: merged 8793112 work/support-modules
EVIDENCE: merged 9ba9c96 code-b/lease-wiring — the one this entry warned to check by hand
**All six branches are ancestors of master `6c8e181`**, checked with
`git merge-base --is-ancestor` rather than read off a list: `code-b/fifth-hosted-path`
(`bb899fc`), `work/recover-orphan-branches` (`1a97aa0`), `work/support-modules`
(`8793112`), `b/attempt-record` (`a816ae4`), `work/reviewer-runtime` (`e992bec`),
and `code-b/lease-wiring` (`9ba9c96`) — the one this entry specifically warned to
check by hand rather than assume.

**THIS ENTRY STAYED RED AFTER IT WAS GREEN, AND THAT IS THE EXPENSIVE PART.** It
reads "nothing below can start until the pipeline is on master", so item 2 has
been blocked on paper while being unblocked in fact, for hours, with its assignee
dark since 12:30Z. Nobody rechecked because the document said not to bother. A
blocker is a claim about the world and goes stale like any other; re-measure it
before believing it, especially when it is the reason something is not being
worked on.

*(original brief kept below)*
**1a. Merge THREE branches and deploy the result.** — was code-c
`code-b/fifth-hosted-path` (what is live, 14 ahead), then
`work/recover-orphan-branches` (11 ahead), then `work/support-modules`
(22 ahead, ends at `50f28a2`). Each contains master entire, so none drops
anything. Danny authorised one deploy at 08:18; that is one deploy, not a
standing grant. `code-b/lease-wiring` is NOT an ancestor of `fifth-hosted-path`
despite its merge commit being in that history — it has moved since, so check it
rather than assuming it is covered. Both green.
Nothing below can start until the pipeline is on master, because the worker
cannot call what is on a branch. *This is first and it is nobody's favourite
task, which is exactly why it gets skipped.*

**1b. THERE ARE TWO LOOPS, AND THE ONE THAT RUNS HAS NO GUARDS.** — code-a, ahead of item 2
EVIDENCE: commit 4a4d0c4 the dispatcher that assigns work autonomously
EVIDENCE: unverifiable the import counts below are a grep of master and are restated here rather than linked, because the point is the ZEROES and a reader must be able to see them without running anything. Re-measure with: grep -c preExecutionGuard src/worker.mjs

Measured 2026-09-17 while answering "is the loop almost done". It is not, and the
risk runs the opposite way from how this file has been reading.

**THE LOOP ALREADY RUNS AUTONOMOUSLY.** Task `t-wire-gate-scripts` was created at
23:35, assigned at 00:09 by the supabase pg_cron dispatcher, executed, and
returned at 00:15 on attempt 2 with the note "worker: wired check:edge-deploy,
deploy:check into package.json". No human in the path. That is real autonomous
execution and it has already happened.

**AND `attempts` IS STILL 0, WHICH MEANS SOMETHING WORSE THAN "NOTHING RAN".**
There are two execution paths for the same job:

    LOOP A   agentbridge work -> worker.mjs -> workerLoop.mjs -> workerDeps.startRun
             RUNS. Did the task above.
             preExecutionGuard 0   agentPermissions 0   attemptRecord 0
             contextCompiler   0   loopDetector     0   evidenceCollector 0

    LOOP B   runAttempt -> attemptPipeline
             NEVER RUN. Nothing spawns bin/agentbridge-attempt.mjs.
             Imports all twelve: guard, permissions, attempt record, context
             compiler, evidence, fingerprint, loop detector, reviewer packet,
             token telemetry.

The loop that executes work has none of the safety. The loop carrying every
control built over the last two days is the one nothing calls. Those are zeroes
from a grep of master, not an impression.

**THIS IS THE SECOND-SOURCE-OF-TRUTH FAILURE, in the most expensive place
available.** Every guard written for the runtime guards a path that does not
execute, and the path that executes was never reviewed as a runtime because
nobody noticed it had become one.

**SO ITEM 2 IS NOT THE NEXT MOVE, AND "WIRE THE SPAWN" IS THE WRONG FRAME.** The
two paths have to be reconciled, not connected: either Loop A calls runAttempt,
or Loop B's guards move into Loop A. That is a design decision with lease
semantics in it and it belongs to whoever owns the loop. Connecting them without
choosing would give this repository three paths.

*Found by c8 while answering a question, not by any gate. Nothing in the suite
compares the imports of the path that runs against the path that is guarded, and
that check is worth writing once somebody has decided which path survives.*

**2. Wire the lease to the pipeline.** — UNBLOCKED 2026-09-17, needs an owner
*(was code-c, dark since 12:30Z; the autonomous-loop lane is code-a's as of the
16th, and this is lease and fence semantics, so it is not c8's to take)*

**DIAGNOSED 2026-09-17, so whoever picks it up does not start at the database.**
`attempts` holds 0 rows, and it is not a silent write failure. `runAttempt` — the
only path that writes an attempt record — is imported by exactly one file,
`bin/agentbridge-attempt.mjs`, and **nothing spawns that binary.** Zero references
from `daemon.mjs`, `worker.mjs`, `workerLoop.mjs`, `dispatch.mjs`, `runtime.mjs`
or `bin/agentbridge.mjs`; the only mentions anywhere are its own `package.json`
bin entry, `moduleGraph.mjs`, a comment in `agentbridge-review.mjs` and this
document. The writer is fine and is covered by `test/attemptPipeline.test.mjs`
and `test/unattendedLoop.test.mjs`. The row is missing because the spawn was
never built, which is exactly this item and nothing else.
claim → `runAttempt` → return. The daemon owns the lease, never the process it
starts. `bin/agentbridge-attempt.mjs` is a working caller of everything except
those three verbs.

**3. Persist the attempt record. BUILT, NOT WIRED — corrected 2026-09-17.** — b6 built it; I claimed to have wired it and had not
EVIDENCE: commit e76fe61 the writer itself, which is real and is covered by attemptPipeline.test.mjs
EVIDENCE: unverifiable the WIRING claim is false and was falsified by measurement, not by argument: the attempts table held 0 rows at 2026-09-16 22:33, and runAttempt is imported by exactly one file, bin/agentbridge-attempt.mjs, which nothing spawns. Closing this needs item 2, not more work here.

**THIS LINE IS WHY THE GATE ABOVE EXISTS.** It read "BUILT AND WIRED" and named
me as the one who wired it, for a day, while the table it writes to was empty. I
wrote it after merging the writer and never checked that anything called it. A
state written once by hand and then believed is indistinguishable from a true
one until somebody measures, and nobody measures prose.

code-b built the row and deliberately left it uncalled, declaring why in the
orphan list: the write must happen under the lease that authorised the work, and
a caller invented to satisfy a gate would put it outside the fence. Resolved by
splitting it — the START write happens before any work, when the claim's lease
is the newest thing in the room; the FINISH write goes through `io.records`,
which is the fenced write at the return boundary. A fence check in the pipeline
would be a second implementation of lease semantics.
All four verdicts are stored separately, and a false done — agent claims success,
machine rejects — is now a passing test rather than an argument.

*(original brief kept below)*
**3a. Persist the attempt record.** — b6
Must land before step 7 runs, or the first real attempts are unrecorded and
unrecoverable. Routing identity — engine, model, role profile, worker slot,
lease, fence — plus all three verdicts stored separately: what the agent
claimed, what the machine verified, what the reviewer decided. Never one
`status` column. *Small, and four separate specs bottom out on it.*

**4. A reviewer runtime.** — code-a *(built; SQL applied; ROUTES NOT DEPLOYED)*
Branch `work/reviewer-runtime`, head `4b655c8`, based on `work/support-modules`
at `2e65ed1`. Suite 1449 -> 1497 tests, 0 failures either end.

`src/reviewRunner.mjs` claims the lease, builds the packet, runs a reviewer in a
fresh worktree at the REVIEWED commit, and submits under the token that
authorised it. `src/reviewDecision.mjs` holds everything that decides, so the
suite can import it. The lease is NOT re-implemented in JS -- `claim_review`
decides and the runner honours refusals it did not predict, per the owner ruling
that keeps `src/runtime.mjs` orphaned.

**APPLIED TO PRODUCTION**, and the second gap was the one worth finding: a review
could be claimed, renewed and reaped and COULD NOT BE RECORDED. `submit_review`
did not exist. Migration `20260916180034` is that fenced write;
`20260916180146` implements Danny's standing ruling that `claim_task` must
refuse while a live review lease exists -- which stopped being optional the
moment `claim_review` acquired a caller. Both verified by probe in transactions
that rolled back, once before applying and once after.

**NOT DEPLOYED, AND THIS IS THE WHOLE REMAINING GAP.** The two edge routes
(`/review/claim`, `/review/submit`) exist only on that branch. The database can
record a review and nothing outside can reach it. The CLI names a 404 as
`route-absent` rather than as a credential or network fault, so it fails
honestly, but it fails.

**0b IS STALE — MEASURED 2026-09-16 evening.** Production went 21 -> 22 -> 23
today from at least two places. The feared regression did NOT happen: the
deployed entrypoint still carries the single-transaction claim path, the rpc
shape check and the refusal-reason mapping, checked by name. Two things to carry
forward. Compare NORMALISED: the deployed bundle is CRLF and the repo is LF, so
a raw diff reports all 1813 lines of `index.ts` changed and means nothing. And
v23 is byte-identical to v22 -- a successful deploy that shipped NOTHING,
because it ran from a checkout without the branch. `scripts/check-edge-deploy.mjs`
refuses a deploy that removes a line and says so when one would change nothing.

**ONE DESIGN QUESTION I REFUSED TO DECIDE QUIETLY.** On `fix_required` the
reviewed task goes to `blocked` and depends on the fix task. What happens to it
once the fix is ACCEPTED is NOT implemented: dependency unlock returns it to the
pool to be re-attempted from its ORIGINAL base, throwing the fix away, or
accepting the fix should accept the original. Both defensible. Needs Danny or
whoever holds item 1.

**THE AUTHORISATION FOR THE MIGRATION IS NOT IN THE LEDGER.** Danny said apply,
in chat. `resolve_owner_decision` returns `no_decision` for a production
migration in this context, and a worker cannot record it -- owner and recorder
must be the same person, which is the mechanism that correctly refused c8 this
morning. Item 7's complaint, with one more instance.

**5. Canonical identity and recipient validation.** — me *(built, awaiting 1)*
NEW to this section; it was in "not on the list" this morning and the ingest is
right that it belongs here. The argument that moved it: with no chat open, a
message to a name nobody reads is undetectable. Twenty-nine already went to two
names that have never once spoken. An unattended run that stalls on a silently
dropped assignment looks identical to one that is still working.
Alias table, canonical id per seat, unknown recipient refused, offline
distinguished from unknown. On `work/support-modules`; ships with item 1.

*Two things learned since, both from the live system rather than from the spec.*
*B has two registrations, `code-b` and `b6`, and canonicalising on the way in*
*fixes what a sender may write and nothing about what B can read — a message is*
*stored under the literal string it was sent with. The read half is `inboxNames`*
*and no reader uses it yet, so a canonical id is the right name and not always*
*the reachable one. And four handoffs sent this morning came back reported as*
*instructions from Danny: the envelope carries the sender, whatever surfaces it*
*to a worker does not, so every body now opens by naming who is speaking and*
*saying that coordination is not a ruling. A worker that cannot tell the two*
*apart has an owner nobody appointed, which would make the ledger decorative.*

**6. A hard deploy gate.** — unassigned
NEW. Deploy accepts only a promoted immutable commit, records the artifact
digest, and reads it back. Today `wrangler deploy` ships a working tree, which
is how this morning's eleven-minute outage shipped a duplicate declaration that
exists in no committed tree. *An owner gate does not fix this: Danny approved
that deploy, and approval is not verification.*

**7. Take chat out of the confirmation path.** — DANNY, owner gate
NEW to this list, though the fact is not new: confirm_proposal is a coordinator
tool and the coordinator is a chat session, so 627 proposals were prepared and
one has ever been confirmed. Danny ruled this morning that the dispatcher should
confirm. **That ruling is not in the decision ledger** and I was refused when I
tried to record it on his behalf, which is correct — it supersedes his own
earlier prepare/confirm split, so it needs his words. Nothing here proceeds
unattended until it is recorded.

**7b. Zero interactive prompts, as a hard acceptance test.** — ACCEPTANCE TEST BUILT
EVIDENCE: commit dd63625 added test/unattendedLoop.test.mjs
NEW, 2026-09-16, from a screenshot of a coding agent stopped on "Do you want to
proceed?" for a local commit. Not an AI problem and not a policy problem: the
policy in `permissionRequest.mjs` has classified `commit` as ROUTINE since it
was written. **Nothing translated an argv into that word**, so the policy was
never consulted and the decision fell to the executor's own permission system,
whose only vocabulary is a prompt. The gap was one translation wide.

Built: `preExecutionGuard.mjs` normalises a command to the action vocabulary the
existing classifier speaks and checks placement — worktree, branch, lease,
fence — independently of action class, so a generous class cannot pay for a bad
placement. `exec.mjs` now closes stdin (a reading child went from the full
timeout to 57ms) and reports a detected prompt even on a clean exit. The
pipeline refuses before it creates a workspace, returning `WAITING_APPROVAL`.

**Not built, and it is the half that finishes this:** the executor adapter must
launch Claude Code or Codex in a non-interactive permission mode scoped by
Bridge policy, and an agent that chooses commands as it goes needs the guard at
its own tool boundary rather than only at launch. Bridge grants the specific
safe classes; nothing gets a blanket allow.

*The acceptance test exists and passes* — `test/unattendedLoop.test.mjs`, run
against a real repository, a real child process and real git rather than mocks.
A task reads, edits, runs a check, stages and commits with nobody at a keyboard;
an agent that prompts fails in under fifteen seconds with `outcome:prompted`
instead of waiting out its lease. It found two shipped bugs on its first run,
including one of mine from an hour earlier: the `prompted` outcome could not
survive the executor adapter, and every unit test passed because they call an
adapter directly and never go through `execute`.

*Still open here:* launching the coding agent itself in a non-interactive
permission mode is built (`agentPermissions.mjs`, derived from the guard, never
a blanket grant) but has never been run against a real Claude Code or Codex
binary. That is the remaining half.

**8. T1 closes with nobody watching.**
A real task, leased, run, verified, reviewed, accepted, closed. Danny's windows
shut.

**9. T2 unlocks from T1 and closes.**
Dependency unlock already works at the scheduler level — proven today, when a
confirmed proposal assigned work without a human. The half after it is unproven.

---

## The self-correction ingest — absorbed 2026-09-16, NOT started

Danny handed over `agent_bridge_self_correction_oss_code_ingest_1.md` on the
evening of the 16th and asked whether it was in this map. It was not, and that
is recorded rather than quietly fixed: the pack is a roadmap, and a roadmap that
lives only in an upload is a roadmap nobody is working from.

Absorbed at `docs/SELF_CORRECTION_INGEST.md`, with every claim about what exists
measured against master rather than remembered. **It is a different axis from
`RELIABILITY_INGEST.md`** -- that one asks how work survives a crash, this one
asks how a wrong patch fails to become a trusted patch. They meet at the attempt
record and nowhere else, so neither substitutes for the other.

**The honest position: twelve modules already implement the shape under
different names**, so this is reconciliation, not greenfield. What does not exist
at all is the evidence layer: no `AttemptStep`, no `FailureClass`, no clean-SHA
verification, no `VerificationProof`. Nothing has been copied from any upstream
project yet -- verified by search -- and `THIRD_PARTY_CODE.md` now exists empty
so the first copy lands with its attribution instead of after it.

**SC1. One real attempt row.** — RESOLVED TO ITEM 2; not a separate task
I wrote this as "merged and unreached, or reached and failing silently, and
nobody has established which". Established 2026-09-17: **unreached.** `runAttempt`
is reachable only from `bin/agentbridge-attempt.mjs` and nothing spawns it, so no
code path in the running system can produce an attempt row. The writer is not
broken and needs no work. SC1 is therefore item 2 wearing a different name, and
listing it twice would have had two people converge on a database that was never
the problem.

**SC2. `AttemptStep` persistence, then `FailureClass`.** — after SC1
The trajectory, then the taxonomy. Section 4 of the pack begins with "classify",
so the repair loop cannot be written before the classes exist. Every failed
validation produces a typed failure artifact or the loop is reading prose.

**SC3. Clean-SHA verification and `VerificationProof`.** — independent of SC1
The one item worth pulling forward, because it is a live hole rather than a
missing feature. **Nothing in this repository does a fresh checkout of an exact
SHA and re-runs the suite.** `deployGate.mjs` checks that a commit was promoted
and asks the far end what it serves; it never establishes that the commit passes
from a clean tree. So `worktree passing != promotable` is currently unenforced,
and the sibling repo grew `check:clean-checkout` because that exact gap shipped a
route importing a module that was never committed.

**SC4 onward.** Agentless localization, the typed reviewer loop
(`ReviewFinding`, no plain "looks good"), Symphony reconciliation and bounded
concurrency, mechanical invariants whose lint text says how to fix them, the
`agentbridge inspect` surface, failure injection, and multi-candidate patches
last. Ordering and rationale in the ingest doc.

**Owner: the autonomous-loop lane.** Danny moved auto and dispatcher to code-a
on the evening of the 16th. This sits squarely in that lane and is code-a's to
sequence; it is written down here so it is sequenced by somebody rather than by
nobody.

## Then harden it — the ingest's Phase B

None of this is startable before 9, and all of it is cheaper than discovering
the same faults during a soak.

10. **Durable command envelope, inbox and outbox with ack states.** State change
    and outgoing command in one transaction. Closes: state changed but message
    lost; message delivered twice after a crash; response applied twice.
11. **Progress heartbeats, separate from process liveness.** A worker that is
    alive and making no progress is a distinct failure from a dead one, and one
    clock cannot report both.
12. **Bounded retries and poison quarantine.** A deterministic failure that
    repeats must stop, with a failure fingerprint, not retry forever.
13. **Reconciler.** Periodic idempotent repair of the states that should not
    exist: active task with no valid lease, result with no review request,
    accepted review with no task advance, production artifact differing from the
    deployment record. Every repair emits an event.
14. **Janitor.** Separate from the reconciler and never merged with it: expired
    sessions, stale worktrees, orphan processes. Unknown ownership quarantines,
    never deletes.
15. **Backpressure.** Caps per worker, per machine, per provider, per review
    pool. Overload pauses dispatch rather than spawning more executors.
16. **Version compatibility gate.** A worker declares its protocol and runtime
    versions; the scheduler refuses an incompatible assignment. Attempts pin
    their config so a deploy cannot change work already running.

---

## Then prove it — the ingest's Phase C

17. **The failure matrix, as executable tests rather than a table.** Forty-odd
    rows, each with detection, canonical state after, retryability,
    reconciliation key and machine evidence.
18. **Kill at every boundary.** A process kill after every arrow of the loop,
    then restart, asserting: exactly one canonical active attempt or none; no
    duplicate external effect; no lost runnable task; no stuck lease; dependent
    unlock at most once.
19. **Machine reboot, DB interruption, lost-response reconciliation, stale
    lease and fence races.**
20. **Twelve-hour closed-UI soak.**

**The line Danny drew, and it is the right one:** the base is closed when one
T1→T2 chain survives worker crash + daemon restart + reviewer crash + stale
lease + duplicate delivery + lost response after a side effect, and still
converges to one correct durable result with no chat open. Not before.

---

## Only after that

21. **Code-health metrics per attempt** — recorded only, no blocking gates.
22. ~~**`readCache` gets its consumer**~~ **DONE — 2026-09-16.** `contextCompiler.mjs`.
    The digest is of what was SENT, not of the files: an unchanged file travels
    as a reference, so identical files can be a different prompt, and hashing
    content would blind the loop detector in the one case it exists for. The
    pipeline computes the digest rather than accepting the caller's. Four known
    orphans left.
23. **Cache L0–L2 and prefix alignment** — the deterministic half only.
24. **Reviewer/fixer hardening** — stable finding ids, dedupe, re-review.
25. **Learning: scorer, then replay gate, then promotion.** Entry condition is
    accepted *and* rejected attempts in quantity.
26. **Operator console.** UI-1 on the read tools that already exist.
27. **Expert workforce.** The ingest is explicit and I agree: no dynamic expert
    creation before the base loop is proven.
28. **Performance engine.** Furthest out. Needs real workloads and a benchmark
    harness, neither of which exists.

---

## What reporting to a dead inbox looks like, since item 5 predicted it

Code-a sent five coordination messages today -- three to `code-b`, two to
`code-c`. Every one went to a session that was ALREADY OFFLINE: code-b last seen
17:19, code-c last seen 12:30, the earliest message at 17:43. Nobody read any of
them, and nothing told the sender.

`send_message` validates that `to_agent` is a KNOWN actor. It does not check
that it is a LIVE one, and `list_agents` was consulted once at the start of the
session rather than at each send. That is exactly item 5's "a message to a name
nobody reads is undetectable", and the twenty-nine it counts are now
thirty-four.

The cheap fix is not a new subsystem: it is for `send_message` to refuse, or at
minimum warn, when the recipient's last heartbeat is older than the staleness
window -- `offline` is already distinguished from `unknown`, and the sender is
simply never told which one it got. Until then, anything that matters goes in
the commit or in this file, not in an inbox.

## Not on the list

`runtime.mjs` deletion, `auditRange.mjs`'s caller and the 58-commit merge in the
other repository are all assigned and real, and none is on the critical path.
They proceed in parallel and gate nothing above.

## What the ingest says not to do, and I agree with all of it

No second durable store beside Postgres. No broker in v1. Agent chat is not the
workflow engine. The UI is never authoritative. Retry semantics never live only
in a prompt. Workers never own canonical task state. And nothing bolts a
capability on before item 9.
