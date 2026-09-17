# Agent Bridge — the roadmap

## 2026-09-17. The decision, the architecture, and the order to build it in.

**Read this first if you are implementing.** It is a PLAN, not a status
document. It records decisions, contracts and order. It deliberately contains no
current-state facts — counts, deployed versions, who is online — because those
rot, and twelve documents in this repository already rotted that way. For state,
run the commands; for evidence of what is broken, see `docs/LEDGER_MAP.md`.

---

## 0. The ruling, superseding an earlier decision, with both positions kept

**OWNER RULING — 2026-09-17.** Order:

```
1  identity / per-session credentials
2  stop review-proposal churn
3  fenced attempt persistence, and runAttempt integrated AFTER one real Loop B proof
4  durable inbox receipts / acknowledgements
5  completion fingerprint
```

**This supersedes an earlier owner decision of comms-first, made hours before,
and that decision is recorded here rather than erased.** An implementer reading
a plan that has changed direction deserves to know it changed and why.

### The measurements that moved it

| | |
|---|---|
| outbox rows undelivered | **0** |
| messages moved | 178, across 12 recipients |
| review proposals with no consumer | **~48/hour, ongoing** |
| production attempt records | **0** |
| registration credential | **shared — one session can name another** |

### Position A — comms first (the earlier decision)

Agents cannot coordinate a multi-lane repair if a message can be accepted under
a free-text alias with no proof the intended agent received it. Rebuilding the
ledger while coordination is unaccountable risks a third round of duplicated
work.

### Position B — measured order (the ruling)

Delivery is not the binding constraint. Neither of the two duplications that
triggered this work was a comms failure: one fix sat on `master` for 65 minutes
and the other on a pushed branch for nine, both discoverable by anyone who
looked. When messages were sent to offline agents the Bridge *refused to claim
delivery* — the system telling the truth. Meanwhile review proposals accumulate
with no consumer and production work executes with no attempt record.

### What the ruling explicitly does NOT say

**It does not declare messaging finished.** Zero undelivered proves delivery
works; it proves nothing about acknowledgement. **Comms delivery is presently
adequate; comms accountability remains unfinished** and is slice 4, not
abandoned. The identity half moves to first on its own merit — a shared
credential is an authorization hole regardless of sequencing.

### Standing constraints, carried by the ruling

* **Messages are prose and never execution authority.** Preserve this property
  through the rebuild; it is already true.
* **No unattended production workers.** Nothing launches until its phase has a
  measured end-to-end proof.

*Recorded by c8, who argued Position B. That is precisely why both positions and
the numbers are written here: a ruling that matches the recorder's own argument
is the one most worth making auditable.*

## 1. What this architecture is for

Three seams are broken. Everything below serves one of them.

```
EXECUTION   the production worker must use the guarded attempt pipeline
REVIEW      returned work must reach an independent reviewer that exists
COMPLETION  accepted and integrated work must be recorded, and CHECKED
            before equivalent work is proposed or run again
```

**Without the third, a correctly guarded runtime would safely duplicate the same
work.** That sentence is the reason this roadmap exists.

Comms is not a fourth seam. It is the coordination substrate the three repairs
are carried out over, which is the argument that put it first.

---

## 2. Rules that bind every slice below

These are not style. Each was paid for.

1. **No second source of truth.** Adding a store that shadows an existing one is
   the failure this whole roadmap is repairing. The ledger already has eight
   places that record what happened; a ninth makes it worse.
2. **Comms carry coordination, never authority.** A message body is prose to be
   READ. It is never executed. Tasks, leases and fence tokens remain the only
   execution authority. *This is already true of the Bridge and must survive the
   rebuild — it is a property to preserve, not a requirement to add.*
3. **Absent is not zero.** A null count means unknown. A failed lookup is not an
   absence of results. This has caused four separate wrong conclusions here.
4. **Identity is derived from a credential, never asserted by the caller.** Any
   endpoint that trusts `from_agent` in the request body is forgeable.
5. **Prove success AND refusal.** A gate that only refuses is an outage; one
   that only permits is decoration.
6. **Watch every gate fail.** Mutate to the real regression, confirm red, then
   green. Three gates in this repository passed while proving nothing, and two
   of the tests written for THIS roadmap's tooling were hollow on first draft
   and caught only by running the mutation.
7. **A count read off the wrong instrument is not a measurement.** Two file
   counts handed to an outside reviewer were off by one because they were
   grepped from a tar listing that counts directory entries.
8. **Do not launch unattended production workers** until the execution seam
   closes. Standing, agreed by all parties.

---

## 3. Donor patterns — already researched, do not redo

Two ingest packs are already absorbed in this repository. **An outside review
independently re-derived seven of seven of the same sources**, and the two
breaks it presented as findings are §17 and §18 of a document written nineteen
hours earlier. Read these before proposing sources:

| Document | Covers |
|---|---|
| `docs/RELIABILITY_INGEST.md` | Temporal, DBOS, Restate, NATS JetStream, pg-boss, Hatchet, Trigger.dev, LangGraph, MS Agent Framework, SWE-agent. **§17 is the attempt schema field by field. §18 is the reviewer runtime.** |
| `docs/SELF_CORRECTION_INGEST.md` | mini-SWE-agent, SWE-ReX, OpenHands (MIT core), Agentless, Self-Refine, Symphony, AlphaEvolve, RepairAgent |

Added by the later review, and genuinely new:

| Donor | Take | Do not take |
|---|---|---|
| **Beads** | one shared readiness predicate for list AND claim; atomic claim/CAS; idempotent same-actor reclaim; dependency-cycle rejection; fenced release; scoped expired-lease recovery | its caller-asserted actor identity — ours must be credential-derived |
| **pg-boss** | partial unique indexes as queue policy; retry accounting and backoff; heartbeat expiry; dead-letter; `LISTEN/NOTIFY` as a doorbell over a durable row | its separate job schema and dashboard |
| **Gas Town** | terminal-boundary notification delivery; TTL, priority, FIFO; atomic claim; orphan recovery | its in-memory deduper (vanishes on restart) and filesystem queues |

**MCP Agent Mail (Rust) is EXCLUDED — do not clone, read or analyse it.** Its
licence rider prohibits use and analysis by OpenAI and Anthropic models, and
every agent working here is one. Recorded in `THIRD_PARTY_CODE.md`. Inboxes and
receipts may be implemented independently from requirements; that codebase may
not be read.

---

## 4. Slice 1 — Identity foundation

**Why first even under the objection:** it is an authorization hole. The
registration token is shared, so any worker can name another agent's session.

### Tables

```
agents            agent_id, kind (permanent|disposable), display_name,
                  status (active|retired|terminated), created_at, retired_at,
                  parent_agent_id

agent_aliases     alias, canonical_agent_id
                  — resolves HISTORICAL messages only.
                  — an alias may never authenticate or send.

sessions          session_id, agent_id, machine_id,
                  client_kind (terminal|desktop|cli|spawned_worker),
                  started_at, heartbeat_at, ended_at, capacity,
                  repo_id, worktree_id, head_sha,
                  credential_digest, revoked_at
```

`code-a` survives session replacement. A session id is not an alternate sender
identity — that conflation is why the roster and the message log key on
different things and cannot be joined.

### Credentials

```
bootstrap credential  → may ONLY register
registration         → mints one random per-session credential
store                → digest only, never the value
every route          → derives agent_id + session_id FROM the credential
revocation           → on session end, retirement or supersession
disposable worker    → credential bound to one task_id + attempt_id
```

### Acceptance — both directions

* a valid credential resolves to exactly one agent and session;
* a caller naming a different session in the body is REFUSED, not trusted;
* a revoked credential is refused;
* an alias resolves for reading history and is refused for sending;
* an unknown agent is refused;
* two sessions of one agent both resolve, and neither can act as the other.

### Migration safety

Backfill the four real agents and map historical aliases (`b6`, `c8`,
`chatgpt-work`, and the retired coordinator names). **Leave `send_message` and
`list_messages` working through a compatibility layer.** Do not remove the old
path until the new one has proven end-to-end delivery.

---

## 5. Slice 2 — Stop the review-proposal churn

Bleeding now, depends on nothing else, and second by the ruling.

**6a. Stop the churn.** The dispatcher supersedes every open
proposal and recreates it each minute. Add a semantic fingerprint over
(kind, task_id, task generation, agent/returned commit, reasons). If unchanged,
update `last_evaluated_at` — do not supersede or insert. Never regenerate while
a valid review lease is held. Existing valid proposals are retained, not
recreated.

**6b. Freeze unattended dispatch** until 6a lands. **Keep lease and outbox
reconciliation running** — freezing dispatch must not freeze recovery.

**6c. Review work stays dormant** until slice 4's reviewer consumer exists.
Silencing the proposals is containment, not the review seam closing.

---

## 6. Slice 3 — Execution seam

**Third by the ruling in §0, and gated on one real Loop B proof.**

```
current   agentbridge work → worker.mjs → workerDeps.startRun → verify → return
required  claim → start_attempt → guarded pipeline → isolated workspace
          → concurrent lease renewal → terminate on fence loss → evidence
          → publish reachable result → return
```

* one fenced attempt transport: `start_attempt`, `append_attempt_step`,
  `finish_attempt`. `finish_attempt` validates the task lease and fence **in the
  same transaction as the task return.** No direct REST writes from workers.
* **no `attempt_id`, no executor launch.** State the failure mode explicitly: a
  worker that proceeds when the row cannot be written has no gate; one that
  halts on an unreachable database is a new outage. Fail closed, loudly, and put
  the chosen behaviour in the contract.
* `runAttempt` goes INSIDE `agentbridge work`. Do not create a third loop. The
  outer worker keeps heartbeat, lease renewal and event polling around it.
* structural gate: **only `runAttempt` may import or invoke an execution
  engine.** It must fail if the worker loop, CLI or daemon launches a model
  directly.

**Sequencing caveat, which is the one place this roadmap disagrees with the
outside review:** Loop A is the only path that has ever executed work against
the real bridge; Loop B has run in tests and never in production. Removing the
`startRun` bypass before Loop B completes one real task end to end trades "runs
unguarded" for "does not run at all", on the strength of a path with no
production evidence. **Prove one real attempt through Loop B, then cut over,
then delete the bypass.** The destination is not in question; the order is.

---

## 7. Slice 4 — Durable inbox, listener, receipts

**Fourth by the ruling. Delivery works today; ACCOUNTABILITY is what this adds.**

### Tables

```
messages              message_id, thread_id, sender_agent_id, sender_session_id,
                      recipient_agent_id, recipient_session_id (nullable),
                      task_id, attempt_id, caused_by_message_id,
                      kind, body, priority, ack_required,
                      created_at, expires_at, idempotency_key, payload_fingerprint

message_recipients    message_id, recipient_agent_id, recipient_session_id,
                      delivery_state, delivered_at, read_at,
                      acknowledged_at, acted_at, failure_code

message_processing    consumer_id, message_id, processing_kind,
                      claimed_at, completed_at, outcome
                      UNIQUE (consumer_id, message_id, processing_kind)
```

The processing table is the durable replacement for Gas Town's in-memory
deduper, which its own comment admits disappears on restart.

### Lifecycle

```
queued → claimed → delivered → acknowledged
                 ↘ expired
                 ↘ dead-letter
```

### Required semantics

* unknown agent → refuse;
* retired agent → refuse unless explicitly archival;
* permanent agent offline → queue durably, do NOT refuse;
* exact dead session named → refuse or reroute to the owning permanent agent;
* terminated disposable worker → refuse;
* same idempotency key + same payload → return the ORIGINAL message;
* same key + different payload → conflict;
* **reading is not acknowledgement; acknowledgement is not task completion;**
* acting on a message writes a processing receipt;
* critical unacknowledged messages escalate;
* delivery failure is visible in a dead-letter view.

**This eliminates the current lie where inserting a row is reported as
successful communication.** Note the Bridge already refuses to claim delivery to
an offline agent — that honesty is the behaviour to keep and formalise, not
replace.

### Listener

```
transaction writes the authoritative row
→ emits a lightweight NOTIFY
→ agent wakes immediately
→ agent RE-READS the authoritative row
```

The notification is a doorbell. Postgres remains authority. A lost notification
is caught by periodic reconciliation. **No proposal or message is ever recreated
to serve as a wakeup.**

### Delivery at a safe boundary

Messages are injected at a turn boundary, never mid-tool-call. Priority, TTL,
FIFO within priority, bounded queue depth, atomic claim, and recovery of
notifications abandoned by a crashed drainer.

### Acceptance — both directions

* a message to an offline permanent agent is queued and later delivered;
* a message to an unknown agent is refused at send time;
* a stale session cannot acknowledge a new message;
* a duplicate send with the same key returns the original and creates no row;
* a crashed consumer's claimed message is recovered and redelivered;
* the sender can observe queued / delivered / acknowledged / expired;
* a message body is never executed — assert this structurally, not in prose.

---

## 8. Slice 4b — Review seam

The database already has `claim_review`, `renew_review_lease`, `submit_review`,
self-review refusal, review fencing, reviewed-commit comparison and fix-task
creation. **The machinery exists; the consumer does not.** Do not replace the
queue to fix a missing caller.

```
returned task
→ select an eligible reviewer distinct from returned_by
→ claim_review
→ isolated review workspace at returned_head_sha
→ deterministic checks + structured review
→ submit_review under the fence
→ accepted | runnable | fix_required
```

The dispatcher may auto-assign a reviewer. **It must never auto-accept the
work.** `fix_required` creates the distinct fix task that is already supported.

---

## 9. Slice 5 — Completion seam

The root of repeated builds: nothing can answer *has this exact work already
been completed and accepted, under this context and base commit?*

```
work_item → task → attempt → result sha → review → integration → completion
```

**Work fingerprint**, over normalised machine inputs only:

```
hash(repo_id + target_branch + normalized_requirement
     + acceptance_contract + allowed_paths + relevant_dependency_versions)
```

Never include timestamps, session ids, generated wording or proposal ids.

**Partial unique index**, which is the pg-boss pattern doing the real work:

```sql
UNIQUE (repo_id, work_fingerprint)
WHERE state IN ('runnable','assigned','returned','reviewing')
```

A second request for the same work ATTACHES to the existing item. It does not
create another task or proposal.

**Four states, currently blurred into the single word "done":**

| state | means |
|---|---|
| implemented | an attempt produced machine-valid work |
| reviewed | an independent reviewer accepted it |
| integrated | the accepted sha is reachable from the target branch |
| completed | integration verified and the capability still holds |

Integration is verified by the daemon with
`git merge-base --is-ancestor <result_sha> <target-head>` — **ancestry checked,
never asserted by an agent.** A chat message saying "integrated" cannot change
completion state.

**Preflight, before any attempt launches:** resolve the canonical work item →
check for equivalent active work → check accepted attempts → verify the accepted
sha against target HEAD → run only if genuinely unfinished or invalidated.

`check-first` is the cheap stand-in for this and is a HEURISTIC OVER WORDING: it
matches a topic against branch names and commit subjects, so it misses two
agents describing the same work differently, which is the normal case. **When
the fingerprint exists, delete `check-first` rather than maintaining two answers
to one question.**

---

## 10. Slice 6 — Consolidation, last

Assign authority before deleting anything:

```
tasks                 desired work and workflow state
attempts              every execution
attempt_steps         durable execution stages
reviews               independent judgment
integrations          proof accepted work reached its target
messages/outbox       transport and audit
proposals             scheduling suggestions ONLY — and only where a human
                      decision is genuinely required
docs                  architecture, decisions and rationale — NOT state
```

Then: migrate useful history, stop writes to redundant stores, observe, and only
later remove. Six tables are currently empty look-alikes for live concepts
(`sessions`, `heartbeats`, `lanes`, `machines`, `nonces`, `rate_windows`);
`heartbeats` is the sharpest, because liveness actually lives in
`session_registrations` and the table named after the concept is unused.

**Also required and not yet written: a real baseline migration.** The current
migrations assume pre-existing hosted tables, so a fresh environment cannot be
rebuilt from this repository alone.

---

## 11. Order, in one block

```
1  identity + per-session credentials
2  stop review-proposal churn  (keep lease + outbox reconciliation running)
3  fenced attempt persistence: start/step/finish
   → complete ONE real Loop B task as the integration proof
   → then replace agentbridge work's raw execution path with runAttempt
   → attempt AND step rows required before this is called complete
4  durable inbox: receipts, acknowledgements, TTL, atomic claim, recovery
5  completion fingerprint: no equivalent active work created or assigned twice
6  consolidation and the baseline migration
```

Review work stays **dormant** after step 2 until an actual reviewer consumer
exists — stopping the churn must not be mistaken for the review seam being done.

Slices ship behind a compatibility layer. **Nothing working is removed until its
replacement has proven end-to-end delivery**, and no phase is complete without a
measured end-to-end proof.
