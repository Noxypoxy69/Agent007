# Claude emergency guard — provenance and boundary

This guard is an immediate containment layer. It does **not** make Claude Code a
trusted promotion authority and it does not replace AgentBridge's planned
server-side state machine.

Existing tests are immutable inside the coding session. New test files may be
created, but after creation they are treated as existing tests. The Stop hook
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
