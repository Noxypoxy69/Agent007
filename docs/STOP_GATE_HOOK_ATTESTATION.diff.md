# UNAPPLIED DIFF — wire hook attestation into the Stop gate

**Not applied, deliberately.** `scripts/claude-stop-gate.mjs` is the gate that
refuses this session, and an agent editing it is the self-authorization
paradox Danny ratified on 2026-09-20: the verifier must not be mutable by the
worker under evaluation. This is a diff for review, not a change.

The template and checker **are** built, committed and tested:

- `templates/hooks/post-commit` — the pinned authoritative hook
- `scripts/verify-hook-integrity.mjs` — standalone, exits 0 / non-zero
- both registered in `PROTECTED_PATHS` in `src/policy.mjs` and
  `src/guardSession.mjs`

Watched failing before being believed: clean → `hook ok` digest `84d98f46…`;
one comment line added → `E_HOOK_INTEGRITY_TAMPERED`; restored → same digest.

---

## The diff

Insert immediately after `root` is resolved (currently `:265`), **before** the
audit-coverage reporter. The draft that was circulated imported from
`../src/externalVerifier.mjs`, which does not exist in this tree — the real
module is `./verify-hook-integrity.mjs`, a sibling under `scripts/`.

```diff
--- a/scripts/claude-stop-gate.mjs
+++ b/scripts/claude-stop-gate.mjs
@@
 const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
 
+/*
+ * THE HOOK THAT ENQUEUES EVERY AUDIT MUST STILL BE THE ONE WE SHIPPED.
+ *
+ * `0fec418` refuses WRITES to `.git/` at the rail, which stops a guarded
+ * session changing the hook. It says nothing about a hook already on disk:
+ * dropped before the guard armed, written by an unguarded session, or
+ * installed by any process outside this harness. That file executes with
+ * full ambient authority on every commit. Refusing a write is prevention;
+ * this is detection, and one cannot do the other's job.
+ *
+ * PLACED BEFORE THE AUDIT REPORTER because a tampered hook can suppress the
+ * enqueue, so every downstream count would be computed from a queue an
+ * attacker controls.
+ */
+const hookStatus = verifyHookIntegrity();
+if (!hookStatus.ok) {
+  out(`[agentbridge:${hookStatus.code}] ${hookStatus.reason}. `
+    + 'Restore it from templates/hooks/post-commit, or remove it deliberately.');
+}
+
```

and at the imports (after `:32`):

```diff
 import { runGit } from '../src/safeGit.mjs';
+import { verifyHookIntegrity } from './verify-hook-integrity.mjs';
```

---

## Four things to decide before applying

**1. `out()` versus `process.exit(2)`.** The circulated draft used
`process.stderr.write` + `exit 2`. In this gate the established idiom is
`out()`, which emits the JSON decision and `process.exit(0)`s — an uncaught
non-zero exit with empty stdout is read by Claude Code as **non-blocking**,
which is the failure this file already has a header about. Use `out()`.

**2. `E_HOOK_MISSING` should probably NOT block.** The checker distinguishes
missing from tampered on purpose. A fresh clone has no hook installed and is
un-armed, not attacked; blocking there means a new checkout cannot end a turn
until somebody installs a hook, which is the rule 19 outage that gets the gate
switched off. Recommend: **block on TAMPERED and NOT_EXECUTABLE, report on
MISSING.** The diff above blocks on all of them — narrow it before applying.

**3. It adds one `git rev-parse` and two file reads per turn.** Measured cost
is negligible against a ~400s budget, but it is on the path of every turn, so
it must never throw. `verifyHookIntegrity` returns a result object and does
not throw; the gate has no try/catch and an uncaught error there **disarms the
whole gate silently**.

**4. This is an import edge, so the existing closure covers it** —
`guardDependenciesProtected` will see `verify-hook-integrity.mjs` once the gate
imports it, which is why it is a sibling import rather than a spawn. That is
the lesson from `11e1615`: a spawn by filename is invisible to both
`noOrphanModules` and the closure gate.

---

## Known limitation, stated rather than discovered later

Only `post-commit` is attested. `pre-commit`, `pre-push`, `commit-msg` and
`core.hooksPath` itself are not — and `0fec418` measured all of
`Write .git/hooks/pre-commit` and `Write .git/config` as previously allowed.
A complete attestation enumerates every hook git would run plus the
`core.hooksPath` setting; this covers the one hook this system actually
installs and depends on.
