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

**0. Deploy the edge function.** — DANNY, and only Danny
`/task`, `/renew` and the permission path are committed and undeployed. Reported
by code-c at 04:53: *"until they ship a worker cannot read its task, cannot renew,
and cannot close the loop."* Every item below is downstream of this. It is an
owner gate by the repository's own rules and nobody else may clear it.

**1. Merge the two ready branches to master.** — code-c *(assigned)*
`work/recover-orphan-branches` then `work/support-modules`. Both green.
Nothing below can start until the pipeline is on master, because the worker
cannot call what is on a branch. *This is first and it is nobody's favourite
task, which is exactly why it gets skipped.*

**2. Wire the lease to the pipeline.** — code-c *(assigned)*
claim → `runAttempt` → return. The daemon owns the lease, never the process it
starts. `bin/agentbridge-attempt.mjs` is a working caller of everything except
those three verbs.

**3. Persist the attempt record.** — b6 *(assigned)*
Must land before step 7 runs, or the first real attempts are unrecorded and
unrecoverable. Routing identity — engine, model, role profile, worker slot,
lease, fence — plus all three verdicts stored separately: what the agent
claimed, what the machine verified, what the reviewer decided. Never one
`status` column. *Small, and four separate specs bottom out on it.*

**4. A reviewer runtime.** — code-c
The review lease exists in SQL; nothing claims it. Needs a runner that claims a
review lease, builds the packet, runs a reviewer in a FRESH workspace, records
accept / fix-required / reject. Reviewer may not mutate code; a fixer may not
resolve its own finding; `FIX_REQUIRED` creates a separate task, not a retry
inside the same attempt. Without this, step 7 is "machine-verified" and not
"independently reviewed".

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

**7b. Zero interactive prompts, as a hard acceptance test.** — partly built
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

*The acceptance test, and it is pass/fail:* start an unattended task that reads
files, edits files, runs tests, stages and commits, and submits a result. Close
the UI. **Zero interactive prompts.** One prompt fails the run as
`INTERACTIVE_PROMPT_DETECTED`.

**8. T1 closes with nobody watching.**
A real task, leased, run, verified, reviewed, accepted, closed. Danny's windows
shut.

**9. T2 unlocks from T1 and closes.**
Dependency unlock already works at the scheduler level — proven today, when a
confirmed proposal assigned work without a human. The half after it is unproven.

---

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
22. **`readCache` gets its consumer** — the context compiler. Built, tested, unused.
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

## Not on the list

`runtime.mjs` deletion, `auditRange.mjs`'s caller and the 58-commit merge in the
other repository are all assigned and real, and none is on the critical path.
They proceed in parallel and gate nothing above.

## What the ingest says not to do, and I agree with all of it

No second durable store beside Postgres. No broker in v1. Agent chat is not the
workflow engine. The UI is never authoritative. Retry semantics never live only
in a prompt. Workers never own canonical task state. And nothing bolts a
capability on before item 9.
