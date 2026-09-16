# Agent Bridge — Autonomous Loop, Bridge, Communications & Reliability OSS Ingest
## 2026-09-16 — implementation amendment for Desktop Code

This amendment is specifically for the **headless autonomous loop, Bridge control plane, worker communications, recovery, and reliability model**. It is not a UI spec.

It assumes today's situation map is authoritative: the loop has never closed; attempts are not persisted; reviewer runtime is absent; dispatcher confirmation still depends on the coordinator/chat path; identity/addressing is inconsistent; production can still be deployed from an unverified working tree; master and production are not the same revision; several green branches remain unmerged.

The goal is not to bolt on random features. It is to import the mature reliability architecture that existing OSS systems already learned the hard way, mapped onto Agent Bridge's current Postgres/lease/fence/task/event model without duplicating authority.

## Systems mined

Durable execution/workflow: `temporalio/temporal`, `dbos-inc/dbos-transact-*`, `restatedev/restate`, `hatchet-dev/hatchet`, `triggerdotdev/trigger.dev`, `PrefectHQ/prefect`, `argoproj/argo-workflows`.

Messaging/job delivery: NATS JetStream (`nats-io/nats-server` + clients/docs), `timgit/pg-boss`, `celery/celery`, RabbitMQ internals/docs.

Agent loops: `microsoft/agent-framework`, `microsoft/autogen`, `camel-ai/camel`, `langchain-ai/langgraph`, `All-Hands-AI/OpenHands`, `SWE-agent/SWE-agent`.

Use patterns and compatible licensed code only; preserve required notices and do not copy branding/proprietary cloud-only pieces.

---

## 1. The common mature architecture

```text
DURABLE HISTORY / STATE
        ↓
RUNNABLE WORK
        ↓
LEASE / DELIVERY
        ↓
WORKER EXECUTION
        ↓
HEARTBEAT / PROGRESS
        ↓
DURABLE RESULT OR CHECKPOINT
        ↓
VERIFICATION / REVIEW
        ↓
AUTHORITATIVE TRANSITION
        ↓
DEPENDENT WORK
```

On failure:

```text
RELOAD DURABLE STATE
→ reconstruct current authority
→ determine unfinished work
→ resume/retry from a known boundary
→ never trust dead-process memory
```

Bridge already has many of these primitives; the problem is that the whole loop does not yet obey them consistently.

---

## 2. Temporal — durable history, matching, heartbeats, deterministic recovery

### Whole-system lessons

Temporal splits control into a frontend/client API, History Service, Matching Service/task queues, and external workers. Workflow execution state is durably persisted as Event History; workers poll for tasks, execute outside the server, and report results. Failed workers do not own truth. Activity heartbeats report liveness/progress; heartbeat details can be used by retries to resume. Retry and cancellation are durable server-side concepts. Determinism/idempotency are correctness requirements.

### Bridge mapping

Do **not** add Temporal as a second authority.

```text
Bridge API / CLI / MCP          = Frontend
Postgres tasks/attempts/events  = History
scheduler + claim_task          = Matching
worker daemon                   = Worker process
executor adapter                = Activity runner
lease heartbeat/progress        = Activity heartbeat
ResultEnvelope + reviewer       = completion validation
```

Every authoritative transition should write state + event transactionally:

`TASK_BECAME_RUNNABLE`, `TASK_CLAIMED`, `ATTEMPT_CREATED`, `LEASE_RENEWED`, `EXECUTION_STARTED`, `PROGRESS_RECORDED`, `EXECUTION_FINISHED`, `RESULT_SUBMITTED`, `REVIEW_REQUESTED`, `REVIEW_CLAIMED`, `REVIEW_VERDICT`, `ATTEMPT_ACCEPTED`, `ATTEMPT_REJECTED`, `TASK_COMPLETED`, `DEPENDENT_UNLOCKED`, `TASK_QUARANTINED`, `OWNER_GATE_OPENED`, `OWNER_GATE_RESOLVED`.

If state changes without an authoritative event, flag an invariant violation.

Add durable progress checkpoints separate from process heartbeat:

```text
AttemptProgress
  attempt_id
  progress_seq
  progress_kind
  artifact_digest
  relevant_state_hash
  occurred_at
```

Examples: workspace created, context compiled, patch produced, verification started/completed, commit produced, result envelope built.

---

## 3. DBOS — Postgres-backed durable steps, queueing, exactly-once workflow IDs

DBOS is the closest conceptual match to Bridge's Postgres-first design. It checkpoints workflow steps in Postgres, resumes after process crashes, keeps workflow rows programmatically manageable, provides durable queues, dedupe, priorities, rate/concurrency controls, durable sleeps/notifications, and exactly-once event initiation through stable workflow IDs.

### Bridge import: durable attempt-step journal

Persist not just a final attempt row but bounded durable steps:

```text
attempt
  ↓
attempt_steps[]
```

Suggested kinds:
`CLAIM`, `PREPARE_WORKSPACE`, `COMPILE_CONTEXT`, `START_EXECUTOR`, `AGENT_RUN`, `COLLECT_RESULT`, `VERIFY`, `PUBLISH_ARTIFACTS`, `REQUEST_REVIEW`, `REVIEW`, `ACCEPT_OR_REJECT`, `CLEANUP`.

Each step records started/finished timestamps, status, input/output digests, error code, retryability, executor/runtime version, policy revision.

Recovery asks **which durable step actually finished?** Never infer recovery point from logs.

### Bridge import: external operation identity

Every consequential side effect gets a stable operation ID:

```text
operation_id = hash(
  task_id,
  attempt_id,
  step_id,
  normalized_action,
  target,
  relevant_state
)
```

Before retrying an uncertain side effect: look up operation record → reconcile target → reuse/complete if already applied → only then retry.

Parallel durable child operations require explicit stable child IDs; never checkpoint only by nondeterministic completion order.

---

## 4. Restate — durable communication and durable waits

Restate's strong idea is that execution progress and communication state are both durable. It provides reliable communication, durable promises/futures/timers, consistent state tied to progress, and suspend/resume semantics.

### Bridge import: classify communication

```text
COMMAND      asks an authoritative actor to attempt a state change
EVENT        immutable fact that already happened
NOTIFICATION advisory copy for humans/UI/observability
```

Examples:

`COMMAND`: `ASSIGN_TASK`, `CANCEL_ATTEMPT`, `REQUEST_REVIEW`, `DRAIN_WORKER`

`EVENT`: `TASK_CLAIMED`, `ATTEMPT_FAILED`, `REVIEW_ACCEPTED`

`NOTIFICATION`: worker offline, P0 finding.

A notification can never become authority.

### Bridge import: durable waits

Waiting for owner, reviewer, retry backoff, worker capacity, dependency, external rate-limit reset, etc. must be persisted as state. No process may have to stay alive simply to remember a wait/timer.

---

## 5. NATS JetStream — ack/redelivery/in-progress/backpressure semantics

Bridge does not need NATS as a new broker in v1, but JetStream's message semantics are mature and worth copying: durable consumers, explicit ack, ack timeout/redelivery, in-progress ack, negative ack, delayed redelivery, max delivery count, max pending/backpressure, pull consumers for controllable scale, durable consumer recovery, delivery advisories, and confirmation-oriented ack modes.

### Bridge command envelope

```text
message_id
message_type
sender_id
recipient_id
recipient_kind
created_at
expires_at?
correlation_id
causation_id
task_id?
attempt_id?
lease_id?
fence_token?
payload_digest
schema_version
delivery_count
state
```

### Recipient resolution before insert

Canonicalize identity first. Unknown recipient = reject. Known-but-offline recipient is separate state. Never silently create a mailbox because a string appeared.

### Delivery state

```text
PENDING → DELIVERED → ACKED → COMPLETED
```

or

```text
PENDING → DELIVERED → NACKED/TIMED_OUT → RETRY
```

Long work sends `IN_PROGRESS` through lease renewal/progress.

Bound delivery attempts; poison messages become `QUARANTINED` with failure fingerprint and redrive rules.

Add backpressure: max outstanding work per slot, per recipient, per provider, and per review pool.

---

## 6. pg-boss — Postgres queue discipline

Useful patterns: `SKIP LOCKED` claiming, created/active/retry/failed/expired/completed states, heartbeat/expiration, priority, singleton/exclusive/per-key ordering, dead-letter queues, redrive, warning thresholds.

### Bridge queue policy

```text
NORMAL
EXCLUSIVE_RESOURCE
SINGLETON_KEY
STRICT_FIFO_KEY
```

Examples: same repo/main integration = keyed serialization; deployment per environment = exclusive; read-only analysis = normal parallel.

Failed bounded work moves to durable quarantine/dead-letter state; redrive creates a **new attempt**, not fake continuation.

---

## 7. Hatchet — worker slots, fair routing, concurrency, rate limits

Hatchet combines durable tasks, retries, event triggers, label/weighted routing, DAGs, durable waits, priority, rate limiting, fair scheduling, worker slots, Postgres durability, and execution history/OTel.

### Bridge worker-slot model

```text
WorkerSlot
  worker_slot_id
  worker_id
  capabilities
  max_concurrency
  current_load
  labels
  runtime_version
  health
  draining
```

Route to eligible **slots**, not chat names. Then launch a disposable executor with a role profile.

Scheduler score should consider owner priority, critical path, age, project fairness, retry penalty, risk, resource claims, worker capability. Add aging so low-priority work does not starve.

Provider/API rate limits belong in scheduler policy, not scattered model-agent try/catch logic.

---

## 8. Trigger.dev — immutable run versioning

Useful patterns: long-running durable tasks, retries, queues, idempotency, checkpointing, human waitpoints, concurrency, run metadata, replay/cancel, and atomic versioning so running work does not silently change underneath itself.

### Bridge AttemptConfig must be immutable

```text
AttemptConfig
  bridge_runtime_version
  daemon_version
  executor_adapter_version
  role_profile_version
  policy_revision
  tool_schema_revision
  repo_base_sha
  environment_digest
  dependency_digest
  context_digest
```

New deployment/config applies to new attempts unless an explicit compatibility/migration contract says otherwise.

---

## 9. LangGraph — checkpoints, interrupts, resume safety

Useful rules: checkpoint graph state at step boundaries; persistent checkpointer for fault tolerance/HITL; interrupts pause safely; same thread identity is required for resume; code before an interrupt can rerun; non-idempotent side effects before interrupts create duplicate risk; retry policy is distinct from error handling; failure provenance is durable.

### Bridge owner/review gate model

Persist before waiting:

1. exact proposed action
2. durable gate state
3. release disposable process where possible
4. resume from gate record

Nothing before a gate may be an unreconciled non-idempotent side effect.

Classify errors:

`TRANSIENT_RETRYABLE`, `DETERMINISTIC_FAILURE`, `POLICY_DENIAL`, `OWNER_REQUIRED`, `STALE_AUTHORITY`, `RESOURCE_CONFLICT`, `VERIFICATION_FAILURE`, `AGENT_LOOP`, `INFRASTRUCTURE_FAILURE`.

Retry only classes explicitly allowed.

---

## 10. Microsoft Agent Framework — explicit workflow loop and checkpoint/session separation

Useful patterns: sequential/parallel/fan-out, explicit loops, checkpoint/resume, checkpoint+HITL, subworkflow checkpoints, tool-approval resume, cancellation, intermediate vs terminal outputs, durable checkpoint storage.

Critical distinction:

```text
Agent session/context != execution checkpoint
```

A model session can disappear; attempt state must survive.

Formal agent loop:

```text
CLAIM
→ PREPARE
→ EXECUTE TURN
→ COLLECT ACTION
→ GUARD
→ EXECUTE TOOL
→ RECORD OBSERVATION
→ PROGRESS CHECK
→ CONTINUE | SUBMIT | BLOCK | FAIL
```

Persist turn number, action fingerprint, tool outcome digest, progress delta, token/cost, loop detector state. Do not persist private chain-of-thought; persist actions, observations, machine evidence, summaries.

---

## 11. SWE-agent / coding-agent patterns — trajectories and clean retry boundaries

SWE-agent's loop is sandbox/runtime setup → tools → system/instance prompt → repeated LM action/environment observations → explicit submit → persisted trajectory. Retry approaches can hard-reset environments between attempts and score/select results.

### Bridge import

Persist machine-readable trajectory events:

```text
TrajectoryEvent
  seq
  type
  normalized_action_digest
  result_digest
  timestamp
  workspace_head
  relevant_file_hashes
  progress_marker
```

This becomes loop-detector, learning, incident, replay, and performance input.

Retry invariant: **new attempt, fresh workspace/container, exact accepted base.** Only promoted artifacts/evidence cross attempts.

---

## 12. Bridge communications architecture

### Canonical actor identity

```text
ActorIdentity
  actor_id          immutable
  actor_type        worker | coordinator | system | owner | reviewer-service
  display_name
  aliases[]
  lifecycle_state
```

`chatgpt-work`, `chatgpt-command-center`, etc. are aliases, not separate mailboxes. Never infer actor identity from branch/worktree/session.

### Correlation + causation

Every command/event carries `correlation_id` for the whole workflow and `causation_id` for the exact event/command that produced it.

### Transactional inbox/outbox

State change + outgoing command are written in the same DB transaction. Dispatcher delivers from outbox. Consumer records inbox receipt/idempotency before applying authority.

This closes:
- state changed but message lost,
- message delivered twice after crash,
- response applied twice.

### Command does not equal authority

Receiver always revalidates current task state, attempt, lease, fence, and policy revision before consequential action.

---

## 13. Reliability invariants

**R1** Every authoritative mutation has a durable state row + event.

**R2** Every consequential external side effect has a stable operation identity and reconciliation path.

**R3** Stale authority can never commit: attempt + lease + fence + expected revision checked at every result/review/deploy-finalization boundary.

**R4** Retryable work is idempotent or reconciled; otherwise it is not auto-retryable.

**R5** Retries are bounded by attempts/backoff/quarantine.

**R6** Timers/waits are durable.

**R7** Registration, process liveness, and task authority are separate facts.

**R8** Process heartbeat and useful-progress heartbeat are separate.

**R9** Production deploys only immutable verified commits/artifacts, never arbitrary worktrees.

**R10** Running attempts pin runtime/config versions.

**R11** Unknown recipient is a hard error.

**R12** Reviewer is independent authority; builder cannot self-accept.

**R13** Events carry revisions; duplicate/out-of-order notifications never override canonical DB state.

**R14** Cleanup uncertainty quarantines resources instead of reusing them.

**R15** Overload fails closed: scheduler stops dispatch before resource meltdown.

---

## 14. Failure Matrix — must become executable chaos tests

Rows:

```text
worker process dies
daemon dies
daemon restarts
machine reboots
DB connection lost
DB transaction outcome uncertain
edge/API 500
network partition
model API timeout
malformed tool call
tool hangs
tool exits nonzero
git conflict
git process dies after commit
disk full
worktree cleanup fails
provider rate limit
duplicate command
duplicate result
late result
stale lease
fence mismatch
lease expires during tool execution
worker alive but no progress
reviewer dies
malformed reviewer verdict
review accepted but response lost
owner approval recorded but response lost
deploy succeeds but caller times out
deploy artifact differs from verified artifact
SQL succeeds but response lost
schema migration partially fails
old daemon vs new schema
new daemon vs old schema
unknown message recipient
offline recipient
outbox written then dispatcher dies
dispatcher delivers then dies before mark-sent
inbox ack written then consumer dies
dependency unlock transaction crashes
poison deterministic failure repeats
clock jump
stale cache result
semantic cache false hit
janitor/reconciler dies
```

Columns:

```text
Failure
Detection
Canonical state after failure
Can retry?
Idempotency/reconciliation key
Backoff
Max attempts
Quarantine rule
Recovery actor
Machine evidence
Chaos test
```

---

## 15. Kill-at-every-boundary harness

For the base loop:

```text
claim
→ create attempt
→ create workspace
→ start executor
→ agent/tool actions
→ collect patch
→ verify
→ persist result
→ request review
→ reviewer claim
→ reviewer verdict
→ accept
→ unlock dependent
→ cleanup
```

Inject a process kill after **every arrow**, restart, and assert:
- exactly one canonical active attempt or none,
- stale attempt cannot advance,
- no duplicate external effect,
- no lost runnable task,
- no permanently stuck lease,
- review state recoverable,
- dependent unlock at most once,
- cleanup eventually completes/quarantines,
- durable history explains recovery.

---

## 16. Deployment gate — immediate because v19 proved the hole

```text
WORKTREE
→ COMMIT SHA
→ CLEAN CHECKOUT / IMMUTABLE BUILD INPUT
→ INSTALL
→ IMPORT/COMPILE
→ UNIT
→ INTEGRATION
→ MUTATION / CRITICAL GATES
→ PACKAGE / ARTIFACT DIGEST
→ PROMOTION RECORD
→ DEPLOY
→ READ-BACK / SMOKE
```

Rules:
- deploy command never accepts arbitrary worktree state,
- only promoted commit/artifact,
- production records exact artifact digest,
- failed smoke stops promotion,
- rollback points to prior promoted artifact,
- deploy itself is a fenced Bridge task.

---

## 17. Attempt persistence — immediate schema bottleneck

Minimum durable attempt:

```text
attempts
  attempt_id
  task_id
  attempt_no
  state
  worker_slot_id
  session_id
  role_profile
  engine
  model
  lease_id
  fence_token
  base_sha
  result_sha
  workspace_id
  runtime_version
  executor_version
  policy_revision
  tool_schema_revision
  context_digest
  environment_digest
  started_at
  last_progress_at
  finished_at
  result_envelope_digest
  verification_verdict
  review_verdict
  failure_code
  failure_fingerprint
  retry_of_attempt_id
```

Store separately:
- agent claimed success,
- machine verification verdict,
- reviewer verdict,
- final authoritative task state.

Never collapse these into one `status`.

---

## 18. Reviewer runtime

Reviewer is not a function inside the builder attempt.

```text
review_requests
  review_id
  task_id
  attempt_id
  evidence_packet_digest
  state
  required_profile
  lease_id
  fence_token
```

Flow:

```text
result submitted
→ immutable evidence packet
→ review request runnable
→ reviewer claims lease
→ fresh workspace/materialized artifacts
→ verdict + findings
→ fenced submit
→ ACCEPT | FIX_REQUIRED | REJECT
```

`FIX_REQUIRED` creates a separate fixer task/attempt. Reviewer crash → lease expiry → reclaim.

---

## 19. Remove chat from the critical path

If task is runnable, dependencies satisfied, policy permits, resource claims available, eligible slot exists, and no owner gate is required, scheduler/dispatcher assigns automatically.

Chat/UI may observe. They are not required for progress.

Only owner-protected transitions wait.

---

## 20. Identity/addressing migration

1. choose canonical actor IDs,
2. create alias table,
3. canonicalize before message insert,
4. reject unknown aliases,
5. distinguish offline from unknown,
6. preserve historical raw sender plus resolved actor where determinable,
7. never infer identity from branch/worktree/session,
8. registration maps actor ↔ worker ↔ slot explicitly.

Test: sending to unknown `code-b` must fail before insert rather than create a silent mailbox.

---

## 21. Backpressure/fleet safety

Add caps:

```text
max_runnable_claims_per_tick
max_active_attempts_per_worker
max_active_attempts_per_machine
max_active_reviews
max_active_provider_calls
max_retrying_tasks
max_outbox_backlog
max_unacked_commands_per_actor
```

On overload, pause lower-priority dispatch, emit health event, keep current work safe, and do not spawn more executors.

---

## 22. Reconciler

Periodic repair, not normal execution. Detect and idempotently repair:
- active task without valid lease,
- lease without attempt,
- active attempt on dead worker,
- finished executor without result,
- result without review request,
- accepted review without task advance,
- completed task with blocked dependents,
- old outbox item,
- delivered command with no ack,
- stale resource claim,
- orphan workspace/process,
- production artifact differing from deployment record.

Every repair emits an event.

---

## 23. Janitor / GC

Separate from reconciler. Clean expired sessions, stale worktrees, orphan containers/processes, superseded temp artifacts, expired caches, old inbox/outbox receipts per retention. Never delete required audit evidence. Unknown ownership → quarantine, not delete.

---

## 24. Version compatibility gate

Protocol/version fields on worker registration, command envelope, task contract, ResultEnvelope, review packet, policy bundle, runtime.

Worker declares minimum/maximum protocol, runtime version, executor versions, schema revision seen. Scheduler refuses incompatible assignment. Migrations declare old/new runtime compatibility or require drain.

---

## 25. Do NOT import these mistakes

Do not replace Postgres with NATS/RabbitMQ/Temporal in v1. Do not make agent chat the workflow engine. Do not add a second durable task DB. Do not make UI authoritative. Do not trust broker "exactly once" wording for external effects. Do not keep retry semantics only in prompts. Do not let workers own canonical task state. Do not add dynamic expert creation before the base loop is proven.

---

## 26. Implementation order from the current state

### Phase A — close the current loop
1. merge green recovery/support work after clean verification,
2. persist attempts,
3. wire lease → pipeline → durable result return,
4. implement reviewer runtime,
5. remove coordinator/chat confirmation from normal runnable path,
6. canonicalize identities / validate recipient,
7. hard deploy gate,
8. run T1 unattended,
9. prove T2 unlocks and closes unattended.

### Phase B — harden comms/recovery
10. durable command envelope + inbox/outbox ack states,
11. progress heartbeats,
12. bounded retries + poison quarantine,
13. reconciler,
14. janitor,
15. backpressure/rate limits,
16. version compatibility.

### Phase C — prove reliability
17. failure matrix,
18. kill-at-every-boundary harness,
19. machine reboot test,
20. DB interruption test,
21. lost-response side-effect reconciliation tests,
22. stale lease/fence race tests,
23. 12-hour closed-UI chaos/soak.

Only after this: execution fabric, experts, learning, optimization, UI.

---

## 27. First exact acceptance test

Test repo with T1 → T2 dependency. No coding chats open.

Expected:

```text
T1 runnable
scheduler claims
attempt row exists
lease exists
daemon launches fresh executor
progress updates
executor produces commit
machine verifier passes
result persisted
review request created
reviewer claims
review accepted
T1 authoritative COMPLETE
T2 automatically RUNNABLE
T2 claimed
T2 attempt/review completes
all workspaces cleaned
all leases released
event history coherent
```

Then kill builder mid-run, reviewer mid-review, and daemon between accepted review and dependent unlock. Restart and prove convergence.

---

## 28. Definition of "the loop works"

Not "agent wrote code." Not "task got assigned." Not "success printed."

It works only when:
1. no chat window is required,
2. every attempt is durable,
3. worker crash is recoverable,
4. reviewer crash is recoverable,
5. stale worker cannot commit,
6. duplicate delivery cannot duplicate authority,
7. external effects reconcile safely,
8. poison work stops,
9. overload does not spawn chaos,
10. every authoritative transition is explainable from durable history,
11. production deploys only verified immutable artifacts,
12. T1 → T2 closes unattended under injected failures.

That is the base on which the expert workforce, cache fabric, learning system, performance engine, and console can safely sit.
