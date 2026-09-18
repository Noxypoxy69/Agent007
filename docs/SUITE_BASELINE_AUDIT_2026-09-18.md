# Independent audit: suite baseline and failure attribution on `design/action-authority`

**Audited 2026-09-18** by a separate agent in its own worktree, shared tree read-only,
`AGENTBRIDGE_HOME` redirected to scratch (verified empty afterwards — the `6ab61a9` live
store leak did not recur). Eight full or partial runs across six commits.

Commissioned by `fixer`, who wrote the commits under audit and did not perform it.

**Process defect in how this audit was commissioned, recorded because it matters more
than the result:** the auditor was handed the seven failure names, the author's
attribution hypothesis, and the sentence "I believe it does NOT". CLAUDE.md rule 20's
second-lap section says to give the auditor nothing and let it derive its own findings
first; a list handed over up front buys a checklist walk. It caught the real mechanism
anyway (see D5) but that was the auditor, not the brief.

## Measured baseline, per commit

Command for any row:

    git checkout --detach <sha>
    node --test "test/**/*.test.mjs"      # AGENTBRIDGE_HOME=<scratch>

| commit | tests | pass | fail | skipped |
|---|---|---|---|---|
| `82f75f0` *(4 gate files only)* | 62 | 60 | 2 | 0 |
| `0c0bd0b` | 1789 | 1779 | **6** | 4 |
| `e87d097` | 1890 | 1878 | **8** | 4 |
| `af17d19` | 1890 | 1879 | **7** | 4 |
| `4ec5c89` | 1890 | 1879 | **7** | 4 |
| `a0ef1c2` | 1890 | 1879 | **7** | 4 |
| `c93aa10` (tip at audit) | 1890 | 1879 | **7** | 4 |
| `c93aa10` + all untracked files copied in | 1890 | 1879 | **7** | 4 |

`pass + fail + skipped == tests` reconciles at every run, so no test file silently failed
to load (rule 3 / hollow gate 9). The 4 skips are environment-declared and constant.

## Attribution — first commit at which each failure appears

| failure | first appears |
|---|---|
| both baselines are honest (`deadExports`) | ≤ `0c0bd0b` |
| THE REAL REPO HAS NO ORPHAN BEYOND THE KNOWN LIST | ≤ `0c0bd0b` |
| M4 identity includes executable-bit changes | `82f75f0`, the commit that added it |
| G shipped controller binary / verifier | `82f75f0`, the commit that added it |
| DEMAND: the guard does not consult actionAuthority | `e87d097` |
| PROVISIONAL: the test-only floor does not increase | `e87d097` |
| the over-block list may only SHRINK | `e87d097` |

Nothing unattributed. `e87d097` took the suite from 6 red to 8 red; its message reports
"Suite: 101 tests, 99 pass, 2 fail", which is **its five new files only**, reported as if
it were the suite of 1890.

**The three commits made during the session introduced nothing.** `af17d19` removed one
(8 → 7). `4ec5c89` and `a0ef1c2` are byte-identical in failure set and in gate internals
(`test-only 77`, `unreferenced 6` at both).

---

## Defects, ranked

### D1 — CRITICAL. The Stop gate refuses every turn on this branch.

`scripts/claude-stop-gate.mjs:323-328` blocks when `counts.fail !== 0`; `.claude/settings.json`
arms the hook. `fail = 7`, so every session on this branch is blocked at Stop, permanently.

**Five of the seven are never-green by construction.** `af17d19`'s own rationale
(`test/guardResetBypass.test.mjs:160-171`) states the mechanism correctly — *"a test
designed never to pass blocks every session on this branch, permanently"* — and was
applied to exactly one of the five. Its premise about Stop is true; its effect on Stop is
nil. Rule 15 inverted: a gate that moved rather than closed, in a suite where any single
red gate closes the whole door.

    git checkout --detach c93aa10
    node --test --test-reporter=tap "test/**/*.test.mjs"   # -> "# fail 7"
    sed -n '323,328p' scripts/claude-stop-gate.mjs

### D2 — HIGH. Two failures cannot pass on the operator's only machine.

- `test/step4a.test.mjs:107-112` — `chmodSync(..., 0o755)` then asserts the tree sha
  changed. Windows git does not track the executable bit; the run reports actual equal to
  expected. No input on this platform makes it pass.
- `test/step4aWiring.test.mjs:246` — `argv: ['/bin/sh','-c',…]` with POSIX `>` redirection.
  The run records `"outcome": "crashed"`, `"exit_code": null`, `"duration_ms": 3`; the
  executor never got a shell.

Both red since `82f75f0`, the commit that added them:

    git checkout --detach 82f75f0
    node --test test/step4a.test.mjs test/step4aWiring.test.mjs test/deadExports.test.mjs test/noOrphanModules.test.mjs
    # -> tests 62, pass 60, fail 2   (the two gate files were GREEN at that commit)

So **the Step 4A end-to-end wiring test — whose header calls it "the one test that drives
the real chain, and the only one that could have caught what it caught" — has never
passed on this machine.**

### D3 — MEDIUM. `e87d097` committed two tests that were red on arrival, one a one-line fix.

`test/guardToolRoster.test.mjs:247` still lists `SendUserFile` in `KNOWN_OVER_BLOCKED`,
described as "OVER-BLOCKS FOUND AT 61bbeb2". The guard was rewritten since to route on
input shape, and `SendUserFile` is no longer denied. The test correctly reports it:

    AssertionError: SendUserFile is no longer over-blocked — delete its entry
    rather than leaving a silencer

Fix is deleting the `'SendUserFile'` key. `e87d097`'s message names which two of its tests
are *hollow*; it does not say two were **red at commit time**, which is the fact the Stop
gate cares about.

### D4 — MEDIUM, latent. `scripts/` is PRODUCTION to the dead-export classifier.

`src/moduleGraph.mjs:618` — `const PROD = ['src','bin','bridge','mcp','scripts']`. That
corpus decides whether a `src/` export counts as `production-referenced`.

`scripts/probe-git-branch-matcher.mjs` is a one-shot probe whose own header says
"FALSIFIED" and "THIS IS NOT A TEST AND MUST NOT BECOME ONE". Its text is now part of the
production-mention corpus. It imports only `judgeShellCommand` and `tokenize`, both
already production-referenced, so **nothing was laundered — measured, 77/6 unchanged.**
But the next probe dropped in `scripts/` that merely *mentions* a `src/` export name will
flip that export to `production-referenced` and the ratchet will read as improving.
Hollow gate 2 with a new delivery route.

### D5 — MEDIUM. Both dead-code gates are blind outside `src/` by construction.

`classifyModules` (`moduleGraph.mjs:445`), `classifyExports` (`:640`) and `deadExports`
(`:691`) each hard-filter to `relPath.startsWith('src/')`. A module or export anywhere in
`bin/`, `bridge/`, `mcp/` or `scripts/` is invisible to the ratchet that exists to catch
dead exports — in both directions. The gate's own header claims `scripts` is production;
only half of that claim is implemented.

`scripts/probe-git-branch-matcher.mjs:65` exports `judgeGitBranch`, which nothing imports.
It is invisible to both gates for this reason, not by design.

### D6 — MEDIUM. Suite runtime is close to the Stop budget.

Measured `duration_ms`, same machine: 212s, 218s, 227s, 254s, 256s, 278s, and 350s under
concurrent load. The Stop hook budget is 420s and `claude-stop-gate.mjs:272-277` charges
its own preamble plus `OUTPUT_RESERVE_MS` against it. **A fully green suite could still be
refused as `stop-deadline`** — a second, independent reason Stop cannot currently be
relied on to say yes.

### D7 — LOW. An allowlisted command dirties a protected file that no allowlisted command can clean.

`npm install` is on the allowlist (`NPM_SHAPE`) and rewrites `package-lock.json`, which is
protected:

    $ git restore package-lock.json
    [agentbridge:shell-not-allowlisted] "git restore" names package-lock.json,
    which is a guard or completion control.

Rule 19's over-block shape, live.

### D8 — Observation, not a defect.

Creating a *new* nested path under `.claude/` is refused `[agentbridge:protected-control]`
even when the path does not exist. Documented PREFIX behaviour; recorded so the next
auditor does not spend the time rediscovering it.

---

## Claims checked and found TRUE

Listed separately so a reader can tell coverage from omission.

1. The failure count is **7**, reproduced independently in a clean worktree.
2. The seven names are exactly the seven that fail — no substitutions, no extras.
3. **Contamination changed nothing.** All three untracked root files copied in
   byte-for-byte; identical result. Mechanism: `walkDir` is only ever called on named
   subdirectories, so nothing walks the repo root.
4. `a0ef1c2` introduced no failure.
5. `scripts/probe-git-branch-matcher.mjs` affects no module-graph, orphan, dead-export or
   file-scanning test — see D5 for why.
6. `4ec5c89`'s `.gitignore` change affects no test. Measured A/B, and confirmed by
   inspecting every git call site under `test/`: all pass an explicit `cwd` into an
   `mkdtemp` fixture. The only `cwd: REPO_ROOT` is `test/guardToolRoster.test.mjs:51`,
   which shells out to nothing.
7. `af17d19` introduced no failure and removed one.
8. **The Stop gate's TAP parser matches the reporter it invokes** —
   `claude-stop-gate.mjs:280` passes `--test-reporter=tap` explicitly, so the
   `^# fail N$` parse is not being run against spec-reporter output. Not a hollow gate,
   and it fails closed anyway.
9. No test file silently failed to load at any commit (counts reconcile, all eight runs).
10. The 4 skips are environment-declared and constant across every commit.
11. The failures are deterministic across eight runs at six commits.
12. `AGENTBRIDGE_HOME` isolation held — scratch home empty after all runs.

---

## The one line for the owner

**Five of the seven are never-green by construction on this machine, the Stop gate refuses
on any non-zero fail count, and one commit this session addressed exactly one of the five
while citing that very fact as its reason.**

The audit produced evidence, not permission. Acting on it is the owner's call.
