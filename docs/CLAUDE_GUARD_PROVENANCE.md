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
