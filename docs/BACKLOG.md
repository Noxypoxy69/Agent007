# The map

Five subsystems have been specified in one morning, deliberately: the pile is for
momentum, and this file is the map that keeps it a backlog instead of noise.

Nothing here is scheduled by date. Each item carries an **entry condition** —
what has to be true before building it is anything other than writing code
against imagined inputs — and, more importantly, **what it must extend**.

## The rule that orders all of it

> The only irreversible thing is uncaptured data.

A scorer, a governor, a cache or a router written in a month can all work on a
trajectory recorded today. Nothing written in a month can work on an attempt
nobody wrote down. So for every subsystem below, the NOW slice is whatever
records; everything that *reads* the record waits.

And the second rule, from the owner's own bar: **improve the platform instead of
creating another subsystem.** Four of the five specs below name components that
already exist here under different names. Building them fresh would be the
new-table-that-shadows-an-existing-one failure, five times over.

## What already exists, and what each spec calls it

This table is the point of the document. A spec asking for `FileContentCache` is
asking for a module that is already written, tested, mutation-proven and sitting
in `src/` with one KNOWN entry against it.

| Specced as | Already exists | State |
| --- | --- | --- |
| `FileContentCache`, L1/L2 file cache | `src/readCache.mjs` | built, tested, **no consumer** |
| Block spill / artifact store / Headroom compression | `src/toolOutput.mjs` | built, used by the pipeline |
| `CacheTelemetry`, token accounting | `src/tokenTelemetry.mjs` | built, used by the pipeline |
| Anti-brevity-gaming comparator | `src/tokenBudget.mjs` | built, lexicographic: evidence cannot be traded for tokens |
| `CodeHealthGovernor` (dead files, unused exports, boundaries) | `src/moduleGraph.mjs` | built, splice-aware, has a reasoned KNOWN list |
| `CodeHealthEnvelope`'s sibling | `src/resultEnvelope.mjs` | built; evidence projection excludes prose |
| Computation fingerprint / action fingerprint | `src/fingerprint.mjs` | built, normalisation proven both directions |
| Loop / repeated-ineffective-repair detection | `src/loopDetector.mjs` | built, repeat **and** oscillation |
| `TrajectoryRecorder` hook point | `src/attemptPipeline.mjs` | built; one attempt end to end |
| `policy_revision`, `owner_decision_ids` cache keys | `src/ownerDecisions.mjs`, `src/provenance.mjs` | built, deployed via the splice |
| `SingleFlightRegistry` | `claim_task` + leases + fencing | **built and deployed** — see below |
| Affinity index / worker state | `src/liveRegistry.mjs`, `src/dispatch.mjs` | built, deployed via the splice |

**Singleflight is the clearest case.** "One agent computes, the others wait on
its result" is `SELECT … FOR UPDATE SKIP LOCKED` with a lease and a fencing
token, which this system already has in SQL and which is already the authority
for who may do a piece of work. A second singleflight registry in JS would be a
second answer to "who is doing this", which is the question leases exist to
answer. It extends `claim_task`; it does not sit beside it.

---

## 1. Learning / reward / memory

See `LEARNING_NOW.md` and `LEARNING_LATER.md` for the full split.

**NOW:** the trajectory record, raw signals as fields, the routing dimensions
(`engine`, `model_version`, `role_profile`, `repo`, `language`, `task_class`,
`risk_class`) because they are unrecoverable, hard disqualifiers as a boolean
gate rather than a reward term, output spilled by reference, a schema version.

**LATER, in entry-condition order:** scorer, experience store, distiller, replay
gate, promotion, retrieval, MemRL-style utility updates, learned routing,
fine-tuning last.

**The trap:** a composite reward over partly-absent signals is the hollow gate
wearing a new hat.

## 2. Code health / anti-bloat governor

**Entry condition for the gates:** a loop that has completed a task. Hard-failing
gates on a loop that has never closed once will stop the bootstrap.

**NOW:** record the metrics per attempt — `net_loc`, `files_added/removed`,
`dependencies_added/removed`, `unused_exports`, `circular_dependencies`,
`duplicate_blocks`, `complexity_delta`, `tests_delta`. Cheap, and impossible to
backfill.

**Must extend:** `moduleGraph.mjs` (dead files, unused exports, reachability,
boundaries) and `resultEnvelope.mjs` (the `CodeHealthEnvelope` sits beside the
result envelope and is built the same way — machine fields only).

**Two rules from the spec that are already load-bearing here:**

*"Never delete based on static analysis alone when framework/runtime entry points
are ambiguous."* This is not hypothetical: the orphan gate reported three
DEPLOYED modules as dead because a hand-maintained splice into the edge function
is a copy, not an import. That is the exact failure the rule names.

*"Do not reward raw deletion."* Same shape as a disqualifier expressed as a
negative weight: agents optimise what is measured, and "less code" is trivially
gamed by deleting load-bearing structure.

**Unresolved:** `unused export/file after task → fail gate` would have blocked
this lane's own twelve modules, legitimately, while they awaited integration.
The KNOWN-with-a-reason mechanism is what makes that liveable, and any new gate
needs the same escape with the same "a sentence a later reader can disagree
with" requirement.

## 3. Cache + reuse layer

**Superseded by item 4.** The owner replaced it explicitly: *"give Desktop this,
not the tiny cache prompt from before."* Kept in the map only so nobody
implements it from an older message.

## 4. Content-addressed agent cache + affinity router

**Entry condition:** L0–L2 need only a running loop. L3 needs verified prior
work to retrieve. L5 needs control of the inference engine.

**Reachable now:** L0 process cache (parsed schemas, repo metadata, tool
definitions), L1 content-block cache by hash, L2 tool/result cache keyed on
state, L4 provider prefix alignment. L4 in particular is free money and needs no
loop — it is a property of how the prompt is assembled, which the executor
adapter already owns.

**Out of reach, and should be recorded as such rather than attempted:** L5 KV
cache requires owning the inference engine. Claude Code and Codex are invoked as
processes; their attention state is not ours to retain, prefetch or move. The
SGLang and LMCache patterns become available if and only if a self-hosted engine
is added, and not before.

**The dangerous level is L3.** Semantic similarity is not equality. Every other
level is content-addressed and can be proven correct by comparing hashes; L3
cannot, by construction. So it must never supply evidence or authority — only a
hypothesis that is then verified by the same machine checks any fresh attempt
would face. A semantic cache that can answer "has this already been fixed" is a
semantic cache that can be wrong about it confidently.

**An architectural tension worth stating before it bites.** Cache-affinity
routing prefers the worker whose context is already warm. Disposable executors
prefer a fresh worktree with no inherited state. These are compatible only if the
boundary is explicit: *context* may be warm, *workspace* may not. A router that
drifts into preferring a worker because its working tree is already set up has
quietly repealed the isolation guarantee, and it will look like a performance
win while it does it.

**Namespacing:** the vLLM salting concern is real but not yet ours — one tenant,
one project. It becomes required the moment a second customer's repository is
indexed, and that is the trigger to record, not a thing to build now.

## 5. Performance optimization engine

**Entry condition: everything above, plus real workloads.** Workload discovery,
N≥3 A/B runs and statistical comparison need a working loop, a benchmark harness
and traffic to profile. None exist. This is the furthest-out item in the plan.

**What to capture in the meantime:** nothing specific to it. Its inputs are the
trajectory records item 1 already defines.

**The rules worth keeping verbatim in spirit**, because they are all forms of the
same discipline this repository already enforces: do not optimise guessed
hotspots, do not trust one run, do not compare different source versions, do not
keep gains inside noise, do not keep local wins until end-to-end improves, record
failed experiments so they are not repeated, and re-profile when repeated
experiments fail because the bottleneck may have moved.

**The genuinely novel steal** is ISO-Bench's evaluation idea: reconstruct a
pre-fix baseline from a real performance commit, preserve the human fix, generate
a benchmark, let the system solve it, and compare. That is the only proposal in
five specs that measures whether the system is getting better rather than
asserting it.

---

## What is actually next

1. Land `work/recover-orphan-branches` and `work/support-modules`.
2. Wire the attempt pipeline into the worker so a leased task runs through it.
3. Record the trajectory and the code-health metrics from the first real attempt.
4. Nothing from items 2, 4 or 5 until one task has been through the loop.
