# Agent Bridge — Canonical Master Build Map

**Authority:** Danny's 2026-09-17 measured repair order, merged with the complete
Agent Bridge Autonomous Runtime v1 specification and the reliability/self-correction
ingests.

**Purpose:** This is the parent implementation contract. `docs/ROADMAP.md` at
`6b43c94` remains the immediate repair sequence, but it is not the complete
definition of Agent Bridge. No narrower roadmap may silently remove a requirement
from this document.

**Verified baseline:** bundle `agentbridge-repo-6b43c94.bundle`, HEAD `6b43c94`,
complete non-shallow history, 1,600 tests / 1,585 pass / 0 fail / 15 skipped.

**Standing launch rule:** nothing in this map authorizes unattended production
workers or deployment. Each slice must first pass its positive, refusal, mutation,
crash and recovery proofs. The final release additionally requires the two-task
closed-UI slice and twelve-hour soak.

---

## 0. The product being built

Agent Bridge is a durable software-engineering control plane. Permanent agents
(`code-a`, `code-b`, `code-c`, `code-d`) may retain durable identities and use
terminal or desktop sessions. Execution capacity is nevertheless separate from
identity: a supervised daemon leases one attempt to one worker slot, launches a
disposable Claude, Codex or other engine process, records machine evidence, and
terminates or quarantines that process when the attempt ends.

The finished system must move real work through:

```text
goal / work item
  -> canonical task contract and dependency graph
  -> eligible atomic claim + task lease + resource claims
  -> durable attempt created before execution
  -> bounded disposable executor in isolated workspace
  -> guarded typed tools + progress/budget supervision
  -> machine-authored result envelope
  -> independent leased review
  -> accepted result integration
  -> ancestry/capability verification
  -> durable completion record
```

Every interactive ChatGPT, Claude and Codex window may be closed throughout the
vertical slice. Messages wake or coordinate; they are never execution authority.

### 0.1 Four identities that must never be collapsed

| Identifier | Example | Meaning |
|---|---|---|
| `agent_id` | `code-a` | Durable permanent or disposable actor identity |
| `session_id` | UUID | One terminal, desktop, CLI or spawned-worker runtime |
| `worker_slot_id` | `machine-01-slot-03` | Stable physical execution capacity |
| `role_profile` | `builder-v1` | Versioned permissions, tools, prompt and review constraints |

A permanent agent may hold multiple sessions and perform different role profiles.
A session may never authenticate through an alias or claim another session. A
disposable worker is an agent/session bound to one task and attempt and is terminated
afterward; its attempt record and artifacts remain.

### 0.2 Authority boundaries

| Component | Owns | Must never own |
|---|---|---|
| PostgreSQL | Tasks, attempts, leases, dependencies, events, decisions, claims, reviews, completion | Long-running model process |
| Scheduler | Eligibility, readiness, collision, dependency and atomic lease issuance | Agent reasoning or edits |
| Outbox/inbox | Durable wakeups, delivery and receipts | Task validity or lease authority |
| Worker daemon | Host lifecycle, capacity, renewal, child supervision, evidence upload | Acceptance or owner approval |
| Attempt Governor | Tool guards, budgets, progress, loop detection, context compilation | Task/review authority |
| Executor | Bounded reasoning, edits, tests and result proposal | Leasing, scheduling, self-approval |
| Reviewer | Independent evidence-based verdict | Candidate mutation |
| Reconciler | Missed notifications, expired leases, stuck states | Primary normal-path dispatch |
| Owner | Protected production, destructive and spending decisions | Routine worker prompts |

---

## 1. Binding implementation order

The first five steps are Danny's measured ruling. The remaining steps restore the
Launch Sprint requirements that the repair roadmap omitted.

```text
0   Freeze unsafe launch paths; retain lease/outbox reconciliation
1   Identity foundation and per-session credentials
2   Contain review-proposal churn
3   Fenced attempt persistence; prove Loop B once; integrate runAttempt
4   Durable inbox, receipts, acknowledgement and safe-boundary listener
4b  Independent reviewer consumer
5   Work fingerprint, integration and completion seam
6   Dependency, BLOCKED, approval and resource/capability authority
7   Supervised daemon and engine-adapter lifecycle
8   Attempt Governor, shared guard, typed tools and deterministic retry policy
9   Context/repair envelope, budgets, progress watchdog and artifacts
10  Risk-based isolation, network/secret/path hardening
11  Consolidation, baseline migration, compatibility and operations
12  Task A / Task B closed-UI vertical slice
13  Adversarial failure matrix and kill-at-every-boundary tests
14  Twelve-hour lights-out soak
15  Limited one-repo / one-machine / bounded-slot rollout
```

No later step may be used to postpone a security defect in an earlier step. No
step may create a parallel implementation of an existing authority path.

---

## 2. Existing code: keep, connect or consolidate

The repository contains valuable code. The primary failure is reachability and
authority wiring, not absence. The following is the starting inventory.

### 2.1 Execution and evidence

| Existing code | Keep for | Required action |
|---|---|---|
| `src/attemptPipeline.mjs` / `runAttempt` | Single guarded attempt seam | Put inside production worker after real Loop B proof |
| `src/attemptRecord.mjs` | Start/finish/crash rows and durable step kinds | Connect to fenced database writer |
| `src/resultEnvelope.mjs` | Versioned machine result and verdict | Make daemon-produced envelope authoritative |
| `src/evidenceCollector.mjs` | Test parsing and path violations | Expand to exact commands, exits, durations and hashes |
| `src/workspaceManager.mjs` | Fresh attempt workspace and quarantine | Retain; add certified container mode |
| `src/executorAdapter.mjs` | Harness-neutral executor contract | Expand to lifecycle adapter contract |
| `src/executorLocal.mjs` | First local executor | Keep behind adapter; never call directly outside `runAttempt` |
| `src/fingerprint.mjs` | Attempt/failure fingerprints | Keep; add distinct work fingerprint implementation |
| `src/loopDetector.mjs` | Attempt loop detection | Extend to state-aware action and repair fingerprints |
| `src/contextCompiler.mjs` | Bounded context compilation | Expand to immutable repair envelope inputs |
| `src/cas.mjs` | Content-addressed storage | Use for raw logs, artifacts and bounded retrieval |
| `src/toolOutput.mjs` | Compaction and typed output shell | Upgrade to stable versioned tool-result protocol |
| `src/tokenTelemetry.mjs`, `src/tokenBudget.mjs` | Token accounting | Integrate with hard budget governor |
| `src/worker.mjs`, `src/workerLoop.mjs` | Poll/renew/return outer loop | Retain around `runAttempt`; remove direct engine launch |
| `src/workerDeps.mjs` | Hosted effects and current process runner | Split daemon effects from executor; retire raw bypass |
| `bin/agentbridge-attempt.mjs` | Manual Loop B probe | Keep as diagnostic; never production authority |

### 2.2 Policy, permissions and safety

| Existing code | Keep for | Required action |
|---|---|---|
| `src/preExecutionGuard.mjs` | Deterministic command veto | Make shared mandatory dispatch for every consequential tool |
| `src/agentPermissions.mjs` | Role/scoped launch permissions | Bind to immutable role-profile snapshot |
| `src/ownerDecisions.mjs` | Append-only scoped owner policy | Include active decision IDs in attempt config |
| `src/permissionRequest.mjs` | Durable permission request model | Connect to task-local WAITING_APPROVAL lifecycle |
| `src/payloadGuard.mjs`, `src/redact.mjs` | Secret/machine leakage prevention | Apply to prompts, tool output, patches and artifacts |
| `src/collisionGuard.mjs` | Git/path collision evidence | Fold into resource-claim authority; do not keep as competing truth |
| `src/laneRegistry.mjs` | Capabilities, path ownership, worker resolution | Migrate static identity facts into canonical database model |
| `src/releaseRisk.mjs`, `src/deployGate.mjs` | Release/deploy safety | Bind protected actions to capability leases |
| `src/argv.mjs`, `src/exec.mjs` | Non-shell execution and prompt detection | Keep; all autonomous command execution passes guard first |
| `src/secretstore.mjs` | Local secret protection | Keep; daemon credentials never enter executor workspace |

### 2.3 Scheduling, leasing, review and completion

| Existing code | Keep for | Required action |
|---|---|---|
| `src/leases.mjs` | Pure lease decisions | Keep aligned with SQL claim/renew/return functions |
| `src/schedule.mjs` | Dependency and upstream-satisfaction logic | Make one shared readiness predicate for list and claim |
| `src/dispatch.mjs` | Proposal and staleness decisions | Stop recreation; proposals remain suggestions only |
| `src/reviewRunner.mjs` | Isolated independent review | Put behind reviewer daemon/consumer |
| `src/reviewDecision.mjs` | Accept/fix/reject and fix-task construction | Keep; review submission remains fenced |
| `src/reviewerPacket.mjs` | Prose-free evidence packet | Keep immutable and versioned |
| `src/workEvidence.mjs`, `src/priorWork.mjs` | Current heuristic discovery | Delete after canonical fingerprint/completion preflight proves replacement |
| `src/provenance.mjs`, `src/provenanceStore.mjs` | Historical delegation/attribution | Migrate useful history; stop as competing runtime authority |
| `src/integration` (missing) | Target-branch ancestry and capability proof | Add module and durable table/RPC |
| `src/completion` (missing) | Work-item preflight and invalidation | Add one canonical implementation |

### 2.4 Identity, communications and operations

| Existing code | Keep for | Required action |
|---|---|---|
| `src/coordination.mjs` | Canonical aliases, message validation, prose-only boundary | Replace hard-coded actors with database identity resolver |
| `src/events.mjs` | Doorbell event projection/cursor | Read durable inbox/outbox rows and receipts |
| `src/hostedRegistry.mjs` | Hosted HTTP transport | Replace shared credential with scoped session token |
| `src/registrationStore.mjs` | Local registration compatibility | Migration adapter only |
| `src/liveRegistry.mjs` | Liveness calculations | Use canonical sessions and three-clock health model |
| `src/daemon.mjs` | Existing daemon seed | Expand into supervised modular daemon |
| `src/runtime.mjs` | Existing runtime decisions | Reconcile with the one production state machine; no orphan duplicate |
| `bridge/**`, `mcp/**` | Local bridge/MCP surfaces | Compatibility clients, never alternative authority |
| `supabase/functions/mcp/index.ts` | Hosted route surface | Thin authenticated transport over RPCs |
| `supabase/functions/mcp/_shared.js` | Edge-safe pure logic splice | Generated/verified parity with source; no silent drift |

---

## 3. Canonical durable model

The baseline migration must create every foundational table. Incremental migrations
must not assume invisible production history.

### 3.1 Identity and capacity

```text
agents
  agent_id PK
  kind permanent | disposable
  display_name
  status active | retired | terminated
  parent_agent_id nullable
  created_at, retired_at

agent_aliases
  alias PK
  canonical_agent_id FK
  valid_from, valid_until
  historical_only boolean

machines
  machine_id PK
  label, platform, status
  credential/public-attestation metadata

worker_slots
  worker_slot_id PK
  machine_id FK
  slot_index, capabilities, status

sessions
  session_id PK
  agent_id FK
  worker_slot_id nullable
  client_kind terminal | desktop | cli | daemon | spawned_worker
  started_at, heartbeat_at, ended_at, revoked_at
  capacity, repo_id, worktree_id, head_sha
  credential_digest
  bound_task_id nullable, bound_attempt_id nullable
```

### 3.2 Work authority

```text
work_items
  work_item_id PK
  repo_id, target_branch, normalized_requirement
  acceptance_contract, allowed_paths, dependency_versions
  work_fingerprint
  state active | completed | invalidated | cancelled

tasks
  task_id PK, work_item_id FK
  generation, state, task_class, risk_class
  repo_id, base_sha, target_branch
  allowed_paths, forbidden_paths, shared_paths
  policy_revision, role_profile
  current_attempt_no, current_lease_id, current_fencing_token
  blocked_reason, blocking_resource, recheck_trigger

task_dependencies
  task_id, depends_on_task_id
  required_state accepted
  no cycles

resource_claims
  claim_id PK, resource_key, resource_kind
  task_id, attempt_id, lease_id, fencing_token
  acquired_at, expires_at, released_at
  one active incompatible claim per resource

capability_claims
  capability_claim_id PK
  capability merge | migration | deploy | release | external_message
  canonical_resource
  task_id, attempt_id, holder_agent_id
  fencing_token, expires_at, released_at
```

### 3.3 Attempts, events and artifacts

Retain the existing rich `attempts` and `attempt_steps` fields, adding only what
the parent specification requires and avoiding a second attempt table.

```text
attempts
  existing identity/config/verdict fields
  packet_hash, execution_mode, role_profile_revision
  engine_protocol_version, event_schema_version
  progress_event_at, budget_snapshot
  context_bundle_hash, policy_decision_ids

attempt_steps
  existing 12 durable step kinds
  add INSPECT, LOCALIZE, EDIT, REPAIR only if trajectory persistence uses
  this same journal; never create a shadow trajectory table

run_events
  event_id PK, attempt_id, sequence
  event_type, event_version, occurred_at
  payload, payload_hash
  UNIQUE(attempt_id, sequence), UNIQUE(event_id)

artifacts
  artifact_id/content_hash PK
  attempt_id, kind, size, media_type, storage_ref
  producing_step, created_at

result_envelopes
  attempt_id PK, schema_version
  machine-derived process/repository/test/artifact/policy outcome
  envelope_hash/signature
```

### 3.4 Review, integration and completion

```text
review_requests
  review_id PK, task_id, attempt_id, result_envelope_hash
  state queued | leased | accepted | fix_required | rejected | quarantined
  reviewer_agent_id, reviewer_session_id
  lease_id, fencing_token, expires_at

integrations
  integration_id PK, work_item_id, task_id, accepted_attempt_id
  result_sha, target_branch, target_head_sha
  ancestry_verified_at, capability_claim_id
  integration_state pending | verified | invalidated

completions
  work_item_id PK, work_fingerprint
  implemented_attempt_id, accepted_review_id, integration_id
  capability_verified_at, completed_at, invalidated_at
```

### 3.5 Communications and waits

```text
messages
message_recipients
message_processing
outbox_events
delivery_dead_letters
approval_requests
owner_decisions
```

Use the complete message fields from current ROADMAP Slice 4. Reading, delivery,
acknowledgement, processing and task completion remain separate facts.

### 3.6 Required partial uniqueness

```sql
UNIQUE (repo_id, work_fingerprint)
WHERE state IN ('runnable','assigned','returned','reviewing');

UNIQUE (resource_key)
WHERE released_at IS NULL;

UNIQUE (consumer_id, message_id, processing_kind);

UNIQUE (dedupe_key)
WHERE approval_state IN ('requested','waiting');
```

---

## 4. Minimum control-plane RPCs

Every state transition writes materialized state, append-only event and outbox
intent in one transaction. Workers receive no direct table-write authority.

```text
register_session                 bootstrap-only; returns one scoped secret once
heartbeat_session                credential-derived identity only
revoke_session

create_work_item                 computes canonical fingerprint
create_task                      validated contract, dependency-cycle check
claim_next_task                  shared readiness predicate + SKIP LOCKED
renew_lease                      current session + lease + fence
start_attempt                    durable row before executor launch
append_attempt_step              ordered/idempotent durable stage
append_run_events                ordered/idempotent telemetry
request_approval                 task-local durable wait, deduped
resolve_approval                 scoped owner decision
submit_result                    fenced attempt finish + task return atomically
expire_dead_leases

claim_review
renew_review_lease
submit_review
expire_dead_reviews

claim_capability
renew_capability
release_capability

record_integration              requires protected capability where applicable
verify_integration              machine ancestry/capability proof
complete_work_item              requires accepted review + verified integration
invalidate_completion

send_message                    sender derived from credential
claim_messages
mark_delivered
acknowledge_message
record_message_processing
expire_messages

drain_outbox
reconcile                       leases, reviews, outbox, waits, stuck progress
get_run_timeline
cancel_task
```

Late or duplicate requests return the already-recorded idempotent outcome when
identical. Same key with different payload is a conflict. Unknown schema or tool
codes fail closed.

---

## 5. Ordered implementation slices

### Slice 0 — containment and baseline capture

1. Disable unattended dispatch/autoconfirm without disabling lease/outbox reaping.
2. Snapshot live schema, Edge version, cron jobs and rollback point.
3. Prove kill switch, queue pause and worker drain commands in nonproduction.
4. Run the required 2–3 hour OpenHands lifecycle/sandbox/persistence spike.
5. Record exact reuse or rejection evidence before writing additional runner code.

**Exit:** rollback captured; no proposal bleed; reconciliation still runs; reuse
decision is durable.

### Slice 1 — identity and scoped credentials

Implement the tables in §3.1, session-token mint/verify/revoke, credential-derived
route identity and compatibility views. Backfill permanent agents and historical
aliases. Keep aliases read-only and non-authenticating. Bind disposable credentials
to one task/attempt.

**Positive:** valid token resolves one agent/session; permanent agent may have two
independent sessions.

**Refusal:** body impersonation, alias authentication, revoked token, wrong task-bound
disposable token and stale session all fail.

### Slice 2 — review-churn containment

Add semantic proposal fingerprint, partial uniqueness and `last_evaluated_at`.
Retain unchanged valid proposals. Never regenerate while a valid review lease exists.
Keep review work dormant until Slice 4b.

**Positive:** changed task generation produces a new proposal.

**Refusal:** identical minute ticks create no new row and supersede nothing.

### Slice 3 — fenced attempt persistence and production cutover

1. Add `start_attempt`, `append_attempt_step`, `submit_result`/`finish_attempt`.
2. Build hosted record adapter used by `runAttempt`.
3. Refuse executor launch if the start row is not durable.
4. Run one real task through Loop B while Loop A remains available as rollback.
5. Verify start, step, result envelope and terminal rows from the database.
6. Place `runAttempt` inside `agentbridge work`; keep outer heartbeat/event/renewal.
7. Remove raw `startRun` production bypass.
8. Add structural import gate: only `runAttempt` invokes an execution engine.

**Positive:** normal attempt records every stage and returns under current fence.

**Refusal:** unavailable DB, stale lease, expired fence, wrong session and missing
attempt ID prevent launch or return without reporting success.

### Slice 4 — durable inbox and accountability

Implement §3.5 message tables, credential-derived sender, canonical recipient,
idempotency conflicts, claim/delivery/ack/process receipts, priority/TTL/FIFO,
bounded depth, dead letters and orphan recovery. Add LISTEN/NOTIFY as a doorbell;
periodic reread remains correctness. Inject only at safe turn boundaries.

**Positive:** offline permanent agent receives queued message later; sender sees
delivery and acknowledgement.

**Refusal:** unknown/retired/terminated recipient, stale session acknowledgement,
payload mismatch on reused key and executable-message path all fail.

### Slice 4b — independent reviewer consumer

Create reviewer daemon/loop around existing `reviewRunner`. Select reviewer distinct
from implementer, lease review, use fresh read-only workspace at returned SHA,
consume only immutable evidence packet, renew concurrently, submit once under fence,
and quarantine crash/mutation. `fix_required` creates a distinct task.

**Positive:** accepted review advances; fix review creates scoped fix task.

**Refusal:** self-review, mutated workspace, stale token, missing envelope and reviewer
death cannot accept work.

### Slice 5 — completion seam

Add canonical work fingerprint, work item, integration and completion records.
Before proposal or execution: resolve equivalent active work, accepted attempts,
target-branch ancestry and capability validity. Attach to existing work instead of
duplicating it. Delete `check-first` after replacement proves both directions.

**Positive:** genuinely invalidated capability creates a new generation.

**Refusal:** equivalent active/completed work cannot create another task; agent prose
cannot assert integration.

### Slice 6 — dependencies, blocking, approvals and capabilities

Use one readiness predicate for listing and claiming. Add dependency-cycle rejection,
accepted-upstream unlock, satisfied-upstream invalidation, explicit BLOCKED reason /
resource / recheck trigger, task-local WAITING_APPROVAL, and resource/capability
leases for shared hazards.

**Positive:** accepting Task A atomically makes Task B eligible.

**Refusal:** unmet/cyclic dependency, collision, missing owner decision and stale
capability fence cannot execute.

### Slice 7 — supervised daemon and engine lifecycle

Decompose `src/daemon.mjs` into independently testable SessionManager, LeaseManager,
WorkspaceManager, ExecutorManager and EvidenceCollector. Run under Windows Service
Control Manager or the simplest supervised boot/restart mechanism that passes proof.
Daemon owns renewal, cancellation and process-tree cleanup; model never does.

Expand ExecutorAdapter:

```text
start(attempt_config)
stream_events()
interrupt()
get_status()
collect_result()
destroy()
```

Implement adapters for the first proven engine and interface tests for Claude/Codex.

### Slice 8 — Attempt Governor and shared Guard

Add or finish:

```text
ActionFingerprinter
ToolSchemaNormalizer
LoopDetector
ContextCompiler
ScratchpadManager
ProgressWatchdog
BudgetGovernor
PreExecutionGuard dispatch
```

Every filesystem, Git, shell, test, network, database, deploy, credential, package
and process-control effect must pass one shared deterministic dispatch core. Add
`agentbridge guard install`, `guard doctor`, `guard run claude`, and `guard run codex`
only by reusing this core—not a second guard implementation.

Typed results use versioned `status`, stable `code`, retryability, state-before/after,
side-effect class, diagnostics, artifact reference and retry hint. Runtime maps codes
to retry/wait/replan/quarantine/terminal; the model does not.

### Slice 9 — repair context, budgets and progress

Create immutable AttemptConfig and repair envelope containing task contract, active
owner decisions, exact repository/workspace facts, current patch, machine failure,
rejected fingerprints, remaining budgets and bounded notebook. Never replay
uncontrolled accumulated chat.

Maintain separate authoritative machine journal and non-authoritative bounded agent
notebook. Enforce wall time, token, tool-call, cost, retry and output limits. Distinguish:

```text
daemon_heartbeat_at   service alive
lease_renewed_at      authority maintained
progress_event_at     attempt advancing
```

Fresh heartbeat plus stale progress is hung work, not health.

### Slice 10 — isolation and security hardening

Deterministically select worktree for trusted bounded work and ephemeral container
for installs, repository scripts, networked tests or untrusted code. Model cannot
downgrade. Enforce canonical real paths, symlink escape protection, default-deny
network, attempt-bound network grants, dropped privileges, resource limits, no daemon
credentials, secret scans before mutation/emission and fail-closed guard availability.

### Slice 11 — consolidation and operability

Write clean baseline schema and forward-repair/rollback tests. Assign one authority
for tasks, attempts, reviews, integrations, messages and proposals. Migrate useful
history, stop redundant writes, observe, then remove dead stores. Add protocol/event/
policy version negotiation, additive migration/drain policy, janitor/GC, dashboards
from authoritative tables, kill switch, pause, drain, revocation and rollback runbook.

---

## 6. The mandatory two-task vertical slice

“One real Loop B task” is only the Slice 3 cutover checkpoint. It is not system
completion.

### Task A

- independently executable, bounded, nonproduction repository change;
- real task, attempt, lease, fence, event, outbox and artifact records;
- disposable executor in isolated workspace;
- at least one deterministic guard decision and machine-run test;
- independent review and verified integration.

### Task B

- depends on accepted Task A;
- initially records BLOCKED with deterministic recheck trigger;
- unlocks only after A acceptance;
- uses a distinct role profile;
- exercises one durable owner approval or protected capability path;
- includes one review rejection and fresh corrected attempt;
- independently reviewed, integrated and completed.

### Closed-UI proof

All interactive chats close before work starts. The daemon must advance both tasks
to completed, rejected, blocked, quarantined or owner-gated durable outcomes. Nothing
may be waiting solely because a human failed to wake a chat, paste a prompt or press
a terminal permission key.

---

## 7. Required failure-injection matrix

Every row needs a real automated or supervised injection and machine-captured result.

| Injection | Required result |
|---|---|
| Two schedulers race | Exactly one active lease |
| 50 concurrent claims | No duplicate lease, lost task or unfenced mutation |
| Duplicate/tampered wakeup | Identical dedupes after reread; tampered rejected |
| Crash before publish | Reconciler republishes committed outbox |
| Crash before launch | Lease expires; fresh attempt |
| Lost acknowledgement after side effect | Stable idempotency prevents repetition |
| Zombie result | Fence rejects; evidence retained |
| Machine reboot | Orphan quarantined; fresh attempt from accepted base |
| Reviewer death | Review re-leased independently |
| Reviewer edits candidate | Mutation denied; review void/quarantined |
| Dependency acceptance | Blocked dependent becomes runnable |
| Resource/capability collision | Only fenced holder proceeds |
| Stale or satisfied base | Invalidate/replan; do not execute blindly |
| Duplicate approval request | One durable request |
| One task waiting approval | Other safe tasks continue |
| Path/symlink escape | Denied and quarantined on ambiguity |
| Network outside grant | Denied before egress |
| Secret in prompt/output/patch | Blocked or redacted; security event |
| Agent claims success, test fails | Envelope fails; `AGENT_FALSE_DONE` |
| Same ineffective repair twice | Attempt quarantined |
| Same action/same state three times | Third blocked; repeated incident quarantines |
| Same test after changed patch | Allowed legitimate retry |
| Alive lease, stale progress | Watchdog interrupts and fresh attempt starts |
| Daemon double-start on slot | One current executable session |
| Engine startup crash loop | Profile quarantined or policy-approved alternate |
| Guard unavailable | Tools fail closed and attempt pauses safely |
| Large tool failure | Bounded diagnostics plus retrievable artifact |
| Context overflow | Deterministic compaction preserves authority/failures |
| Scratchpad lies | Machine journal remains authoritative |
| Unknown tool result code | Incompatible protocol failure |
| Old daemon after protocol upgrade | Drains and receives no incompatible lease |
| Queue unavailable | Durable state remains; reconciler repairs delivery |
| Poison task | Bounded attempts then execution quarantine |

Mutation tests must prove the gate detects the real regression, and source-mechanism
assertions must strip comments so documentation cannot satisfy them.

---

## 8. Donor code and patterns: exact use

| Source | Import pattern | Boundary |
|---|---|---|
| Temporal | Durable event history, activity heartbeat/recovery concepts | Do not adopt workflow engine in v1 |
| DBOS | Durable step journal and workflow/external-operation IDs | PostgreSQL remains existing authority |
| Restate | Durable communication/waits and replay model | Do not create parallel state store |
| NATS JetStream | Ack, redelivery, in-progress and backpressure semantics | Wakeup transport only |
| pg-boss | Partial unique queue policies, retries/backoff, heartbeat, dead-letter, LISTEN/NOTIFY | Do not copy job schema/dashboard |
| Hatchet | Worker slots, concurrency, fair routing and rate limits | Preserve our identity/authority model |
| Trigger.dev | Immutable run-version/config snapshots | No second run store |
| LangGraph | Interrupt/checkpoint semantics | Resume only with certified checkpoint |
| MS Agent Framework | Explicit workflow loop; checkpoint/session separation | No framework authority |
| SWE-agent/SWE-ReX | Trajectory and clean retry boundaries | Persist in existing attempt journal |
| OpenHands | Lifecycle, sandbox and persistence candidates | Mandatory measured spike; reuse or reject with evidence |
| mini-SWE-agent | Small composable loop | No loss of deterministic guard |
| Agentless | Localization/repair stages | Add to same attempt steps if adopted |
| Self-Refine | Bounded feedback cycle | Machine evidence controls retry |
| Symphony/AlphaEvolve/RepairAgent | Orchestration/repair patterns | No uncontrolled recursive agents |
| Beads | Shared readiness predicate, CAS claim, idempotent reclaim, cycle checks | Never caller-asserted identity |
| Gas Town | Priority/TTL/FIFO, atomic notification claim, orphan recovery | No filesystem authority or in-memory deduper |
| CC Safety Net / Agent Guardrails / GuardRail / Magpie | Shared multi-harness pre-execution interception | Clean-room shared guard core |
| Ralph Review | Disposable independent reviewer/fixer | Reviewer never mutates candidate |
| Claude Context | Optional repository retrieval | Validate every result at exact SHA |
| Harness Engineering | Verification-gap measurement | Machine envelope is authority |
| MCP Agent Mail | **Excluded** | Licence prohibits OpenAI/Anthropic use or analysis |

Licences and exact donor commits remain recorded in `THIRD_PARTY_CODE.md`. Do not
copy code whose licence or provenance has not been cleared.

---

## 9. Deployment gates

Production deployment is prohibited until all are true:

1. Complete requirement-to-code crosswalk is green with no unexplained omission.
2. Two independent architecture/security reviewers approve or record resolved blockers.
3. Clean baseline and every migration pass apply, replay and rollback/forward-repair.
4. Task A/Task B closed-UI slice passes from durable evidence.
5. Full failure matrix passes.
6. `verification_gap = false_done_claims / total_done_claims = 0` for slice and soak.
7. Twelve-hour lights-out soak passes with injected failures and no manual wakeup.
8. No unresolved critical/high security finding.
9. Kill switch, queue pause, drain, session/lease revocation and rollback are tested.
10. Production credentials are absent from executor/reviewer workspaces except an
    explicitly protected task with scoped capability.
11. Initial rollout is one repository, one machine, bounded slots and nonproduction work.

### Rollback

Pause new leasing without deleting history; revoke sessions and renewals; drain or
recordedly cancel current tasks; stop consumers and daemon auto-start; forward-repair
or revert functions/migrations using the tested plan; return to assisted operation
with explicit status. Never reset or clean a user's primary worktree.

---

## 10. Definition of done

Agent Bridge Autonomous Runtime v1 is complete only when Danny can close every
Claude, Codex and ChatGPT coding window, initiate one approved project goal, and
return after the soak to durable completed, rejected, blocked, quarantined or
owner-gated outcomes—with full attempts, steps, events, evidence, reviews,
integrations, receipts and completion proofs.

No task may be waiting solely because a human failed to wake a chat, paste a prompt
or press a local permission key. No agent claim, message, proposal, branch name,
commit subject or document may substitute for machine-verified authority.

