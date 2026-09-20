# Blind audit findings, 2026-09-20 — 22 escaped control commits

Two independent auditors, each in its own clone, each told what to attack and
**not** what the commits claimed (§7.2). Neither wrote any of the code. A third
batch was still running when this was written.

**These findings are recorded here because they existed only in one session's
context.** An audit that lives in a transcript is a log line, which is the same
defect the audit queue itself was built to fix.

---

## E1 — THE BIGGEST ONE. A guarded session cannot audit a clone at all.

**Both auditors hit this independently, and it invalidates obligations 1, 2 and
6 (reproduce / independently re-measure / mutate) for every commit below.**
Every route into the clone was refused by **our own rail** (`[agentbridge:`,
not the auto-mode classifier):

```
cd <clone>                  -> "cd" has no approved read-only shape
git -C <clone> log          -> "git -C" is not an approved read-only shape
Set-Location <clone>        -> "Set-Location" has no approved read-only shape
node --test <clone>/x.mjs   -> "not part of the repository this session inherited"
```

Cause: `src/shellAllowlist.mjs` `SHAPES` matches on `tokens[0]`/`tokens[1]`
only, so a global `-C` is unrecognised; `cd`/`Set-Location` are absent
entirely; and the node gate rejects any operand outside the inherited snapshot.

So **rule 20 mandates an auditor in its own clone and the rail forbids reaching
one.** Sixth documented instance of the same class in CLAUDE.md (the `git
clone` note, the registration recipe, the `VAR=$(cat)` recipe, the edge-deploy
recipe, `npm test`). An auditor suggested the fix belongs at the rail:
`git -C <dir> <read-only-subcommand>` and a `node --test` whose operand is
inherited *relative to its own repository root* are both judgeable from the
command string.

Both audits below are therefore **static analysis**. They still found seven
live fail-opens, which is the argument for fixing the access rather than
dropping the step.

**Owner decision (Danny).**

---

## Batch A — 7 commits on `src/auditJob.mjs`

| SHA | verdict |
|---|---|
| `dab3627` | FAIL — stated closure not wired |
| `6071798` | FAIL — "machine-enforced independence" bypassable three ways |
| `8e52c1f` | PASS (weak) |
| `fe25652` | FAIL — the root of trust is an env var |
| `94c4ed9` | FAIL — shipped with two red assertions in its own test file |
| `cba3c0d` | PASS (partial) |
| `d2df7f3` | PASS (incomplete) |

### A-D4 — HIGH. The "authoritative" author identity is an environment variable the author sets. **OPEN**
`bin/agentbridge.mjs` sets `identity_source: CREDENTIAL` from
`process.env.AGENTBRIDGE_PRINCIPAL_ID`, and the claimant side from
`AGENTBRIDGE_SESSION_ID ?? AGENTBRIDGE_AGENT_ID`. Nothing verifies a
credential. **An author produces a fully `enforced`, gate-satisfying
self-audit by setting two environment variables and choosing two different
strings.** The commit message says authorship is bound "from the active
authenticated session, which is a thing the author does not get to type." It
is a thing the author types.

Mitigation today is only that nobody has exported the variables — a property
of the machine, not the design. Correct fix: refuse to write `credential`
rather than trust `process.env`, so `enforced` is unreachable *by
construction*. **This is P0-5 and it is the real blocker.**

### A-D1 — HIGH. `mergeQueue` erases every field its consumers need. **OPEN**
`src/auditJob.mjs` rebuilds each job carrying exactly four fields. Dropped:
`independence`, `author_session`, `author_source`, `claimed_by_source`,
`satisfies_gate`, `verdict`, `recorded_by`, `recorded_at`, `finding_refs`,
`evidence_refs`. `bin/agentbridge.mjs` runs `mergeQueue` before every claim and
record, so **`audit-record` refuses every job** with "independence is unknown,
not enforced" — for a reason unrelated to independence. The P0-3 write path is
unreachable. No test covers it; the one preservation test asserts `state` only.

### A-D2 — HIGH. `agentbridge audit-record` is unreachable dead code. **OPEN**
`bin/agentbridge.mjs`: admitted by the outer dispatch (`cmd === 'audit-record'`)
then excluded by an inner `if (cmd === 'audits' || cmd === 'audit-claim')` that
encloses it. Same shape as hollow gate #6. One token to fix.

### A-D3 — HIGH. The Stop trigger still prints and never persists. **OPEN**
`scripts/claude-stop-gate.mjs` imports `auditJobsFor`/`formatAuditJobs` only —
not `mergeQueue`, not `claimJob` — and appends to the session's own notice.
Byte-identical to what `dab3627`'s message says was replaced. The queue is
written only when someone types `agentbridge audits`, and **nothing anywhere
tells them to** (zero references outside `bin/`). §7.1 requires the worker not
have to remember; as shipped it exists only when a worker remembers.

### A-D5 — HIGH. `94c4ed9` shipped with two failing assertions. DERIVED, not executed.
`claimJob` read the deleted `JOB.DONE`. Red at `94c4ed9`, still red at
`cba3c0d`, green at `d2df7f3`. Measure with three checkouts and read the
reported **count**; expect `fail 2`, `fail 1`, `fail 0`.

### A-D6 — MEDIUM. The same `Number(null) === 0` bug survives in `claimJob`. **OPEN**
`d2df7f3` fixed it in `recordAudit` and left the identical coercion ~130 lines
above: `claimed_at: null` → `Number(null) = 0` → finite → age enormous → **a
live claim is stolen.** `mergeQueue` explicitly preserves `claimed_at ?? null`,
so null is a shape the store carries by design. `d2df7f3` added no test.

### A-D7 — MEDIUM. `authorSessionFrom` takes the FIRST trailer. **OPEN**
`match` without `/g`. Three bypasses: omit the trailer (`author === null` →
presence guard short-circuits → no refusal); type any other `--by`; prepend a
decoy trailer. `8e52c1f` limits the damage by capping the trailer at `asserted`.

### A-D8 — MEDIUM. Claimant and author ids are drawn from different namespaces.
`AGENTBRIDGE_AGENT_ID` is `code-b`; `authorSession` is a `session_...` string.
`author === who` can never be true — a guard that cannot fire, recorded as the
stronger `claimed_by_source: 'resolved'`.

### A-D9 — MEDIUM. The "candidate must not have moved" fence compares the job to itself.
Nothing re-measures the tree at record time; both sides of both comparisons are
the same stored value. Catches a typo, not the attack its comment cites.

### A-D10..D14 — LOW
Read-modify-write claim with no lock in a feature built for concurrency;
`writeQueue` rewrites all N rows per call and grows unbounded; a corrupt queue
line is dropped silently and reads as "nothing due" with exit 0; `mergeQueue`
does not validate `state` against the enum; `recordAudit` idempotency ignores
`evidence_refs`.

### A-D15 — CONTEXT. **CLAUDE.md is wrong about the NUL-byte file count.**
`src/auditJob.mjs` and `test/auditJob.test.mjs` also contain literal NUL bytes
(correct — digest framing in `auditIdFor`). So `git show <sha>` prints
`Bin 16020 -> 20528 bytes` and **a reviewer handed only a SHA sees no code at
all** for the module under review. Use `git diff --text` and `grep -a`.

### No CLI-level test exists for any of the four commands
`grep` over `test/` for `audit-claim`, `audits`, `audit-record`,
`candidate-record` returns nothing. Every test calls pure functions directly,
**which is why A-D1, A-D2 and A-D9 are all invisible to a green suite.**
Rule 17, verbatim.

---

## Batch C — 8 commits, the single-flight verification chain

| SHA | verdict |
|---|---|
| `d6f4808` | PASS, 3 latent defects |
| `2c91953` | PASS — clean |
| `472aaf3` | PASS — clean |
| `aaa72de` | FAIL |
| `cec127c` | PASS |
| `0bef662` | FAIL (fail-open) — closed by `5debd0f` |
| `48e77ec` | FAIL (fail-open + regression) |
| `06f5dbc` | PASS with caveat |

### C-D4 — HIGH. The deadline cancelled nothing. **FIXED — `11e1615`, `c62b8f5`**
`Promise.race` cancels nothing; the gate printed its refusal, called
`process.exit(0)`, and left a full `node --test` per shard alive — unbounded
across turns, and an orphan holding `cwd` reinstates the Windows EPERM the
detached spawn was withdrawn for. **This was the `stopGateDeadline` teardown
failure observed this session and written off as a flake.**

### C-D-B — MEDIUM. `Number(null) === 0`, so a killed shard read as green. **FIXED — `11e1615`**
Node sets `code = null` on death by signal. A shard killed by the OOM killer
was not counted as failed, and any surviving shard with tests carried the run
to `VERIFY_PASSED`. A forged pass, produced by exactly the load that gets a
suite killed.

### C-D1 — HIGH. The gate's TAP verification was deleted, unannounced. **OPEN**
`aaa72de` removed `test-run-failed`, `tap-summary-invalid`, `tap-counts-refused`
and the reconciliation `pass+fail+cancelled+skipped+todo === tests`.
**`cancelled` is no longer examined anywhere.** The three tokens survive only
inside an explanatory comment, so a grep for the control matches its own
comment — rule 13.

### C-X1 — MEDIUM-HIGH. `treeDigest` degrades to 'absent' where it must fail closed. **OPEN**
A staged rename is porcelain `R  old -> new`; `rel` becomes the literal
`old -> new`, `readFileSync` throws, body records as `'absent'` — so **edits to
a renamed file do not change the key and a cached PASS is reused across an
edit.** Same for C-quoted paths with unusual bytes. Should return `null`.

### C-D8 — MEDIUM. No test file exists for `verifyIdentity.mjs`. **OPEN**
(`verifyRunner.mjs` now has one — `test/verifyRunnerCancellation.test.mjs`.)
`verifyIdentity.mjs` holds the tree digest the entire cache-safety argument
rests on, is a protected guard-closure member, and has **zero** coverage.

### C-D7 — MEDIUM. Two checkouts with identical content share a key. **OPEN**
`treeDigest` hashes content only, never the root path. The override-grant store
is keyed on the git-common-dir, so a PASS taken in worktree A can be reused in
worktree B **where a different grant is live** — which does change what the
guard tests observe.

### C-D-A / C-D-C — MEDIUM/LOW, latent. **OPEN**
`decideVerify`'s identity re-check is skipped when `key` is omitted (defaults
`null`) — the `nonEmpty(x) && ...x...` fail-open shape recorded in memory as my
recurring bug. `shardPlan`'s "more shards than files" refusal is skipped when
`files` is omitted. Neither reachable today; both untested in that direction.

### C-D5 / C-D6 — MEDIUM/LOW. **OPEN**
`admitVerification` is computed twice and never read — the approval is made by
an inline state check that does **not** re-verify the identity key, which is
the one thing `admitVerification` adds. Two adjacent comment blocks assert
opposite designs ("THIS GATE STARTS NOTHING" directly above "SO THIS GATE RUNS
IT").

### C-X2 — `src/guardSession.mjs` is a THIRD NUL-byte file.
So any repo-wide `git grep` audit of `PROTECTED_PATHS` has a blind spot on the
file that *defines* `PROTECTED_PATHS`. With batch A's finding, CLAUDE.md's
"two files" is now at least five.

---

## Recommended order (live items only)

1. **A-D4 / P0-5** — refuse to write `credential` unless a credential was
   actually resolved. Until then no audit can satisfy a gate honestly, and the
   env-var route means one could satisfy it dishonestly.
2. **A-D1, A-D2** — the audit-record path is inert; A-D2 is one token.
3. **C-D1, C-X1** — restore the TAP reconciliation or delete the stale comment;
   make `treeDigest` fail closed on an unreadable dirty path.
4. **A-D3** — wire the Stop trigger to persist, or delete the claim (rule 15:
   let the gate move rather than close).
5. **A-D6** — one line, and add the test `d2df7f3` did not.
6. **A CLI-level test** for `candidate-record → audits → audit-claim →
   audit-record`. One test catches A-D1, A-D2 and A-D9.
7. **E1** — owner decision on the rail.

## What is NOT cleared

Nothing here clears the 22 commits. Obligations 1, 2 and 6 were unperformable
(E1), and the fixes for C-D4 and C-D-B were written by the same session that
wrote the defects, so **they need a fresh auditor taking the new commits from
scratch**, told nothing about these findings — rule 20's second-lap ordering.
