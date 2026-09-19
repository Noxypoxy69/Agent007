# The `io.records` store — contract for the durable per-attempt write

Status: **not built.** `io.records.start/finish` are called only in
`src/attemptPipeline.mjs`; no runner supplies a store, so per-attempt persistence
is unwired end to end. This is the contract a can-run (worktree-capable) session
implements and proves; a guarded session cannot run an attempt (`git worktree add`
is refused) so it cannot perform the #17 demo.

## What exists already (do not rebuild)
- `src/attemptRecord.mjs` — builds and validates the row (`startAttempt`,
  `finishAttempt`, `crashAttempt`). It is the SINGLE authority; the store persists
  its rows, it does not define a second record or a `status` column.
- The row now carries the four provider token dimensions + `usageObserved` +
  `usageSource` (commit `a1e6e2d`), and `runAttempt` binds the aggregate into
  `finishAttempt`. So a finished row already has tokens (when usage was observed).
- `src/leases.mjs` owns lease/fence semantics (`leaseState`, `canReturnWithLease`,
  `shouldActOnEvent`). The store MUST reuse these, not re-derive them — a second
  implementation of lease semantics is the one nobody watches when they disagree.

## What the store must do
1. **`start(row)`** — persist the started row durably before work begins. The
   start write is safe: the lease that authorised the claim is the newest thing in
   the room (see the `attemptRecord.mjs` header).
2. **`finish(row)`** — the FENCED terminal write. Authorise it with the CURRENT
   claim: reuse the Package 0 fence (task, attempt, lease token, assigned session,
   expected state). A stalled worker whose lease expired or was superseded MUST NOT
   be able to write the terminal result. Do not implement a second fence; call the
   existing one. Refuse a stale write; do not silently drop it.
3. **All terminal states persist** — accepted, machine-rejected, review
   fix-required, crash, timeout, refusal, abandoned. Failure cost is the learning
   signal; a store that writes only on success loses exactly the attempts that
   teach.
4. **Idempotent** — replaying a write must not double-count. Stable identity:
   `task_id + attempt` for the row; `task_id + attempt + usage_event_id` if usage
   events are ingested separately. The `tokenTelemetry` ledger is already
   idempotent within an attempt (event id); the STORE needs the same at its write.
5. **Descriptive, never an authority gate** — nothing reads token cost to gate
   correctness, security or review.

## Where it persists — OPEN DECISION for the owner
`docs/LEDGER_MAP.md` names `agentbridge.attempts` (hosted table, "0 rows"). If the
store writes there, `finish` is a hosted write through the edge function and needs a
deploy (owner) + live DB to prove — a guarded session cannot build or demonstrate
that. If instead it is a local append store (like `provenanceStore`'s JSON ledgers
under `~/.agentbridge/`), a guarded session can build and unit-test the persistence
+ fence against a temp dir, and the hosted projection follows. **Decide which before
implementing**, because it changes who can build and prove it.

## Proof obligations (ruling §17, needs a can-run session)
A real attempt flowing end to end: task claimed, attempt row created, provider
usage captured into `io.usage`, candidate committed, measurement persisted
automatically, terminal write accepted ONLY under the valid fence, replay does not
double-count, and unrelated work in the same session does not leak into the attempt
total. Backfill and a synthetic `io.usage` do not satisfy this.
