# The order

One list. Everything else queued behind it. `BACKLOG.md`,
`AMENDMENT_MATRIX.md` and `CONSOLE_UI0.md` are reference material for items
7 and later — not work.

**The only milestone that counts:** one task goes queued → leased → coded →
machine-verified → independently reviewed → accepted → closed, with nobody
watching. Then a second one unlocks from the first and does the same.

---

## Blocking the loop

**0. Deploy the edge function.** — DANNY, and only Danny
`/task`, `/renew` and the permission path are committed and undeployed. Reported
by code-c at 04:53: *"until they ship a worker cannot read its task, cannot renew,
and cannot close the loop."* Every item below is downstream of this. It is an
owner gate by the repository's own rules and nobody else may clear it.

*This was not step one on the first version of this list, and it should have
been. The first version had merging at the top, which is wrong: a worker cannot
close the loop from master either, if the routes it needs answer nothing.*

**1. Merge the two ready branches to master.** — code-c
`work/recover-orphan-branches` then `work/support-modules`. Both green.
Nothing below can start until the pipeline is on master, because the worker
cannot call what is on a branch. *This is first and it is nobody's favourite
task, which is exactly why it gets skipped.*

**2. Wire the lease to the pipeline.** — code-c *(assigned)*
claim → `runAttempt` → return. The daemon owns the lease, never the process it
starts. `bin/agentbridge-attempt.mjs` is a working caller of everything except
those three verbs.
**Open question only code-c can answer:** does a returned envelope satisfy the
existing return path, or does it need a field that path does not carry?

**3. A reviewer runtime.** — code-c
The review lease exists in SQL; nothing claims it. Needs a runner that claims a
review lease, builds the packet, runs a reviewer, records accept or reject.
Reviewer may not mutate code; a fixer may not resolve its own finding.
Without this, step 5 is "machine-verified" and not "independently reviewed".

**4. Persist the attempt record.** — b6 *(assigned)*
Must land before step 5 runs, or the first real attempts are unrecorded and
unrecoverable. Routing identity — engine, model, role profile, worker slot,
lease, fence — plus both verdicts stored separately. Nothing reads it.
*Small, and it is what four separate specs are waiting on.*

**5. T1 closes with nobody watching.**
A real task, leased, run, verified, reviewed, accepted, closed. Danny's windows
shut.

**6. T2 unlocks from T1 and closes.**
Dependency unlock already works at the scheduler level — that was proven today,
when a confirmed proposal assigned work without a human. What is unproven is the
half after it.

---

## After the loop closes, in this order

7. **Code-health metrics per attempt** — recorded only, no blocking gates.
8. **`readCache` gets its consumer** — the context compiler. It is built, tested and unused.
9. **Cache L0–L2 and prefix alignment** — the deterministic half only. Agent attempts are never cacheable by derivation identity.
10. **Reviewer/fixer hardening** — stable finding IDs, dedupe, re-review, separate workspaces.
11. **Learning: scorer, then replay gate, then promotion.** Entry condition is accepted *and* rejected attempts in quantity.
12. **Operator console.** UI-1 on the read tools that already exist. Six of its pages need item 4.
13. **Performance engine.** Furthest out. Needs real workloads and a benchmark harness, neither of which exists.

---

## Not on the list

`runtime.mjs` deletion, `auditRange.mjs`'s caller, the message guard, and the
58-commit merge in the other repository are all assigned and real, and none of
them is on the critical path. They proceed in parallel and do not gate anything
above.
