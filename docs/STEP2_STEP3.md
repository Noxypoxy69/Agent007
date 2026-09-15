# What remains

## Step 2 — hooks (enforcement)

Step 1 makes a violation *visible*. Step 2 makes it *fail*.

A daemon cannot prevent a write. It heartbeats every few seconds and observes
what already happened — detect-and-report, not prevent. Prevention has to sit at
a chokepoint the agent must pass through:

- `pre-commit` — read `.lane`, diff staged paths against `lanes.yml`, reject
  out-of-lane paths. This is the one that stops the mixed-lane commit.
- `pre-push` — branch allowlist per lane. No pushing `main` from a worker lane.
- branch protection on `origin` — the backstop when hooks are bypassed with
  `--no-verify`, which is always possible locally.

`lanes.yml` is already the shared vocabulary: same file, same globs, same
matcher (`src/glob.mjs`) the bridge uses. Nothing new to design.

Worth building even if Steps 1 and 3 are abandoned. It is independent, small,
and the only part that actually prevents anything.

## Step 3 — dispatch

The unresolved question, which should be settled before any code:

**Headless.** The daemon spawns bounded `claude -p` / `codex exec` turns and
constructs each prompt. The loop genuinely closes. But the daemon stops being an
observer and becomes the agent runtime — it holds credentials, decides turn
boundaries, and every security property in `THREAT_MODEL.md` has to be rewritten
around an inbound command path that actually executes.

**Interactive.** Commands land in a queue; the agent picks them up at turn
boundaries via a slash command or a file the session reads. Much smaller
security change, but it is not autonomous — someone still starts each turn.

Do not build dispatch until Step 1 has run for a while and shown where the time
actually goes. If most collisions surface at push, GitHub already sees them and
the dispatch layer buys less than it appears to.

## Smaller things worth doing first

- ~~Redact secret-shaped substrings in published process command lines.~~ Done
  in 0.2.0: allowlist sanitiser, live test with a real token in real argv.
- ~~Windows machine-secret storage.~~ Done in 0.2.0: DPAPI seal, ACL check,
  daemon refuses to start when either fails. **Unverified on Windows** until
  `agentbridge doctor` is run there.
- Tests against a real Postgres for `bridge/store.mjs`.
- Per-agent scoping on reader tokens.
- A `handoff` command that emits the evidence block (branch, head, base, files
  changed, shared files, test results, foreign failures) from live state, so
  "done" is unsayable without it. All the inputs already exist in the snapshot;
  this is formatting, not new probing.
