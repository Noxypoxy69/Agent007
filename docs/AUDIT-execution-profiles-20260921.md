# Blind audit — execution profiles (b53c723 / c15cea6)

Independent auditor, own worktree, detached HEAD at `c15cea6`, `AGENTBRIDGE_HOME`
redirected to `mkdtemp` and the isolation **verified rather than assumed** (it
printed the temp override path and `live grant here? = null`, so the operator's
`paths:["*"]` grant was out of scope). Mutation testing ran in
`git clone --no-hardlinks` copies under the OS temp dir. Nothing pushed, merged,
deployed, or written to the operator's store.

Recorded here because the audit lived only in a subagent transcript in the OS
temp directory of a machine being retired the same night. 215k tokens, 27
minutes, 70 tool calls.

## Verdict

**The design is defensible. The anchor is not, and the change should not merge
as it stands.**

The auditor's own summary: "MANUAL_TRUSTED is reachable from a contained session
in one permitted Bash call plus a compaction — which is a *lower* bar than the
wildcard grant this replaces, because that grant at least required Danny to type
a file with his name in it."

That is the finding that matters. The change was written to remove a standing
wildcard grant, and as measured it is a **net regression** against the thing it
replaces.

## Auditor's baseline, measured by the auditor

| revision | tests | fail |
|---|---|---|
| `a71990e` (parent) | 3059 | 1 — `THE SCOPE ACTUALLY MOVES WITH --since`, a property of that revision (a pure revert), not the machine |
| `c15cea6` (audited) | 3094 | 13 |

No environment-only failures found.

## Already closed at `f0561ab`, after the audited commit

The auditor was pointed at `c15cea6`; `cc74a23` and `f0561ab` landed afterwards.
Both re-measured at HEAD by the author.

- **D1 CRITICAL — `evaluateClaudeTool` threw on any non-git cwd**, taking the
  whole override-grant channel to 10/10 crashing and denying every write in
  production. Fixed in `cc74a23`; `test/guardOverride.test.mjs` is 10/10 green
  and `npm run verify` is `VERIFY_PASSED`, 3094 tests, 0 failures.
- **D7 — 12 new suite failures** (guardOverride ×10, deadExports 80→81,
  entryPointsComplete). All closed by `cc74a23` + `f0561ab`.

D1 was real and serious; it is listed as closed, not as disputed.

## OPEN — the anchor

**D2 CRITICAL — a contained session can promote itself.** `bindSessionProfile`
runs on *every* `--session-start`, and `.claude/settings.json` registers
SessionStart with `"matcher": ""`, which matches `startup`, `resume`, `clear`
**and `compact`**. The `wx` exclusive create only prevents a *re*-bind; a
contained session has no binding, so a later SessionStart binds it freely.
`scripts/attest-session.mjs` is tracked, unmodified, not in `PROTECTED_PATHS`,
and takes `--profile` from argv — so it runs through the shipped rail. Measured
sequence: `node scripts/attest-session.mjs --profile manual-trusted` → ALLOW,
then any compaction → `profile=manual-trusted` → `Write src/claudeGuard.mjs`
ALLOW.

This falsifies the commit message's central claim, "a session cannot mint one
because its SessionStart has been and gone".

**D3 CRITICAL — one ordinary write forges the binding, and the surviving
boundary is one write deep.** The binding file lives outside the repository, so
it is not protected; an AUTONOMOUS session may `Write` it directly. Worse,
`GATE_SELF_CONFIG` is only `.claude/settings.json` and `.claude/settings.local.json`,
while **`bin/agentbridge-claude-guard.mjs` — the binary settings.json invokes —
is writable under MANUAL_TRUSTED.** So "the gate configuration is still refused,
for every profile" is true of the pointer and false of the target.

The header's concession that a binding is "the same residual the override grant
already has" does not survive contact: a grant carries `granted_by`, a `reason`
and a **mandatory expiry bounded by `MAX_GRANT_MS`**; a binding is checked for
**no expiry at all** (`bound_at: "2020-01-01"` still resolves today), and its
permit announces "No override was spent" — which is exactly what a forger wants
the transcript to say.

**D4 HIGH — the lease check reads a column nothing ever writes.** Confirmed
independently by the author:

```
grep -arn "AGENTBRIDGE_TASK_LEASE" src bin scripts test bridge mcp agent.cmd
  src/sessionEvidence.mjs:241        <- the only read
  test/sessionPolicy.test.mjs:...    <- tests only
```

No producer: not `agent.cmd`, not the CLI, not the claim path, not MCP. So
"a live task lease outranks the attestation" describes a branch that cannot fire
in production, and `agent code-a` → claim a task → **still MANUAL_TRUSTED** with
the protected-path rail and shell allowlist off. This is hollow gate #3 from
CLAUDE.md verbatim — a guard reading a column nothing ever wrote — committed by
an author who cited `src/principalResolution.mjs`'s lease reasoning and then
implemented an environment variable.

**D5 HIGH — the pending attestation is first-come, with no claimant identity.**
Keyed only on the git common dir plus a 120 s window; nothing binds it to a
terminal, PID, worktree or agent id, and `pendingPath(worktree) === pendingPath(mainRepo)`.
Measured: an unrelated session starting first takes the attestation and becomes
MANUAL_TRUSTED, while the session Danny launched is contained — and told to look
in the wrong place.

**D6 HIGH — the baseline-test relaxation is wired but untested.** Deleting
`&& permits(profile, 'baselineTestsImmutable')` from `src/claudeGuard.mjs`
survives **the entire suite** — zero newly red. `test/sessionPolicy.test.mjs`
asserts the table value; nothing asserts the guard honours it. Rule 17 exactly,
in a commit whose own test file opens by quoting rule 17.

## OPEN — lower

- **D8 MEDIUM — prototype-chain profile names return `undefined`**, which reads
  as "the protection does not apply". `TABLE['__proto__']` is `Object.prototype`,
  truthy, so the `?? DEFAULT` fallback never fires; `permits('__proto__', …)` is
  `undefined` for all seven capabilities. Not reachable through
  `resolveSessionProfile` today (every return path is gated on
  `PROFILES.includes`), but `permits` is exported. The existing test uses
  `'something-nobody-defined'` — deliberately *not* on the prototype chain — so
  it never exercises the failure mode. Rule 7.
- **D9 MEDIUM — promotion gaps.** `gh pr merge --merge` is ALLOW and is not a
  spelling variant but a promotion channel `shellHardBoundary` does not model at
  all, while CLAUDE.md names merges to main as the owner's. With
  `shellAllowlistApplies:false` there is **no rail whatsoever** on destructive
  shell for MANUAL_TRUSTED (`rm -rf src`, `curl … -o x.sh` all ALLOW), a
  consequence the commit does not state.
- **D10 MEDIUM — REVIEW_ONLY is tool-level only and over-broad.** `npm test`
  (glob expanded by node), `npm install` (postinstall), `npm run`, and any
  committed `.mjs` are all ALLOW, so a reviewer can write anything through four
  permitted commands; rule 20's read-only worktree is enforced against the
  `Write` tool only. Separately the deny fires for paths *outside* the
  repository, so a wired reviewer could not write its own scratchpad.
- **D11 LOW — REVIEW_ONLY is unreachable in practice**; nothing writes the
  `.agentbridge-review` marker. Disclosed by the author in the commit message.

## Claims attacked and held

The gate-self check really is above the relaxation, and mutating it goes red on
the right assertion. Owner action authority is resolved above the profile and is
not relaxed. `src/shellAllowlist.mjs` is untouched — the 90b2924 freeze stands.
The unattested default is contained and load-bearing. An attestation does not
travel between sessions, checked at record level not filename. Session-id
traversal is closed, including under Windows case-insensitivity. The pending
attestation genuinely expires and is genuinely consumed. The exclusive create is
exclusive. The guard fails closed on a broken profile module. The disabled-test
check still fires for MANUAL_TRUSTED. **20 of 21 mutations were caught, each by
an assertion about the thing mutated** — names checked, not counts.

## Answer to "is AUTONOMOUS_TASK unchanged?"

**No.** The capability row is byte-identical and pinned, but the shared code path
changed: at `a71990e` a tool call with a non-git cwd returned a verdict; at
`c15cea6` it threw. The row test is a hollow gate for that claim. (Closed at
`f0561ab`, but the lesson stands: pinning the table did not pin the behaviour.)

## Lead, DERIVED not measured — labelled by the auditor

Read from `scripts/claude-stop-gate.mjs:698-741`, not executed: the Stop gate
does not import `sessionPolicy`, and its drift relief is
`granted || isCommittedWork(file)`. So a MANUAL_TRUSTED session that takes the
new PreToolUse permit and leaves the protected write **uncommitted** should be
blocked at Stop with no grant to spend — the "PreToolUse permits, the write
lands, Stop blocks the turn on the change it just authorised" sequence that
`claudeGuard.mjs` exists to prevent, arriving through a new door.

## What the auditor wants before this ships

An attestation the launcher can prove it owns (a nonce passed through, or the
launcher PID recorded and checked); a bind refused unless `source === "startup"`;
an expiry on the binding; a real producer for `holdsTaskLease`; and
`bin/agentbridge-claude-guard.mjs` plus `scripts/claude-stop-gate.mjs` moved into
`GATE_SELF_CONFIG` so the pointer and the target are protected alike.
