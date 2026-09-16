# Deep-mining amendment: the matrix

Answer to section I of the amendment, against `work/support-modules` at `4200904`
plus the branches queued beside it. Read `BACKLOG.md` first for the ordering
argument; this document is the inventory that says what to build and what not to.

## The headline, before the tables

**Section A3 and section B1 are largely already implemented here, under other
names.** Not sketched — written, commented with the incident that produced them,
and in several cases deployed. Anyone implementing the amendment literally would
build second versions of:

| Amendment asks for | This repository already has |
| --- | --- |
| append-only evidence chain, correction by appending never editing | `src/supersession.mjs` — *"a wrong record is corrected by appending, never by editing"*, written after four contracts were marked withdrawn while their work was in master |
| raw/private evidence separated from portable memory | `src/payloadGuard.mjs` — *"nothing about the operator leaves the machine"* — plus `src/redact.mjs` for path classification |
| attestation / content-addressed evidence identity | `src/sign.mjs` (body hashing, version, skew bound), `src/provenanceStore.mjs` (delegation contracts, commit attribution) |
| wrapper-aware command normalisation, secret-path protection | `src/argv.mjs` — allowlist-based, *"argv is visible in the OS process table and people put tokens in it"* |
| owner-gate escalation with deduplication | `src/escalation.mjs` + `src/ownerDecisions.mjs` + the decision ledger |
| risk classification for routing | `src/releaseRisk.mjs` — pure rules over collected git state |
| capability / path ownership substrate for routing | `src/laneRegistry.mjs` (514 lines), `src/collisionGuard.mjs` |
| dependency/concurrency reporting without auto-resolution | `src/schedule.mjs` — *"it REPORTS AND REFUSES"*, restraint by design |

The philosophical correction in the amendment applies to this repository too:
the question is not "what feature do we copy", it is "what did they already
solve". Applied here, the answer is that the safety and provenance halves are
solved, and the learning and optimisation halves are not started.

---

## A. Learning / trajectory / reward

| Concept | Existing | Verdict | Borrow | Authority risk | Minimal first slice |
| --- | --- | --- | --- | --- | --- |
| Trajectory recorder | `attemptPipeline.mjs` has every value in one place at the end of `runAttempt` | **EXTEND** | Agent Lightning's capture boundary: the harness does not become the trainer | None if it only writes | Write one record per attempt, whatever the ending. Nothing reads it. |
| Canonical trajectory schema | none | **NEW** | KARL's normalised, versioned schema | None | Version field from row one; the reader arrives months later |
| Reward vectors, raw beside composite | `resultEnvelope` holds 11 of the 13 raw signals as machine fields | **EXTEND** | KARL: never let a composite erase dimensions | None | Record raw only. No composite until both outcomes exist in quantity |
| Correction detection (`NEXT_USER_CORRECTION`) | none | **NEW** | KARL's post-hoc annotation tap | Low | An episode must be annotatable after completion — "revert that" is a label |
| Memory lifecycle, supersession, revocation | `supersession.mjs` implements append-only correction already | **EXTEND_EXISTING** | Agent Memory System's promotion/validation attestations | **High** if a lesson can rewrite policy | Candidate → validated → promoted, with conflict **quarantined**, never last-write-wins |
| Loadouts naming exact memory revisions | none | **NEW** | Agent Memory System: a superseded revision makes a loadout stale, never silently substituted | Medium | Record which revisions were supplied to which attempt — a delivery receipt |
| Trust / routing profiles | `laneRegistry`, `liveRegistry`, `releaseRisk` give the dimensions | **EXTEND** | AgentMesh: capability-specific trust, EMA updates, circuit breaker, half-open probe | **High** | Shadow mode only. Trust never overrides lease, fence, policy or owner gate |
| Training export (SFT/RL) | none | **DEFER** | Apex, Agent Lightning dataset export | None if detachable | Interface only. No training code in the authoritative path |

**Incompatible as written:** nothing in A, provided training stays downstream and
detachable. The one hard line is that a learned memory may never rewrite active
policy; that requires the distinct approval path the amendment already names.

## B. Review / safety / policy

| Concept | Existing | Verdict | Borrow | Authority risk | Minimal first slice |
| --- | --- | --- | --- | --- | --- |
| Action-aware pre-execution guard | `argv.mjs`, `payloadGuard.mjs`, `redact.mjs`, `secretstore.mjs`, `permissionRequest.mjs` (risk classes, owner-only prefixes) | **EXTEND_EXISTING** | CC Safety Net's wrapper unwrapping and explain traces | **High** | Typed decision record: parsed action, matching rules, policy revision, verdict, explanation code |
| Fail-closed on broken guard | — | **NEW, and a deliberate divergence** | CC Safety Net fails **open**; Bridge must fail **closed** for guarded consequential actions | **Highest in the document** | A guard that cannot load must refuse, not permit. This inverts the borrowed behaviour on purpose |
| Additive rulebooks | — | **NEW** | CC Safety Net rule packs | High | Packs may only ADD restriction; they may never weaken a hard invariant |
| Reviewer runtime, separate worktree | SQL review leases exist; `reviewerPacket.mjs` builds the evidence-only packet | **EXTEND** | Ralph Review: disposable reviewer worktree, stable finding IDs, dedupe across iterations, early stop | **High** | Reviewer may not mutate code; fixer may not mark its own finding resolved |
| Finding inventory, fixer job | `fakeReviewer` returns coded findings | **EXTEND** | Ralph Review's persisted inventory and selected remediation | High | Stable finding IDs, fresh workspace per fix, independent re-review |

## C. Performance optimisation engine

Everything here is **DEFER**, and the entry condition is unchanged: a loop that
has closed once, plus real workloads. Nothing in this section is buildable
against imagined inputs.

The two ideas worth recording now because they change what earlier sections must
capture: workload identity and hardware/environment identity are part of
benchmark identity, and the failure ledger is as valuable as the success one. If
the trajectory schema cannot carry environment identity, this section becomes
unbuildable later without a migration.

**ISO-Bench is the exception worth planning for**, because it is the only
proposal in six specs that measures whether the system is improving rather than
asserting it: mine a real performance commit, take its parent as baseline, keep
the human fix as reference, generate the test, and compare baseline / human /
Bridge.

## D. Context, cache, token economy

| Concept | Existing | Verdict | Borrow | Authority risk | Minimal first slice |
| --- | --- | --- | --- | --- | --- |
| Reversible compact artifacts | `toolOutput.mjs` — head, tail, digest, ref, explicit `complete` flag | **EXTEND_EXISTING** | Headroom's reversible retrieval | None | Point the sink at a content-addressed store so a spill is retrievable |
| Unchanged-read dedupe | `readCache.mjs` — built, tested, **its only consumer is the context compiler that does not exist** | **EXISTING, unwired** | Headroom cross-agent dedupe | None | This is the first consumer to build in section D |
| Content-type routing (code/JSON/prose/logs) | none | **NEW** | Headroom's AST-aware code compression | None | Route by type before compressing; code is not prose |
| Cache-aligned stable prefix | none | **NEW** | Headroom `CacheAligner` | None | Free money and needs no loop: order the packet stable-first, volatile-last |
| Semantic work cache | none | **DEFER, with a hard rule** | GPTCache | **High** | May supply a hypothesis, never evidence. Never "this passed", "this is approved", "this lease is valid" |
| KV / prefill reuse | none | **INCOMPATIBLE for now** | LMCache, SGLang | — | We do not own Claude Code or Codex attention state. Interface only; do not fake the capability |

## E. Code health / anti-bloat

| Concept | Existing | Verdict | Borrow | Authority risk | Minimal first slice |
| --- | --- | --- | --- | --- | --- |
| Dead files, unused exports, reachability | `moduleGraph.mjs`, now splice-aware, with a reasoned KNOWN list | **EXTEND_EXISTING** | Fallow's typed findings and stable fingerprints | None | Add fingerprints so a finding is trackable across runs |
| Framework/entry-point awareness | the splice declaration solves exactly this class | **EXISTING** | Fallow: do not call something dead because generic import analysis missed a framework entry point | **High** — this already nearly deleted three deployed modules | Keep the declaration checked rather than merely declared |
| Baseline vs new regression | KNOWN list is the embryo | **EXTEND** | Fallow changed-code gating | None | Inherited debt quarantined, new regressions fail |
| Architecture boundaries | `laneRegistry`, `collisionGuard` | **EXTEND_EXISTING** | Fallow boundaries | Medium | Reuse lane ownership; do not invent a second boundary model |
| AI-slop detection | none | **NEW** | deslop-js taxonomy | None | Findings with confidence, never blind rewrites |
| One-change-at-a-time cleanup | none | **NEW** | CodeSpine: find, confirm blast radius, one edit, verify, keep or revert | Medium | Attribution stays clear only if one change is made at a time |
| Deterministic recipes | none | **DEFER** | OpenRewrite versioned recipes | Low | Prefer a proven recipe over an agent rediscovering a known migration |

---

## Authority risks, collected

These are the places where a borrowed pattern could quietly become a second
answer to a question the system already answers:

1. **Trust-based routing must never gate eligibility.** Leases, fences, policy
   and owner gates decide who may act. Trust decides only who is *preferred*
   among those already eligible.
2. **A learned memory may not rewrite active policy.** Rules and prompts need a
   distinct promotion path, or the system can teach itself out of its own guards.
3. **The guard must fail closed**, which is the opposite of the borrowed
   behaviour, and is the single highest-risk divergence in the amendment.
4. **The semantic cache may never supply evidence.** It is not content-addressed
   and cannot be proven correct by comparing hashes.
5. **No singleflight registry.** "One computes, the rest wait" is a lease over a
   row claimed with `SKIP LOCKED`, already deployed and already authoritative.
6. **Reviewer and fixer separation is structural, not scored.** A fixer that can
   mark its own finding resolved is self-approval with extra paperwork.

## Sequencing

Unchanged from `BACKLOG.md`, and the amendment agrees with it: recording and
evidence start immediately; learning, optimisation and training stay behind
non-authoritative interfaces until the autonomous core is proven.

The first slice across the whole amendment is one thing: **the trajectory record,
carrying environment and routing identity, written on every ending, read by
nothing.** Every other row above either already exists or waits on data that row
produces.
