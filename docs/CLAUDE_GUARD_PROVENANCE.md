# Claude emergency guard — provenance and boundary

This guard is an immediate containment layer. It does **not** make Claude Code a
trusted promotion authority and it does not replace AgentBridge's planned
server-side state machine.

Tests present when the session BEGAN are immutable inside it. Tests the session
creates stay editable -- the shipped rule treated a file as existing the instant
it was written, so a typo in a test from sixty seconds ago could not be fixed,
and inverting a test that asserted a vulnerability was correct behaviour would
have been impossible. The boundary is the session snapshot, not `existsSync`. The Stop hook
runs the exact discovered `test/*.test.mjs` files without trusting
`package.json`, requires one complete TAP summary, requires a positive test
count and exact count reconciliation, and refuses out-of-band changes to its
control files. A repeated Stop callback remains subject to the same checks;
`stop_hook_active` is not an approval signal.

## Reused patterns

The implementation is original AgentBridge code informed by these MIT-licensed
donors, inspected at the pinned revisions below:

- `karanb192/claude-code-hooks` at
  `a7122bc702057f71b250fdd40ccbd6cebb8019e8`: protected test detection,
  protected configuration detection, and branch-aware git safety.
- `alexfazio/plankton` at
  `085d6727f0fd4b5d2c8b64b090d89b5c798f7b39`: protecting the rules that
  define quality checks and independently checking configuration at session
  completion.
- `jpicklyk/task-orchestrator` at
  `074130f913df7b8cdef51027ae8ca882c98ba518`: server-owned workflow state,
  actor attribution, and transition refusal. No Kotlin code was copied into
  this emergency hook.

Their copyright notices remain in `THIRD_PARTY_CODE.md`.

## Deliberate deviations

The donor Claude hooks return allow on malformed JSON or internal exceptions.
This guard denies malformed inputs. It also protects its own implementation,
its tests, the package test command, and the operative roadmap/order files.

## Code not used

`databricks-solutions/consort` was inspected at
`3c3af22c2d9ce7fb2d803e827a118cccb798e028`. Its deterministic state machine,
immutable-test lane, and independent navigator/driver roles are relevant
architecture. Its DB License restricts use to Databricks Services, so no
Consort source code was copied or adapted.

`0xHoneyJar/loa` was not copied because it is AGPL-3.0 and mounting the complete
framework would materially change AgentBridge's licensing and architecture.

## Hard boundary

Claude Code hooks have had real-world firing and subagent-bypass defects. This
hook supplies immediate feedback and blocks common self-dealing paths when it
runs; it is not the final trust boundary. Promotion must remain disabled until
an AgentBridge process outside the coding agent's writable worktree owns the
tests, policy, execution receipt, reviewer identity, and promotion decision.


## Repaired 2026-09-17, before installation, against demonstrated bypasses

The shipped guard was tested rather than read, on its own base, through the real
hook binary. Every one of these was ALLOWED and is now refused:

```
rm src/claudeGuard.mjs
cat > .claude/settings.json
printf "" > scripts/claude-stop-gate.mjs
printf "" > THIRD_PARTY_CODE.md
git restore src/claudeGuard.mjs
mv src/claudeGuard.mjs /tmp/x
```

**One line caused all of them.** `PROTECTED` entries are anchored `(?:^|\/) ... $`
because they describe PATHS, and the Bash branch applied them to a whole COMMAND
string, where `src` is preceded by a space. The regexes were correct for paths
and matched nothing in commands. Commands are now tokenised, quotes stripped and
each token resolved against the repository root before `isProtectedPath` decides,
so `rm "src/claudeGuard.mjs"`, `rm ./src/claudeGuard.mjs` and
`rm src/../src/claudeGuard.mjs` all resolve to the same refusal.

`scripts/claude-stop-gate.mjs` and `THIRD_PARTY_CODE.md` were absent from the
structured-tool list; `THIRD_PARTY_CODE.md` was listed as `docs/THIRD_PARTY_CODE.md`,
a path that does not exist, while the real file sits at the repository root.

**HEAD was the wrong baseline.** The Stop gate ran `git diff --name-only HEAD`,
which a commit hides: write the stop gate, `git commit -am wip`, and it approved
everything. It now compares file CONTENT against a snapshot taken before the
session and stored outside the worktree, and it refuses outright when that
snapshot is missing. This also detects writes that never reached PreToolUse --
an MCP repository write, a subagent, a wrapper script. Those are **not
prevented**, only detected afterwards, and that is the whole claim.

**Test discovery is recursive.** A flat `readdirSync('test')` runs a different
suite from the `test/**/*.test.mjs` glob the project declares, and would approve
a run that silently skipped every nested test.

Each defect was restored individually and the matching test watched go red.

## Second repair, 2026-09-17 — four decisive bypasses, all reproduced first

An independent review rejected the first repair. Every finding was verified
against the running code before anything changed, and every one held.

**The baseline reset.** `--session-start` overwrote the snapshot unconditionally,
so: damage a protected file, re-run it, and Stop approves the damaged state as
the new baseline. A baseline the measured thing can rewrite is not a baseline.
Snapshots now initialise ONCE and a second call refuses and says so.

**One snapshot for every concurrent session.** The key was the repository path
alone. Two agents in one worktree is this project's normal operating condition.
Keyed by repository AND Claude `session_id` now, taken from the hook payload.

**Baseline test hashes were collected and never compared.** A bypass could weaken
an inherited test; the Stop gate would then RUN the weakened test and pass it —
the suite grading itself against rules the session had just relaxed. Measured: a
weakened baseline test produced zero drift. Compared now.

**Two protected-path lists that disagreed.** PreToolUse covered
`docs/ROADMAP.md`, `docs/ORDER.md` and all of `.claude/**`; the Stop snapshot did
not. There is one definition now, in `guardSession.mjs`, and both layers import
it.

**And the one that ended the approach:** tokenising filenames cannot work,
because Bash is a programming language. All of these were allowed by the first
repair:

```
node -e "require('fs').unlinkSync('src/claudeGuard.mjs')"
python3 -c "open('scripts/claude-stop-gate.mjs','w').write('')"
eval "$COMMAND"
find src -name claudeGuard.mjs -delete
perl -e "unlink q(src/claudeGuard.mjs)"
```

An interpreter constructs paths at runtime, `eval` hides the command until it
runs, and `find -delete` never names the file. `src/shellAllowlist.mjs` inverts
the question: what is KNOWN read-only? Everything else is refused, including
`git commit` and `git push`, which belong after the Stop gate rather than inside
a coding turn.

### Two residual holes, named because they are real

`npm test` and `node --test` execute JavaScript from the repository, and a test
the session created is editable by design — so a new test file can call
`fs.unlinkSync`. `npm run` executes `package.json` scripts, protected from edits
but whatever they were at session start. **Neither is prevented.** Both are
detected at Stop by protected-file and baseline-test drift. Proven: a
session-created test emptied `src/claudeGuard.mjs` and Stop blocked.

That is the same posture as an MCP repository write — caught afterwards, not
blocked — and it is the honest boundary of a guard that lives inside the
checkout it guards.

### What is still NOT proven

The guard has never run as an actual Claude Code hook. Hooks DO fire in this
environment — a `PreToolUse` hook in a sibling project blocked a deliberately
triggered command — but that was a different project's hook. Two simultaneous
sessions have not been exercised. Until both are, "the logic refuses correctly
when invoked" is the claim, and "it gets invoked" is not.

## 2026-09-17 — the verdict: this is a rail, and the boundary is elsewhere

Two independent reviews converged, and this repository's own history is the
evidence. Three successive designs, each closing the reported instances, each
producing new ones within minutes:

| design | what walked past it |
|---|---|
| tokenise filenames | `node -e`, `python3 -c`, `eval`, `find -delete`, `perl -e` |
| approve binaries, subtract sub-commands | nine of ten known writers |
| exact command shapes | `sort -o package.json package.json`, plus five siblings found in a thirty-second audit |

`sort -o` is the one worth remembering: no metacharacter, an approved shape,
plain-looking arguments, and it rewrites the file in place. Nothing about it
looks like a write.

**That is not a list of bugs. It is what filtering a programming language looks
like from the inside.** The POSIX writer surface is open-ended and the agent runs
as the same OS user with the same permissions.

### The measurement that decided it

```
PreToolUse : ALLOWED  sort -o package.json package.json
filesystem : package.json rewritten in place
Stop gate  : BLOCKED  protected-control-changed: package.json: changed
```

The Stop gate caught it **knowing nothing about `sort` or about `-o`.** A check
that inspects the RESULT does not need to enumerate the ways of producing it.

### So the claims are now aligned with what each layer can do

- **`src/shellAllowlist.mjs` is a fast-feedback rail.** It catches the honest
  mistake early, while the agent can still act on it. It is not a security
  boundary and its header says so.
- **The Stop gate is the boundary — and a boundary has to SPEAK.** Content
  against a pre-session snapshot, which is indifferent to how the change
  arrived — shell, MCP write, subagent, or a test file the session wrote. Its
  one failure mode is silence. Claude Code cancels a hook that reaches its
  `timeout` and discards its output, and this gate blocks only by RENDERING a
  decision, so a run still thinking when the deadline passes renders none — and
  no decision from a Stop hook ends the turn approved. That state is reached by
  loading the machine, not by an exploit. `scripts/claude-stop-gate.mjs` now
  derives its budget from the timeout declared in `.claude/settings.json`,
  charges its own startup and hashing against it, and refuses on its own terms
  before the deadline. `test/stopGateDeadline.test.mjs` runs it against a
  stand-in killer and asserts it speaks first — and that a green suite inside
  the budget is still approved.
- **Real containment is neither.** It is an ephemeral container or a read-only
  mount where the agent works in scratch space and only a patch comes back.
  Nothing here substitutes for that.

### And the rail was made MORE permissive, on purpose

`node --test` and `npm test` are allowed again. They execute repository
JavaScript and can delete this guard. They are allowed because refusing them
makes iterative debugging impossible, and a rail that blocks ordinary work is
disabled by the first person in a hurry — losing the Stop gate along with it.

**An override incentive is a vulnerability.** A permissive rail plus a strict
boundary beats a strict rail nobody leaves switched on.
