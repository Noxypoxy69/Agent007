# Expert workforce — the §25 mapping

Required before code, against master plus `work/support-modules`.

## The two findings that matter most

**1. The eligibility half is already built, as lane capabilities.**
`src/laneRegistry.mjs` holds a closed capability set — `merge_main`, `deploy`,
`apply_sql`, `push_shared`, `rewrite_history` — granted by a lane and inherited
through assignment. Its own comment states the model the spec is reaching for:
*"Code A may deploy is a fact about which lane Code A currently holds, and it
moves when the assignment moves."* The set is closed on purpose so a typo fails
validation rather than reading as a working permission in the file and a denial
at runtime.

That is `CapabilityManifest` plus the eligibility gate, with `capabilitiesFor`,
`resolveWorker`, `workerRoster`, `sessionsOfAgent`, `classifyPath` and
`ownersOfPath` already written and deployed through the splice. What is missing
is the *preference* half — observed performance — which is the spec's own
distinction: declared capability establishes eligibility, observed performance
establishes preference.

**2. `CoordinationProposal` is the proposal path that already exists.**
The spec says the planner proposes, the machine validates, and an invalid
proposal is rejected rather than best-effort executed. That is exactly
`proposeWork` → `canConfirm` → `confirm_proposal`, which is built, deployed and
was exercised for the first time today. Building a second orchestrator would be
a second answer to "who may do this work", which leases already answer.

---

## The matrix

| Proposed concept | Existing implementation | Verdict | Files | Authority risk | Source patterns | First test |
| --- | --- | --- | --- | --- | --- | --- |
| `CapabilityManifest`, eligibility | closed capability set, granted by lane, inherited by assignment | **EXTEND_EXISTING** | `laneRegistry.mjs` | Low | AgentMesh discovery | a capability typo fails validation, not silently grants |
| Worker slots, load, availability | `CAPACITIES`, `AVAILABLE_CAPACITIES`, `resolveWorker`, `workerRoster` | **EXTEND_EXISTING** | `laneRegistry.mjs`, `liveRegistry.mjs`, `registrationStore.mjs` | Low | AgentMesh load | a busy slot is not eligible |
| `CoordinationProposal`, planner proposes / machine validates | `proposeWork`, `canConfirm`, `confirm_proposal` | **EXTEND_EXISTING** | `dispatch.mjs`, deployed | **High** if a planner ever confirms its own proposal | Magentic-One orchestrator | an invalid proposal is refused, not partially run |
| `RecoveryPlanner` ladder | `retryDecision`, `invalidatedBy`, `escalation.mjs` | **EXTEND** | `runtime.mjs` (test-only), `escalation.mjs` | Medium | CAMEL recovery | the ladder is bounded per level |
| Task dependency / decomposition | task table, dependencies, `schedule.mjs` | **EXTEND_EXISTING** | `schedule.mjs` | Medium | CAMEL planner | SOP expansion makes ordinary tasks, no hidden engine |
| `HandoffPacket` | `reviewerPacket.mjs` — evidence-only, prose stripped, checked on every build | **EXTEND_EXISTING** | `reviewerPacket.mjs` | Medium | LangGraph typed handoff | default forwarding is bounded, never full history |
| Independence constraints | `canReview` exists but is test-only and SQL is authority | **EXTEND** | `runtime.mjs`, review-lease SQL | **High** | Ralph Review | builder profile may not review its own attempt |
| Owner gates, mandatory escalation | `ownerDecisions.mjs`, `escalation.mjs`, `permissionRequest.mjs` risk classes | **EXTEND_EXISTING** | those three | **High** | — | a mandatory gate cannot be skipped by capability claim |
| Guard / policy for mandatory-expert triggers | `permissionRequest.mjs` owner-only and elevated prefixes, `releaseRisk.mjs` | **EXTEND_EXISTING** | both | High | CC Safety Net | a security-triggering path adds the role deterministically |
| Event taxonomy (`EXPERT_*`) | `events.mjs` with `EVENT_KINDS` and a cursor | **EXTEND_EXISTING** | `events.mjs` | Low | MAF OTel | a new kind appears in the cursor stream |
| `TaskSignature` | **nothing** | **NEW** | — | Medium | CrewAI task contract | risk may rise automatically, never fall |
| `PerformanceLedger` / trust | **nothing** | **NEW, blocked** | — | **High** | AgentMesh, KARL | cold start does not over-rank one success |
| Circuit breaker, half-open | **nothing** | **NEW** | — | Medium | AgentMesh | half-open admits exactly one probe |
| `ExpertSOP` / playbooks | **nothing** | **NEW** | — | Medium | MetaGPT `Code = SOP(Team)` | SOP expands into ordinary tasks |
| Profile lifecycle, shadow/canary/promotion | `supersession.mjs` append-only correction | **EXTEND_EXISTING** | `supersession.mjs` | **High** | Agent Memory System | a profile is never edited, only superseded |
| `SkillPackage` | **nothing** | **DEFER** | — | Low | MAF Agent Skills | — |
| Dynamic expert creation | **nothing** | **DEFER** | — | **Highest** | CAMEL dynamic worker | a temporary profile expires and cannot self-promote |

---

## Blocked on the same table as everything else

`PerformanceLedger` keys on `profile_version, engine, model_version, role_class,
task_class, repo, language, risk_class` and measures accepted, rejected,
reviewer acceptance, first-pass success, false-done, retries, loops, cost.

**None of those fields is produced by anything today.** This is the fifth
specification to bottom out on the attempt record — after learning, the execution
fabric, the console, and false-done. Expert routing cannot rank profiles on
evidence that was never written down, so slices 4 through 6 are downstream of
item 4 on the order.

Slices 1 to 3 — declarative profiles, mandatory-role policy, typed handoff, SOP
expansion — are deterministic and need no performance history. Those are
buildable without the ledger.

## Authority risks specific to this amendment

1. **Eligibility before score, always.** The spec gets this right and it must
   survive implementation: capability, risk, tools, sandbox and independence
   decide *who may*; the score decides only *who is preferred among those*.
2. **A planner may never confirm its own proposal.** The existing separation —
   the dispatcher prepares, something else confirms — is the whole supervision
   model. An expert coordinator that both proposes and confirms has deleted it.
3. **A profile may be proposed but never self-promoted.** Same rule as a learned
   memory, for the same reason.
4. **Panel agreement is not proof.** Majority vote over four models that share a
   training distribution is four correlated guesses. The spec says this; the
   implementation has to enforce it by requiring machine evidence to adjudicate.
5. **Capability is not a substitute for independence.** A builder profile that
   advertises `can_security_review` does not thereby satisfy the security review.

## One item in the definition of done is currently false

DoD 13: *"Closing all chats does not stop the expert team from continuing."*

Today, confirmation is a coordinator, and the coordinator is a chat session. That
is the measured cause of 627 proposals and, until today, zero confirmations: when
the session is not looking, nothing confirms. code-c named this as the same
sentence from the architecture note, and declined to auto-confirm because the
owner ruled that the dispatcher prepares and the coordinator decides.

That ruling is unresolved, it is the owner's to change, and every other item in
this document assumes it is resolved. An expert workforce that stops when a
window closes is the thing this project exists to stop being.

## Position on the order

Slices 1–3: **item 11**, alongside learning, once the loop closes.
Slices 4–6: after item 4, because they read the ledger.
Nothing here precedes a task closing with nobody watching.
