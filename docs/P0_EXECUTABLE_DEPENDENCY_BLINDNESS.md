# P0 — CLOSE EXECUTABLE DEPENDENCY BLINDNESS

**Status:** open. **Do not clear this yourself** — it changes the trust boundary
and needs independent review.

## The defect, found twice independently

Two blind clone audits, from different commits, reached the same structural
hole:

> `scripts/claude-stop-gate.mjs` **executes** `scripts/verify-run.mjs` by path,
> but the protection closure follows **import** edges. So a verdict-bearing
> executable sits outside the protected trust boundary.

The second auditor stated the consequence precisely:

> *"one Write makes the gate execute chosen code and read a forged
> VERIFY_PASSED at every turn end."*

It also explained why the existing gate structurally cannot see it:
`test/guardDependenciesProtected.test.mjs` derives its closure from imports,
and this dependency is a **spawn by path**. No amount of care with that test
would have caught it.

## Do NOT fix this by adding one path

Adding `scripts/verify-run.mjs` to `PROTECTED_PATHS` fixes today and not the
class. That is rule 8 — fix the matcher, not the string the prober tried — and
this repository has now lost to a roster-of-names three times in one day (the
npm flag matcher, twice; `isAuditBearing`'s name list, once).

## The invariant

> If a trusted control **A** can execute, load, read or delegate to **B**, and
> **B** can influence A's PASS / FAIL / ALLOW / REFUSE result, then **B
> inherits A's trust protection.**

Dependency kinds that must be modelled:

- static import
- dynamic import
- `execFile` / `spawn` of a child script
- shell-invoked script
- `package.json` script target
- hook or config target from `.claude/settings.json`, `.mcp.json`
- verifier or helper loaded by an explicit path

## Implementation contract

**One canonical trust dependency graph.** Every trust-bearing root explicitly
**declares** its non-import execution and config dependencies:

```js
{
  'scripts/claude-stop-gate.mjs': {
    executes: ['scripts/verify-run.mjs'],
    reads: ['.claude/settings.json'],
  },
}
```

Import and dynamic-import discovery may populate edges automatically.

**Scanning is a consistency checker, not the authority.** Static discovery of
spawn paths must not be the only source of truth: an execution dependency can
be built from a constant, a helper, a package script or config, and a regex
will lose that race indefinitely.

> discovered execution edge **not declared** → **FAIL CLOSED**

That gives declared authority *and* drift detection, without another
whack-a-mole matcher.

## Reproduction

`test/executableDependencies.test.mjs`, with a fixture:

- trusted gate **A** executes verifier **B** by path
- **B** is not imported by anything
- **B** is omitted from the root seeds
- mutate **B** to emit a forged PASS

Prove the old dependency model leaves **B** writable while **A** consumes the
forged verdict.

## Required proofs

1. **B** becomes protected *solely* because **A** depends on it.
2. Removing the declared execution edge makes the regression **RED**.
3. A newly discovered **undeclared** spawn edge makes the consistency check **RED**.
4. Static import protection still works.
5. Dynamic-import protection still works.
6. Hook and config executable targets are included.
7. Existing inherited baseline tests are **not weakened** — no baseline raised to fit.

## Scope sweep, before changing anything

Enumerate every trust-bearing executable or config dependency reachable from:

- `scripts/claude-stop-gate.mjs`
- the PreToolUse hooks
- the verifier / promotion path
- the audit terminal-write path
- the candidate submission path

**Report every currently executable-but-unprotected dependency before fixing
any of them.** The sweep is the deliverable; the patch is second.

---

# Queued follow-ups

## F1 — Audit workspace isolation

The **launcher**, not the reviewer shell, creates the environment. And it must
not be built from `{...process.env}` — start from a minimal allowlist
(`src/childEnv.mjs` already implements exactly this) and inject the audit home
explicitly:

- temp worktree
- temp `AGENTBRIDGE_HOME`
- minimal PATH / TEMP / locale
- no integration credentials
- no operator store path
- no parent Git overrides (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, …)

**Required proof, and it is stronger than "it wrote somewhere else":** place a
sentinel in the parent `AGENTBRIDGE_HOME`, run a complete audit, and hash or
list the parent store before and after — **byte-for-byte unchanged**.

Live evidence that this is needed: a reviewer reported *"the gate wrote this
audit worktree's verification record into the OPERATOR'S LIVE STORE, the
contamination CLAUDE.md warns about, which I could not prevent from inside the
rail."* Our own rail refuses env assignment, so an auditor cannot isolate
itself — the launcher must do it.

## F2 — P0-5 wording, tightened

A local `--by` is **metadata only**. It answers *what the process claims to
be*, never *who is authorised to record the verdict*.

The terminal write should ultimately bind, against a **server-verified reviewer
capability**:

`candidate_id`, `candidate_tree_sha`, `author_session/principal`,
`reviewer_session/principal`, `audit_job_id`, audit lease / fencing epoch,
`verdict`, finding refs, policy version.

**The server enforces reviewer ≠ author.** The client does not get to certify
that inequality about itself.

## F3 — Windows 8.3 normalisation

`realpathSync.native()` is the right normalisation step, but do **not** then
treat every `~` as safe. Normalise the workspace root **once, at creation**,
and use that canonical root throughout — so the security matcher never needs
platform-specific exceptions scattered across tools.

Live evidence: a reviewer's own `Read`/`Grep`/`Glob` refused its worktree's 8.3
path as *"a suspicious Windows path pattern"*, and it had to work entirely
through `cat`/`sed`/`grep`. The auditor's tools rejected the auditor's
checkout.

---

## Why this is a permanent rule

The blind audit mechanism has now justified its cost twice on this one defect
alone: **the same executable-dependency hole was found independently by two
reviewers, from different commits**, and it lives on an axis ordinary unit
tests were not modelling.

> **Trust closure follows influence, not merely imports.**
