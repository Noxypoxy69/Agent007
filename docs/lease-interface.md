# The lease interface — the seam between the worker runtime (B) and the task authority (C)

**Status: PROPOSED BY ONE SIDE. Not agreed.**
Written by code-c against the applied schema at migrations `20260915220139`,
`20260915220223`, `20260915220344`. code-b has not seen it.

A lease interface agreed by one side is a guess. This document exists so that B
can disagree with something specific rather than infer the contract from my
source, and every section below is a claim B is invited to reject.

---

## What each side owns

| | |
|---|---|
| **B — local supervised worker runtime** | crash and reboot recovery, registration, heartbeat, capacity, job pickup, isolated worktree lifecycle, running a fresh non-interactive coding agent, capturing a structured result, fenced submission, cleanup |
| **C — Postgres authority** | the task rows, atomic claims, lease expiry, fencing tokens, dependency and collision checks, the reviewer queue, retry and escalation, the outbox |

**Bridge state is authoritative.** A resumed model session is optional context,
never a source of truth about what work exists or who holds it.

---

## The five calls

All are `SECURITY DEFINER` functions granted to `service_role` only. B reaches
them through the data plane, never by connecting to Postgres directly.

### 1. Claim

```
claim_task(p_task_id, p_agent_id, p_session_id, p_by, p_lease_seconds default 900)
  -> { ok: true,  task_id, lease_token, lease_expires_at, attempt }
  -> { ok: false, reason: not-claimable | leased | state | dependency, detail }
  -> { ok: false, reason: "<a whole sentence>" }        <- NO detail. see below.
```

`lease_token` is a **fencing token**, minted fresh on every claim. It is the
only credential that matters for everything B does with this task afterwards.

**`reason: "not-claimable"` means "you did not get it", and that is
deliberate.** It covers both "no such task" and "another transaction holds it
right now" — because retrying is the correct response to both, and telling them
apart would only invite B to branch on a distinction that does not change what
it should do.

> #### ⚠ THREE PLACES THIS DOCUMENT DESCRIBED BEHAVIOUR THAT DOES NOT EXIST
>
> Found by c8 and code-d reading the shipped SQL against this file; the third is
> mine and neither of them reached it. Corrected above and recorded here rather
> than quietly edited away, because **a worker built to the old text would have
> mis-handled its own retry** and the next person needs to know which way the
> correction went.
>
> **1. There is no `renewal` key.** This file said a same-session re-claim
> "is a renewal, returns `renewal: true`, and does not increment `attempt`".
> The string `renewal` appears **zero times** in `claim_task`. A worker
> checking for it reads `undefined` forever.
>
> **2. There is a FIFTH reason, and it is not a slug.** The `p_lease_seconds`
> bounds check returns the whole sentence `"lease_seconds must be between 30
> and 86400"` as `reason`, with **no `detail`**. Anything matching `reason`
> against a slug list mis-handles it. `rpcRefusal` does not assume
> slug-plus-detail; don't write something that does.
>
> **3. A SAME-SESSION RE-CLAIM IS REFUSED, NOT RENEWED — and this is the one
> that bites.** A successful claim writes `state = 'assigned'`. A re-claim by
> that same session then skips the `leased` refusal (the
> `assigned_session is distinct from p_session_id` clause is false) and falls
> straight into the state check, which refuses `assigned`. So it comes back
> `reason: 'state'`.
>
> That matters because **losing the response to `claim_task` is the ordinary
> case, not the exotic one** — a dropped connection, a timeout, a restart. This
> file promised such a worker a free renewal. It gets a refusal that reads like
> somebody else took the work.
>
> `src/leases.mjs` agrees with the SQL here: `canClaim` on an assigned row
> refuses with the same state message, whoever asks. The two implementations
> are consistent. It is only this document, and `PROOF 2b` in
> `test/leases.test.mjs`, that described the renewal behaviour — and that proof
> could not have caught the drift, because its fixture builds the row as
> `runnable` with an `assigned_session`, a shape a real claim never produces.
> Same defect as the expired-lease proof fixed in `66ef896`.
>
> **THE DESIGN QUESTION IS STILL OPEN AND IS NOT MINE TO CLOSE.** The original
> intent — "a worker retrying after a lost response is not a second claimer;
> refusing it strands the work until the lease expires, for no safety gained" —
> is good, and the SQL does not implement it. Whether to add a same-session
> renewal branch to `claim_task` or to tell workers to use `renew_lease` and
> nothing else is a decision for Danny and code-b, not a thing to patch in
> while correcting a document. **Until it is decided, the shipped behaviour is
> the refusal**, and that is what is written above.

Prefer `renew_lease` for renewals. It is one round trip instead of a full
re-validation, and per item 3 it is currently the **only** thing that renews.

### 2. Renew

```
renew_lease(p_task_id, p_lease_token, p_lease_seconds default 900)
  -> { ok: true,  lease_expires_at }
  -> { ok: false, reason: "lease-not-current" }
```

Compare-and-set on the token.

**`ok: false` here means STOP WORKING.** Not "retry", not "renew harder". It
means the token is wrong or the lease already expired, and in the second case
the task may already belong to somebody else. A B that keeps working after a
failed renewal is the zombie this whole design exists to catch, and it will be
refused at submission — after it has spent the time.

**Renew at one third of the lease.** With the 900s default that is every 300s.
Renewing at the last moment means one slow round trip loses the lease.

### 3. Submit

```
return_with_lease(p_task_id, p_lease_token, p_head_sha, p_notes default null)
  -> { ok: true,  task_id, state: "returned" }
  -> { ok: false, reason: head-sha | no-such-task | stale-lease | lease-expired | state }
```

`p_head_sha` must be a full 40-character sha, **resolved through git and never
typed**. "Done" with no commit is a claim nobody can check.

The lease is **consumed** by a successful return, so the same token cannot
submit twice.

**`stale-lease` is not a retryable error.** It means the work was re-assigned
while B held it. B should discard the result and re-claim if it still wants the
work — submitting again with a new token would be submitting work done against
a premise that has since changed.

### 4. Review (not B's, listed so B does not implement it by accident)

```
claim_review(p_task_id, p_reviewer_session, p_lease_seconds default 1800)
renew_review_lease(p_task_id, p_review_token, p_lease_seconds default 1800)
```

Reviews are leased separately from work. The review lease is released
automatically by a trigger when the task leaves `returned`, including rework
back to `runnable`.

### 5. Reconciliation (nobody calls these; they are swept)

```
expire_dead_leases()    -- state='assigned', lease expired -> back to runnable
expire_dead_reviews()   -- state='returned', review expired -> waiting again
```

These are why B does **not** need to clean up after a crash. A B that dies
holding a lease costs exactly one lease duration, automatically. **B must not
attempt to release its own lease on shutdown** — a crash is the case that
matters and a clean shutdown path does not help it. Let it expire.

---

## The three rules that are not about any single call

### Delivery is at-least-once. Never trust an event body.

The outbox row is written **in the same transaction** as the claim, so an event
is never lost — and is therefore sometimes delivered twice, late, or out of
order. Every consumer must re-read the task and compare `lease_token` against
the event's. The rule is written once, in `src/leases.mjs::shouldActOnEvent`,
and B should call it rather than re-derive it: two copies of that rule would
eventually disagree and the disagreement would be silent.

### The token is the identity, not the session id.

A session id is stable, so it survives a crash — which is exactly what makes it
useless here. A worker that died and came back under the same session id must be
identifiable as **late**. Only a per-claim random token does that.

### Execution must not depend on a persistent chat session.

Everything B needs to resume is in the rows: which task, which token, when the
lease expires, which attempt this is. After a reboot B should re-read, not
remember.

---

## Open questions for B — where I expect to be wrong

1. **Is 900s the right default lease?** I picked it for "real work, and a death
   costs one lease". If a typical job is longer, the default should move rather
   than every caller passing an override.

2. **`attempt` counts claims, not failures.** A worker that claims, crashes
   before doing anything, and is swept has burned an attempt. At `RETRY_LIMIT`
   3 that is three crashes to escalation. Should a crash-before-progress count?
   I think yes — three crashes IS a finding — but B sees the crash and I do not.

3. **Who writes the structured result?** `return_with_lease` takes a sha and
   free-text notes. If B captures structured output, notes is the wrong shape
   and this needs a column rather than prose.

4. **Does B want a claim-next call?** Right now B must know a `task_id` before
   claiming. A `claim_next(agent_id, session_id, lane_id)` that atomically picks
   and claims is easy to add and removes a round trip — but it moves the
   choice of *which* task into the database, which is a real design decision
   and not mine alone.

5. **What does B do on `not-claimable`?** Retry with backoff, or report and
   wait for a wake-up? Both are defensible; the answer determines whether the
   database sees a poll loop.

---

## What is not proven

The contention behaviour — two workers racing one row, and `FOR UPDATE SKIP
LOCKED` skipping rather than blocking — **is not demonstrated**. The mechanism
exists and its shape is independently verified; its behaviour under concurrency
is not. code-d owns that proof and it is pending the owner's authorisation.

Until then, B should implement against this contract but nobody should report
the race as closed.
