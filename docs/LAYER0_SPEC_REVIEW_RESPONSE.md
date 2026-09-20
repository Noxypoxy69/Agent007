# Response to the six-point review of the Layer 0 spec

Written from Agent007 as it actually behaves on 2026-09-20, not from the spec.
Where a point is confirmed by something measured here, the measurement is
attached — because several of these are not hypothetical on this machine, they
are defects we have already shipped and found.

**Verdict: 5 of 6 accepted as written, 1 accepted with a caveat that matters,
and 5 additions the review does not cover — one of which is the reason the
whole loop is idle today.**

---

## 1. P0-A identity — ACCEPTED, and stronger than stated

`sha256(C:\foo\worktree)` is not an allocation. Agreed, and the reasoning
generalises: **it derives identity from something the actor controls.** That is
the exact defect a blind audit found here three hours ago.

> `identity_source: CREDENTIAL` is set from `process.env.AGENTBRIDGE_PRINCIPAL_ID`,
> and `claimed_by_source: 'resolved'` from `AGENTBRIDGE_SESSION_ID`. Nothing
> verifies either. **An author produces a fully `enforced`, gate-satisfying
> self-audit by exporting two environment variables and choosing two different
> strings.**

The code's own comment claimed authorship was bound "from the active
authenticated session, which is a thing the author does not get to type." It is
exactly a thing the author types. So `bound_worktree_id` as a hash of a known
path is the same bug with a hash in front of it.

**`principal_id ≠ agent_id ≠ session_id` — accepted, and we have the scar.**
An audit found the claimant and author identifiers drawn from *different
namespaces*: `AGENTBRIDGE_AGENT_ID` is `code-b`, while the author identifier is
a `session_…` string. The "author cannot audit their own work" check compared
the two — so it could never be true for any input, **and the record labelled
that `claimed_by_source: 'resolved'`, the stronger of the two provenance
markers.** A guard that cannot fire, reporting high confidence.

**The addition this point needs:** the review asks "where does `verifierKey`
come from" and then moves on. That question is the whole spec. On this machine
agents can write every file and set every environment variable, so the trust
root cannot be a file, a variable, a commit trailer, or a secret on this disk —
we enumerated and rejected each. What survives is a signature from a key the
agents never hold, or a record written through a channel they cannot write.
Both require the owner. **A spec that says "verify the signature" without
saying where the key lives has moved the problem, not solved it.**

---

## 2. P0-B manufactured heartbeat — ACCEPTED, and this one already bit us twice

`last_heartbeat_ms: Date.now()` at spawn is the parent asserting the child
proved life. Accepted without reservation. `STARTING / last_heartbeat_ms = null /
positive_cycle = false`, and only the watcher may write the first nonce-matching
cycle.

Measured here, and it is the reason this repository has a rule about it:

> Two poll logs on this machine, both 0 bytes, no supervisor process alive for
> either, one agent silent 4884s and another 22976s. **A dead watcher and a
> working one produced byte-identical evidence** — an empty log and a
> `startedAt` from hours ago.

**The PID-reuse objection is also confirmed, not theoretical.** A blind audit of
a commit here found precisely it:

> `sessionEnd` used `alive(rec.pid) !== false`, so a pid we could not identify
> was SIGTERMed. On Windows that is `TerminateProcess` — no handler, no veto.
> Demonstrated with a live non-node victim whose pid sat in a stale poll
> record: parent commit `ping.exe STILL-RUNNING`; the commit under audit
> `EXITED code=1`.

So `UNKNOWN → no spawn, no kill` is right.

**The addition:** the review says terminate only after *positive identity
proof*, without saying what happens when that proof is unobtainable. Here it
often is — a guarded session cannot read the process table at all
(`Get-Process` and `Get-CimInstance` are both refused by our own rail). So
`UNKNOWN` is not a rare branch, it is the **common** one for the component that
needs it most. And `UNKNOWN → do nothing` forever is a livelock: a stuck
watcher is never cleared and nothing says so. **`UNKNOWN` must be
owner-visible and time-bounded, not silent.** See addition E.

---

## 3. P0-C session latch — ACCEPTED, with one caveat that has cost us a control before

Agreed that per-tool matching against `targetSubsystems` / `targetFiles` is
unknowable before exploration, and that a session latch is the right shape.

**The caveat: a latch that blocks repository *reads* is an outage risk, and an
outage is how a control gets switched off entirely.** Our rail has already done
this: a version that default-denied unrecognised tool names refused 25 of a
real 54-tool roster, and the lesson written down was that *"an outage gets the
hook switched off, which loses every layer at once."*

A worker that cannot read anything until reconciliation succeeds will, the first
time reconciliation is wrong, produce an agent that can do nothing — and the
operator will disable the latch, not debug it. Recommend the latch **blocks
writes and claims, and permits reads**, plus the metadata allow-list as
specified. Reads are not the thing that collides; writes are. The stated goal —
"only after a valid outcome does repo exploration unlock" — buys little and
risks the whole layer.

Accepted: `read task` does not satisfy preflight.

---

## 4. `task_attempts`, not timestamps on `tasks` — ACCEPTED, and it is the strongest point here

No reservation. Attempt-7 timestamps misclassifying attempt 8 is the same class
as every stale-fence defect we have shipped.

**Confirmed against live data.** Our task table right now shows rows at
`attempt: 2` with `assigned_agent: null`, `assigned_at: null`,
`lease_token: null` — the attempt counter has advanced twice while every
per-attempt field on the row is null, because the reaper returned the work and
nothing cleared or versioned the rest. The data model is already confused in
exactly the way predicted.

The fencing shape `WHERE task_id = ? AND attempt = ? AND lease_token = ?` is
what `return_with_lease` already does here and it is correct.

**The missing state named in the review is real** — `leased`, `acknowledged_at
!= null`, `execution_started_at == null`, lease expired — and a related defect
was found here by audit: a terminal-write fence that *compares the stored record
against itself*, because nothing re-measures at write time. A fence whose two
sides come from the same row catches a typo, not a race.

---

## 5. P0-E choose a compatible pair, not a seat — ACCEPTED

`eligible_seat LIMIT 1 CROSS JOIN eligible_task` selecting `code-a`, finding it
has no eligible task, and returning nothing while `code-b` has ten is a real
starvation bug. Selecting and locking a **pair** is correct.

Agreed that `capabilities`, dependency closure, WIP, role eligibility, collision
ownership, reserved scopes and reviewer independence belong in the eligibility
predicate rather than in dispatcher memory. Reviewer independence in particular
must be *in the predicate*: we have measured what happens when it is etiquette —
an author cleared its own work on six commits before anyone noticed.

---

## 6. Acceptance test #5 — ACCEPTED

The four-way split is right, and the distinction is not academic: "the worker
died" and "the work is bad" drive different retries, and collapsing them is how
a retry counter learns nothing. Agreed that none of these advance the fencing
epoch during reconciliation, and that the next atomic claim does.

---

# What the review does not cover

## A. THE IDLE QUEUE IS THE FAILURE, NOT THE SUCCESS CASE

The review ends by celebrating:

> 16 runnable tasks / 0 eligible pairs / 0 mutations / queue waits.
> *"That is the behavior you originally wanted."*

**That is this machine, today, and it has been for days — and it is not a good
outcome.** Measured this session: 16 runnable tasks, every one with
`assigned_agent: null` and `lease_token: null`; 17 roster rows, all `offline`;
last successful dispatch 2026-09-17.

And sitting unassigned in that queue, filed 2026-09-18:

- *"Rule 20 isolation is unexecutable: the rail forbids AGENTBRIDGE_HOME redirection"*
- *"An auditor cannot check out test/ into an empty worktree"*
- *"Blind audit of the eight unaudited guard commits"*

Three independent blind auditors rediscovered the first of those today and
reported it as a finding. **We spent roughly 670,000 tokens relearning something
the queue already knew.** The dispatcher was behaving exactly as specified.

So: correct quiescence and total stall are **indistinguishable** in this design.
The spec needs a liveness assertion of its own:

```
zero eligible pairs AND zero live seats AND queue non-empty AND age > threshold
  → this is not quiescence, it is a stall. Say so, loudly, to the owner.
```

Silence is the one output that must never mean two different things. That is the
same rule as P0-B's heartbeat, one level up.

## B. "NO ELIGIBLE PAIR" MUST BE DISTINGUISHABLE FROM "ELIGIBILITY UNKNOWN"

Every predicate in P0-E depends on liveness being *known*. When the roster is
wrong — and ours is: all 17 seats read `offline` while two agents were
demonstrably committing — the dispatcher correctly computes zero pairs from
false inputs, and the output is identical to a healthy idle queue.

The dispatcher's result should carry whether its inputs were measured. We
adopted exactly this in a gate here after hitting it: the verdict carries
`measured: false`, and a test asserts that a healthy subject and an unmonitored
one produce **different explanations**. Without that, an unwired control is
unfalsifiable.

## C. EVERY ITEM NEEDS A WIRING TEST, SEPARATE FROM ITS LOGIC TEST

The six acceptance tests all test *decisions*. None asserts that anything
**calls** them. This repository has shipped at least five functions that were
correct, tested, and invoked by nothing — including, this week, an audit-record
path that is unreachable dead code because an inner dispatch branch encloses it,
and a `mergeQueue` that silently erases the very fields its consumer requires,
so the write path could never succeed. Both had green unit tests.

For each of P0-A…P0-E the acceptance criteria should include: *name the
production caller, and show a mutation of the call site turning a named
assertion red.* A decision nothing consults is not a control.

## D. THE SPEC SHOULD SAY WHAT IS NOT YET OBTAINABLE

P0-A as written cannot be satisfied today by anything on this machine, because
no trust root exists. That is fine — but it should be stated, so the
implementation reports `UNREGISTERED` honestly rather than someone wiring
`process.env` to make the tests pass. That is precisely how the current hole
got here: the comment asserted authenticated binding while the code read an
environment variable.

Recommend an explicit `ANCHOR_ABSENT` state that is *not* an error and *not*
authenticated, so the gap is visible in the data rather than papered over.

## E. UNKNOWN MUST BE TIME-BOUNDED

Following from point 2: `UNKNOWN → no spawn, no kill` is correct and, left
alone, is a permanent stall wearing a safe-looking verdict. It needs an age, and
past that age it becomes an owner-facing alarm. The same applies to a `STALLED`
watcher that non-destructive reconciliation cannot clear.

---

# Bottom line

The two the review says not to compromise on — per-attempt lifecycle in
`task_attempts`, and atomic compatible-pair selection — are the right two, and
both are confirmed by defects already present here.

The one I would add to that list: **a stalled queue must not look like a healthy
one.** Everything else in this spec is a correctness property; that one is the
difference between a system that is idle and a system that is dead, and today we
could not tell them apart.
